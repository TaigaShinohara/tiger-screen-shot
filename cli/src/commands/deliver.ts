import fs from 'node:fs';
import path from 'node:path';
import { flagBool, flagString } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import { emit, info } from '../log.js';
import { openProject } from './render.js';
import { readDeliveryPlan, fileHash, sha256, type DeliveryPlan } from '../delivery/spec.js';
import { resolveEditor } from '../editor/resolve.js';
import { readPngInfo } from '../verify/png.js';
import { isCompletePng } from '../delivery/png.js';
import { checkPng, checkRequiredIphoneSlot, rulesetFor } from '../verify/rules.js';
import { DEVICE_FORMAT_PRESETS } from '@/lib/deviceRegistry';

type Item = { group: string; screen: string; boardId: string; store: string; format: string; locale: string; order: number; claim: string; source: string; sourceSha256: string; file: string; sha256: string; thumbnail: string; thumbnailSha256: string; width: number; height: number };
type Workspace = { version: 1; status: 'review_required'; plan: DeliveryPlan; items: Item[] };
const CHECKS = ['actualScreen', 'claimAccurate', 'readableFullSize', 'readableThumbnail', 'noClipping', 'appropriateDevice', 'noPlaceholder'] as const;
function absolute(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw usageError(`Pass ${label}.`);
  return path.resolve(value);
}
function child(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw usageError('Invalid workspace path.');
  const result = path.resolve(root, rel);
  if (!result.startsWith(root + path.sep)) throw usageError('Workspace path escapes its directory.');
  return result;
}
function sameFile(file: string, expected: string): void {
  if (typeof expected !== 'string' || fileHash(file) !== expected) throw usageError(`File changed since preparation: ${file}`);
}
function assertCurrent(plan: DeliveryPlan): void {
  sameFile(plan.spec, plan.specSha256);
  for (const group of plan.groups) {
    sameFile(group.project, group.projectSha256);
    for (const screen of group.screens) sameFile(screen.input, screen.sha256);
  }
}
function writeJson(file: string, value: unknown): void { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
async function decodeAndThumbnail(page: import('puppeteer-core').Page, bytes: Buffer, thumb: boolean): Promise<string | null> {
  const data = bytes.toString('base64');
  return page.evaluate(async ({ data, thumb }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image has no pixels');
    if (!thumb) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = Math.max(1, Math.round(image.naturalHeight * 240 / image.naturalWidth));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Thumbnail canvas is unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { data, thumb });
}
async function prepare(ctx: CommandContext, specFile: string, workDir: string): Promise<number> {
  const plan = readDeliveryPlan(specFile);
  if (fs.existsSync(workDir)) throw usageError('The work directory already exists. Choose a new directory.');
  if (flagBool(ctx.args.flags, 'dry-run')) {
    emit({ status: 'planned', dryRun: true, plan, reviewRequired: true, writes: false });
    return EXIT.ok;
  }
  if (!ctx.offline) throw usageError('Delivery preparation requires --offline.', 'Use a locally built or bundled editor and local assets.');
  const editor = resolveEditor({ cwd: ctx.root });
  if (editor.kind !== 'local') throw usageError('A local editor build is required.', 'Set OSG_EDITOR_DIR to a local editor build.');
  fs.mkdirSync(workDir, { recursive: false, mode: 0o700 });
  const session = await ctx.session({ downloadDir: path.join(workDir, 'downloads') });
  const items: Item[] = [];
  const appleByLocale = new Map<string, { width: number; height: number }[]>();
  for (const group of plan.groups) {
    const groupCtx = { ...ctx, projectFile: group.project };
    const status = await openProject(groupCtx, session);
    if (group.projectLocale && ![status.baseLocale, ...status.locales].includes(group.projectLocale)) throw usageError(`Project language ${group.projectLocale} is missing from ${group.id}.`);
    for (const screen of group.screens) {
      const bytes = fs.readFileSync(screen.input);
      const mime = path.extname(screen.input).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      await session.page.evaluate(async ({ data, mime }) => {
        const img = new Image(); img.src = `data:${mime};base64,${data}`; await img.decode();
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('Input screenshot has no pixels');
      }, { data: bytes.toString('base64'), mime });
    }
    const images = await session.capture(group.screens.map((screen) => screen.boardId), group.format, group.projectLocale);
    if (images.length !== group.screens.length || new Set(images.map((item) => item.artboardId)).size !== group.screens.length) throw usageError(`The editor did not return exactly the requested boards for ${group.id}.`);
    const preset = DEVICE_FORMAT_PRESETS.find((entry) => entry.id === group.format)!;
    for (const [index, screen] of group.screens.entries()) {
      const image = images.find((entry) => entry.artboardId === screen.boardId);
      if (!image) throw usageError(`Missing rendered board ${screen.boardId}.`);
      const bytes = Buffer.from(image.base64, 'base64');
      const header = readPngInfo(bytes);
      if (!isCompletePng(bytes) || !header || header.width !== preset.artboard.width || header.height !== preset.artboard.height) throw usageError(`Unexpected PNG size for ${screen.id}.`);
      const findings = checkPng(header, rulesetFor(group.store));
      if (findings.some((finding) => finding.level !== 'ok')) throw usageError(`Image ${screen.id} did not pass store checks: ${findings.map((finding) => finding.message).join('; ')}`);
      const thumbnail = await decodeAndThumbnail(session.page, bytes, true);
      if (!thumbnail) throw usageError(`Cannot make thumbnail for ${screen.id}.`);
      const rel = `images/${group.id}/${String(index + 1).padStart(2, '0')}-${screen.id}.png`;
      const relThumb = `thumbnails/${group.id}/${String(index + 1).padStart(2, '0')}-${screen.id}.png`;
      const file = child(workDir, rel), thumbFile = child(workDir, relThumb);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(path.dirname(thumbFile), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      const thumbBytes = Buffer.from(thumbnail, 'base64'); fs.writeFileSync(thumbFile, thumbBytes, { flag: 'wx' });
      items.push({ group: group.id, screen: screen.id, boardId: screen.boardId, store: group.store, format: group.format, locale: group.locale, order: index + 1, claim: screen.claim, source: screen.input, sourceSha256: screen.sha256, file: rel, sha256: sha256(bytes), thumbnail: relThumb, thumbnailSha256: sha256(thumbBytes), width: header.width, height: header.height });
      if (group.store === 'appstore' && ['ios', 'ios-large'].includes(group.format)) appleByLocale.set(group.locale, [...(appleByLocale.get(group.locale) ?? []), { width: header.width, height: header.height }]);
    }
  }
  for (const [locale, sizes] of appleByLocale) {
    const findings = checkRequiredIphoneSlot(sizes, rulesetFor('appstore'));
    if (findings.some((finding) => finding.level !== 'ok')) throw usageError(`${locale}: ${findings.map((finding) => finding.message).join('; ')}`);
  }
  assertCurrent(plan);
  const workspace: Workspace = { version: 1, status: 'review_required', plan, items };
  writeJson(path.join(workDir, 'delivery-workspace.json'), workspace);
  emit({ status: 'review_required', workspace: workDir, images: items, requiredChecks: CHECKS, next: 'Inspect each full image and thumbnail; write the review JSON and run osg deliver finish.' });
  return EXIT.verify;
}
function validateWorkspace(workDir: string, workspace: Workspace): void {
  const actualPlan = readDeliveryPlan(workspace.plan.spec);
  if (JSON.stringify(actualPlan) !== JSON.stringify(workspace.plan)) throw usageError('The delivery specification changed. Prepare again.');
  const expected = actualPlan.groups.flatMap((group) => group.screens.map((screen, index) => ({ group, screen, order: index + 1 })));
  if (workspace.items.length !== expected.length) throw usageError('The workspace has missing or extra images.');
  const allowed = new Set(['delivery-workspace.json']);
  for (const [index, { group, screen, order }] of expected.entries()) {
    const item = workspace.items[index];
    const base = `${String(order).padStart(2, '0')}-${screen.id}.png`;
    const file = `images/${group.id}/${base}`, thumbnail = `thumbnails/${group.id}/${base}`;
    if (!item || item.group !== group.id || item.screen !== screen.id || item.boardId !== screen.boardId || item.store !== group.store || item.format !== group.format || item.locale !== group.locale || item.order !== order || item.claim !== screen.claim || item.source !== screen.input || item.sourceSha256 !== screen.sha256 || item.file !== file || item.thumbnail !== thumbnail) throw usageError('Workspace contents do not match the delivery specification.');
    allowed.add(file); allowed.add(thumbnail);
  }
  const walk = (dir: string, prefix = ''): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (!entry.isFile() || !allowed.has(rel)) throw usageError(`Unexpected workspace file: ${rel}`);
    }
  };
  walk(workDir);
}

function finish(workDir: string, reviewPath: string, outputDir: string): number {
  let workspace: Workspace, review: any;
  try { workspace = JSON.parse(fs.readFileSync(path.join(workDir, 'delivery-workspace.json'), 'utf8')); review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')); }
  catch { throw usageError('The workspace or review JSON could not be read.'); }
  if (workspace.version !== 1 || workspace.status !== 'review_required' || !Array.isArray(workspace.items) || !workspace.items.length || review.version !== 1 || review.reviewer !== 'ai' || !Array.isArray(review.items)) throw usageError('Invalid workspace or AI review.');
  assertCurrent(workspace.plan);
  validateWorkspace(workDir, workspace);
  if (outputDir === workDir || outputDir.startsWith(workDir + path.sep) || workDir.startsWith(outputDir + path.sep)) throw usageError('The output and workspace must be separate directories.');
  if (review.items.length !== workspace.items.length) throw usageError('Review every image.');
  const seen = new Set<string>();
  for (const item of workspace.items) {
    const key = `${item.group}/${item.screen}`;
    if (seen.has(key)) throw usageError('Duplicate image in workspace.');
    seen.add(key);
    const matches = review.items.filter((entry: any) => entry.group === item.group && entry.screen === item.screen);
    if (matches.length !== 1) throw usageError(`Review missing or duplicated for ${key}.`);
    const entry = matches[0];
    if (entry.sha256 !== item.sha256 || entry.thumbnailSha256 !== item.thumbnailSha256 || typeof entry.notes !== 'string' || !entry.notes.trim() || !entry.checks || !CHECKS.every((check) => entry.checks[check] === true)) throw usageError(`AI review is incomplete or does not match ${key}.`);
    sameFile(child(workDir, item.file), item.sha256); sameFile(child(workDir, item.thumbnail), item.thumbnailSha256);
    const bytes = fs.readFileSync(child(workDir, item.file));
    const thumbnail = fs.readFileSync(child(workDir, item.thumbnail));
    const header = readPngInfo(bytes), thumbHeader = readPngInfo(thumbnail);
    const preset = DEVICE_FORMAT_PRESETS.find((candidate) => candidate.id === item.format);
    if (!preset || !isCompletePng(bytes) || !header || header.width !== preset.artboard.width || header.height !== preset.artboard.height || header.width !== item.width || header.height !== item.height || checkPng(header, rulesetFor(item.store)).some((finding) => finding.level !== 'ok')) throw usageError(`Image ${key} no longer passes the PNG and store checks.`);
    if (!isCompletePng(thumbnail) || !thumbHeader || thumbHeader.width !== 240) throw usageError(`Thumbnail ${key} is invalid.`);
  }
  fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const files = workspace.items.map((item) => {
    const rel = `${item.store}/${item.format}/${item.locale}/${String(item.order).padStart(2, '0')}-${item.screen}.png`;
    const reviewThumbnail = `review-thumbnails/${item.group}/${String(item.order).padStart(2, '0')}-${item.screen}.png`;
    const target = child(outputDir, rel);
    const thumbnailTarget = child(outputDir, reviewThumbnail);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(thumbnailTarget), { recursive: true });
    fs.copyFileSync(child(workDir, item.file), target, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(child(workDir, item.thumbnail), thumbnailTarget, fs.constants.COPYFILE_EXCL);
    sameFile(target, item.sha256);
    sameFile(thumbnailTarget, item.thumbnailSha256);
    return { ...item, file: rel, thumbnail: reviewThumbnail, review: review.items.find((entry: any) => entry.group === item.group && entry.screen === item.screen) };
  });
  writeJson(path.join(outputDir, 'delivery-manifest.json'), { version: 1, status: 'delivered', name: workspace.plan.name, files, specSha256: workspace.plan.specSha256, verifiedAt: new Date().toISOString(), visualReview: 'AI-reported; not an independent guarantee of store acceptance' });
  emit({ status: 'delivered', output: outputDir, manifest: path.join(outputDir, 'delivery-manifest.json'), files: files.length });
  return EXIT.ok;
}
export async function run(ctx: CommandContext): Promise<number> {
  const action = ctx.args.positionals[0] ?? 'prepare';
  const allowed = new Set(action === 'prepare' ? ['spec', 'work', 'dry-run', 'offline', 'browser', 'json', 'quiet', 'verbose'] : ['work', 'review', 'out', 'offline', 'json', 'quiet', 'verbose']);
  for (const flag of Object.keys(ctx.args.flags)) if (!allowed.has(flag)) throw usageError(`--${flag} is not supported for deliver ${action}.`);
  if (ctx.args.positionals.length > 1) throw usageError('Unexpected delivery arguments.');
  if (action === 'prepare') return prepare(ctx, absolute(flagString(ctx.args.flags, 'spec'), '--spec'), absolute(flagString(ctx.args.flags, 'work'), '--work'));
  if (action === 'finish') {
    if (flagBool(ctx.args.flags, 'dry-run')) throw usageError('Finish does not support --dry-run.');
    return finish(absolute(flagString(ctx.args.flags, 'work'), '--work'), absolute(flagString(ctx.args.flags, 'review'), '--review'), absolute(flagString(ctx.args.flags, 'out'), '--out'));
  }
  info('Use osg deliver prepare or osg deliver finish.');
  throw usageError(`Unknown delivery action: ${action}`);
}
