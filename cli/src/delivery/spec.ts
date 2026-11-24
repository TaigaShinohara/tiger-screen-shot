import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectArtboards } from '@/lib/i18n/project';
import type { ArtboardState } from '@/types/artboard';
import { DEVICE_FORMAT_PRESETS } from '@/lib/deviceRegistry';
import { resolveDeviceFormat } from '../formats.js';
import { OsgError, usageError } from '../errors.js';
import { checkScreenshotCount, rulesetFor } from '../verify/rules.js';
import { isCompletePng } from './png.js';
import { readCaptureRecord, type CaptureRecord } from './captureRecord.js';

export interface Screen { id: string; boardId: string; input: string; inputFormat: string; inputLocale: string; claim: string; sha256: string; capture?: { file: string; sha256: string; record: CaptureRecord } }
export interface Group { id: string; store: 'appstore' | 'play'; format: string; locale: string; projectLocale: string | null; project: string; projectSha256: string; screens: Screen[] }
export interface DeliveryPlan { version: 1; name: string; spec: string; specSha256: string; requestSource?: { file: string; sha256: string }; groups: Group[] }

export interface InputIssue {
  group: string;
  screen: string;
  code: 'missing_input' | 'invalid_image' | 'format_mismatch' | 'language_mismatch' | 'missing_board' | 'input_not_placed' | 'invalid_capture_record';
  message: string;
  next: 'supply_or_capture_input' | 'correct_input' | 'edit_project';
}

export class DeliveryInputError extends OsgError {
  constructor(readonly issues: InputIssue[]) {
    super(issues.length === 1 ? issues[0].message : `${issues.length} screenshot inputs need attention.`);
  }
}

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

function readSpec(specPath: string) {
  const spec = path.resolve(specPath);
  const raw = readRegular(spec);
  let data: any;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw usageError('The delivery spec is not valid JSON.'); }
  if (!data || data.version !== 1 || !Array.isArray(data.groups) || !data.groups.length) throw usageError('The delivery spec needs version 1 and at least one group.');
  return { spec, raw, data };
}

function target(group: any, id: string) {
  if (group.store !== 'appstore' && group.store !== 'play') throw usageError(`Invalid store for ${id}.`);
  const format = resolveDeviceFormat(text(group.format, 'format'));
  const allowed = group.store === 'appstore' ? ['ios', 'ios-large', 'ipad-pro-13', 'ipad-11'] : ['android', 'tablet-7', 'tablet-10'];
  if (!format || !allowed.includes(format) || !DEVICE_FORMAT_PRESETS.some((preset) => preset.id === format)) throw usageError(`Format ${format} does not match ${group.store}.`);
  return { store: group.store as Group['store'], format, locale: safe(group.locale, 'locale') };
}

export function readCaptureTarget(specPath: string, groupId: string, screenId: string) {
  const { spec, data } = readSpec(specPath);
  const groups = data.groups.filter((group: any) => group?.id === groupId);
  if (groups.length !== 1) throw usageError(`Choose a unique group: ${groupId}.`);
  const [group] = groups;
  const screens = Array.isArray(group.screens) ? group.screens.filter((screen: any) => screen?.id === screenId) : [];
  if (screens.length !== 1) throw usageError(`Choose a unique screen: ${groupId}/${screenId}.`);
  return { spec, group: safe(groupId, 'group id'), screen: safe(screenId, 'screen id'), ...target(group, groupId) };
}

/** Reads only. Relative paths in the spec belong to the spec's directory. */
export function readDeliveryPlan(specPath: string, options: { draft?: boolean } = {}): DeliveryPlan {
  const { spec, raw, data } = readSpec(specPath);
  const root = path.dirname(spec);
  const ids = new Set<string>();
  const destinations = new Set<string>();
  const issues: InputIssue[] = [];
  const groups: Group[] = data.groups.map((group: any) => {
    const id = safe(group?.id, 'group id');
    if (ids.has(id)) throw usageError(`Duplicate group: ${id}`);
    ids.add(id);
    const { store, format, locale } = target(group, id);
    const destination = [store, format, locale].join('/').toLowerCase();
    if (destinations.has(destination)) throw usageError(`Duplicate destination: ${destination}`);
    destinations.add(destination);
    const projectLocale = group.projectLocale === null ? null : text(group.projectLocale, 'projectLocale (or null for the base canvas)');
    if (projectLocale && projectLocale.toLowerCase() !== locale.toLowerCase()) throw usageError(`Project and output languages differ for ${id}.`);
    if (options.draft && (group.project !== undefined || projectLocale !== null)) throw usageError(`Draft ${id} must omit project and use projectLocale: null.`);
    const project = options.draft ? '' : path.resolve(root, text(group.project, 'project'));
    const projectBytes = options.draft ? Buffer.alloc(0) : readRegular(project);
    let document: any;
    if (options.draft) document = { projectData: [] };
    else {
      try { document = JSON.parse(projectBytes.toString('utf8')); } catch { throw usageError(`Invalid project: ${project}`); }
    }
    if (!Array.isArray(document.projectData) || !Array.isArray(group.screens) || !group.screens.length) throw usageError(`Missing boards or screens for ${id}.`);
    const countFindings = checkScreenshotCount(group.screens.length, id, rulesetFor(group.store));
    if (countFindings.some((item) => item.level === 'fail')) throw usageError(countFindings[0].message);
    const baseLocale = document.projectData.find((board: any) => board?.localization)?.localization?.baseLocale;
    if (!projectLocale && baseLocale && baseLocale.toLowerCase() !== locale.toLowerCase()) throw usageError(`Base and output languages differ for ${id}.`);
    const projected = projectArtboards(document.projectData as ArtboardState[], projectLocale);
    const screenIds = new Set<string>();
    const boardIds = new Set<string>();
    const inputHashes = new Set<string>();
    const screens: Screen[] = group.screens.flatMap((entry: any) => {
      const screenId = safe(entry?.id, 'screen id');
      const boardId = options.draft ? screenId : text(entry.boardId, 'boardId');
      if (screenIds.has(screenId) || boardIds.has(boardId)) throw usageError(`Duplicate screen or board in ${id}.`);
      screenIds.add(screenId); boardIds.add(boardId);
      const issue = (code: InputIssue['code'], message: string, next: InputIssue['next']) => {
        issues.push({ group: id, screen: screenId, code, message, next });
        return [];
      };
      if (entry.input == null || entry.input === '') return issue('missing_input', `Missing input screenshot for ${id}/${screenId}.`, 'supply_or_capture_input');
      const input = path.resolve(root, text(entry.input, 'input screenshot'));
      const inputFormat = resolveDeviceFormat(text(entry.inputFormat, 'input screenshot format'));
      const inputLocale = safe(entry.inputLocale, 'input screenshot locale');
      if (inputFormat !== format) return issue('format_mismatch', `Input screenshot format differs for ${id}/${screenId}.`, 'correct_input');
      if (inputLocale.toLowerCase() !== locale.toLowerCase()) return issue('language_mismatch', `Input screenshot language differs for ${id}/${screenId}.`, 'correct_input');
      let bytes: Buffer;
      try { bytes = readRegular(input); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return issue('missing_input', `Missing input screenshot (ENOENT): ${input}`, 'supply_or_capture_input');
        return issue('invalid_image', `Cannot read input screenshot: ${input}`, 'correct_input');
      }
      const inputHash = sha256(bytes);
      if (inputHashes.has(inputHash)) throw usageError(`Duplicate input screenshot in ${id}: ${screenId}.`);
      const board = options.draft ? undefined : projected.find((item) => item?.id === boardId);
      if (!options.draft && !board) return issue('missing_board', `Board ${boardId} is missing from ${id}.`, 'edit_project');
      if (board && (!Array.isArray(board.elements) || !board.elements.some((element: any) => element.opacity !== 0 && containsImage([element.screenshotSrc, element.imageSrc, element.mediaId ? `asset:${element.mediaId}` : null], inputHash, document.mediaData ?? {})))) return issue('input_not_placed', `Board ${boardId} does not contain the exact input screenshot. Reinsert it before preparing delivery.`, 'edit_project');
      const extension = path.extname(input).toLowerCase();
      const valid = extension === '.png' ? isCompletePng(bytes)
        : ['.jpg', '.jpeg'].includes(extension) && bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
      if (!valid) return issue('invalid_image', `Invalid or incomplete screenshot: ${input}`, 'correct_input');
      inputHashes.add(inputHash);
      let capture: Screen['capture'];
      if (entry.capture !== undefined) {
        try {
          const file = path.resolve(root, text(entry.capture, 'capture record'));
          const recordBytes = readRegular(file);
          const record = readCaptureRecord(recordBytes, { group: id, screen: screenId, format, locale, bytes });
          capture = { file, sha256: sha256(recordBytes), record };
        } catch { return issue('invalid_capture_record', `Capture record does not match ${id}/${screenId} and its PNG.`, 'correct_input'); }
      }
      return [{ id: screenId, boardId, input, inputFormat, inputLocale, claim: text(entry.claim, 'screen claim'), sha256: inputHash, ...(capture ? { capture } : {}) }];
    });
    return { id, store, format, locale, projectLocale, project, projectSha256: sha256(projectBytes), screens };
  });
  if (issues.length) throw new DeliveryInputError(issues);
  let requestSource: DeliveryPlan['requestSource'];
  if (data.requestSource !== undefined) {
    const file = path.resolve(root, text(data.requestSource?.file, 'request source'));
    const expected = text(data.requestSource?.sha256, 'request source hash');
    if (fileHash(file) !== expected) throw usageError('The original delivery request changed. Create the designs again.');
    requestSource = { file, sha256: expected };
  }
  return { version: 1, name: text(data.name, 'delivery name'), spec, specSha256: sha256(raw), ...(requestSource ? { requestSource } : {}), groups };
}
