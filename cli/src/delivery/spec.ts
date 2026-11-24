import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectArtboards } from '@/lib/i18n/project';
import type { ArtboardState } from '@/types/artboard';
import { DEVICE_FORMAT_PRESETS } from '@/lib/deviceRegistry';
import { resolveDeviceFormat } from '../formats.js';
import { usageError } from '../errors.js';
import { checkScreenshotCount, rulesetFor } from '../verify/rules.js';

export interface Screen { id: string; boardId: string; input: string; inputFormat: string; inputLocale: string; claim: string; sha256: string }
export interface Group { id: string; store: 'appstore' | 'play'; format: string; locale: string; projectLocale: string | null; project: string; projectSha256: string; screens: Screen[] }
export interface DeliveryPlan { version: 1; name: string; spec: string; specSha256: string; groups: Group[] }

export function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function fileHash(file: string): string { return sha256(fs.readFileSync(file)); }
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw usageError(`Missing ${label}.`);
  return value.trim();
}
function safe(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result)) throw usageError(`Invalid ${label}.`);
  return result;
}
function readRegular(file: string): Buffer {
  if (!fs.statSync(file).isFile()) throw usageError(`Not a file: ${file}`);
  return fs.readFileSync(file);
}
function containsImage(value: unknown, bytesHash: string, mediaData: Record<string, unknown>): boolean {
  if (typeof value === 'string') {
    if (value.startsWith('asset:')) {
      const data = mediaData[value.slice(6)];
      return typeof data === 'string' && imageHash(data) === bytesHash;
    }
    return imageHash(value) === bytesHash;
  }
  if (Array.isArray(value)) return value.some((entry) => containsImage(entry, bytesHash, mediaData));
  if (value && typeof value === 'object') return Object.values(value).some((entry) => containsImage(entry, bytesHash, mediaData));
  return false;
}
function imageHash(value: string): string | null {
  const data = value.startsWith('data:') ? value.match(/^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i)?.[1] : value.match(/^[a-z0-9+/=\s]{100,}$/i)?.[0];
  return data ? sha256(Buffer.from(data, 'base64')) : null;
}

/** Reads only. Relative paths in the spec belong to the spec's directory. */
export function readDeliveryPlan(specPath: string): DeliveryPlan {
  const spec = path.resolve(specPath);
  const raw = readRegular(spec);
  let data: any;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw usageError('The delivery spec is not valid JSON.'); }
  if (!data || data.version !== 1 || !Array.isArray(data.groups) || !data.groups.length) throw usageError('The delivery spec needs version 1 and at least one group.');
  const root = path.dirname(spec);
  const ids = new Set<string>();
  const destinations = new Set<string>();
  const groups: Group[] = data.groups.map((group: any) => {
    const id = safe(group?.id, 'group id');
    if (ids.has(id)) throw usageError(`Duplicate group: ${id}`);
    ids.add(id);
    if (group.store !== 'appstore' && group.store !== 'play') throw usageError(`Invalid store for ${id}.`);
    const format = resolveDeviceFormat(text(group.format, 'format'));
    if (!format) throw usageError('A store format is required.');
    const allowed = group.store === 'appstore' ? ['ios', 'ios-large', 'ipad-pro-13', 'ipad-11'] : ['android', 'tablet-7', 'tablet-10'];
    if (!allowed.includes(format) || !DEVICE_FORMAT_PRESETS.some((preset) => preset.id === format)) throw usageError(`Format ${format} does not match ${group.store}.`);
    const locale = safe(group.locale, 'locale');
    const destination = [group.store, format, locale].join('/');
    if (destinations.has(destination)) throw usageError(`Duplicate destination: ${destination}`);
    destinations.add(destination);
    const projectLocale = group.projectLocale === null ? null : text(group.projectLocale, 'projectLocale (or null for the base canvas)');
    if (projectLocale && projectLocale.toLowerCase() !== locale.toLowerCase()) throw usageError(`Project and output languages differ for ${id}.`);
    const project = path.resolve(root, text(group.project, 'project'));
    const projectBytes = readRegular(project);
    let document: any;
    try { document = JSON.parse(projectBytes.toString('utf8')); } catch { throw usageError(`Invalid project: ${project}`); }
    if (!Array.isArray(document.projectData) || !Array.isArray(group.screens) || !group.screens.length) throw usageError(`Missing boards or screens for ${id}.`);
    const countFindings = checkScreenshotCount(group.screens.length, id, rulesetFor(group.store));
    if (countFindings.some((item) => item.level === 'fail')) throw usageError(countFindings[0].message);
    const baseLocale = document.projectData.find((board: any) => board?.localization)?.localization?.baseLocale;
    if (!projectLocale && baseLocale && baseLocale.toLowerCase() !== locale.toLowerCase()) throw usageError(`Base and output languages differ for ${id}.`);
    const projected = projectArtboards(document.projectData as ArtboardState[], projectLocale);
    const screenIds = new Set<string>();
    const boardIds = new Set<string>();
    const inputHashes = new Set<string>();
    const screens: Screen[] = group.screens.map((entry: any) => {
      const screenId = safe(entry?.id, 'screen id');
      const boardId = text(entry.boardId, 'boardId');
      if (screenIds.has(screenId) || boardIds.has(boardId)) throw usageError(`Duplicate screen or board in ${id}.`);
      screenIds.add(screenId); boardIds.add(boardId);
      const input = path.resolve(root, text(entry.input, 'input screenshot'));
      const inputFormat = resolveDeviceFormat(text(entry.inputFormat, 'input screenshot format'));
      const inputLocale = safe(entry.inputLocale, 'input screenshot locale');
      if (inputFormat !== format) throw usageError(`Input screenshot format differs for ${id}/${screenId}.`);
      if (inputLocale.toLowerCase() !== locale.toLowerCase()) throw usageError(`Input screenshot language differs for ${id}/${screenId}.`);
      if (!['.png', '.jpg', '.jpeg'].includes(path.extname(input).toLowerCase())) throw usageError(`Unsupported screenshot: ${input}`);
      const bytes = readRegular(input);
      const inputHash = sha256(bytes);
      if (inputHashes.has(inputHash)) throw usageError(`Duplicate input screenshot in ${id}: ${screenId}.`);
      inputHashes.add(inputHash);
      const board = projected.find((item) => item?.id === boardId);
      if (!board) throw usageError(`Board ${boardId} is missing from ${id}.`);
      if (!Array.isArray(board.elements) || !board.elements.some((element: any) => element.opacity !== 0 && containsImage([element.screenshotSrc, element.imageSrc, element.mediaId ? `asset:${element.mediaId}` : null], inputHash, document.mediaData ?? {}))) throw usageError(`Board ${boardId} does not contain the exact input screenshot. Reinsert it before preparing delivery.`);
      return { id: screenId, boardId, input, inputFormat, inputLocale, claim: text(entry.claim, 'screen claim'), sha256: inputHash };
    });
    return { id, store: group.store, format, locale, projectLocale, project, projectSha256: sha256(projectBytes), screens };
  });
  return { version: 1, name: text(data.name, 'delivery name'), spec, specSha256: sha256(raw), groups };
}
