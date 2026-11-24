/**
 * osg verify: the gate.
 *
 * Every other command in this CLI produces files. This is the one that refuses
 * them, which is why it owns an exit code of its own: 3 says the run happened
 * and a store rule rejects the result, and CI can tell that apart from a
 * browser that never started (2) or a config nobody wrote (1). The competitor
 * ships this and this project did not, so an agent could hand back a set App
 * Store Connect would bounce and nothing in the loop would know until a person
 * tried to upload it.
 *
 * No rule is written here. verify/png.ts and verify/mp4.ts read the real
 * headers, verify/rules.ts holds the store tables (imported from the app's own
 * publish path, so they cannot drift from what the editor uploads), and this
 * file only decides what to read, how to group it and how to print it.
 *
 * Two kinds of finding: per file, and per set. A store counts screenshots per
 * size, so "too few to publish" is not a fact about any one PNG, which is what
 * checkScreenshotCount and the grouping below exist for.
 *
 * Warnings fail the run only when --strict is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { flagBool, flagList, flagString } from '../args.js';
import { DEVICE_FORMAT_PRESETS } from '@/lib/deviceRegistry';
import { DEFAULTS } from '../config.js';
import type { CommandContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import { emit, fail, green, humanBytes, info, ok, red, step, warn, yellow } from '../log.js';
import { readMp4File } from '../verify/mp4.js';
import { readPngFile } from '../verify/png.js';
import { localeOf } from '../verify/locales.js';
import { resolveDeviceFormat } from '../formats.js';
import { localesOf, readProjectFile } from './render.js';
import {
  checkMp4,
  checkPng,
  checkPreviewCount,
  checkRequiredIphoneSlot,
  checkScreenshotCount,
  isCreativeArt,
  rulesetFor,
  worstLevel,
  type Finding,
  type RuleLevel,
  type StoreId,
  type StoreRuleset,
} from '../verify/rules.js';

const PNG_EXT = new Set(['.png']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);

export interface FileReport {
  /** Relative to the audited directory, forward slashes on every OS. */
  file: string;
  kind: 'png' | 'video';
  width: number | null;
  height: number | null;
  /** Seconds, videos only. */
  duration: number | null;
  bytes: number;
  level: RuleLevel;
  findings: Finding[];
  locale: string | null;
}

interface SetReport {
  label: string;
  kind: 'png' | 'video';
  files: number;
  level: RuleLevel;
  findings: Finding[];
}

function resolveStore(value: string): StoreId {
  if (value === 'appstore' || value === 'play') return value;
  throw usageError(
    `Unknown store "${value}".`,
    'Pass --store appstore or --store play, or set `store` in osg.config.ts.'
  );
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // A dot entry here is somebody's .git or .DS_Store, never a store file.
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function auditFile(file: string, rel: string, ruleset: StoreRuleset): Omit<FileReport, 'locale'> {
  const bytes = fs.statSync(file).size;
  const kind: 'png' | 'video' = PNG_EXT.has(path.extname(file).toLowerCase()) ? 'png' : 'video';

  if (kind === 'png') {
    const header = readPngFile(file);
    // The readers answer null rather than throwing, because "these bytes are
    // not a PNG" is a finding about the file, not an error in the run.
    if (!header) {
      return {
        file: rel,
        kind,
        width: null,
        height: null,
        duration: null,
        bytes,
        level: 'fail',
        findings: [{ level: 'fail', code: 'png-unreadable', message: 'not a PNG, or truncated before its header' }],
      };
    }
    const findings = checkPng(header, ruleset);
    return {
      file: rel,
      kind,
      width: header.width,
      height: header.height,
      duration: null,
      bytes,
      level: worstLevel(findings),
      findings,
    };
  }

  const header = readMp4File(file);
  if (!header) {
    return {
      file: rel,
      kind,
      width: null,
      height: null,
      duration: null,
      bytes,
      level: 'fail',
      findings: [{ level: 'fail', code: 'mp4-unreadable', message: 'not an MP4, or truncated before its headers' }],
    };
  }
  const findings = checkMp4(header, ruleset);
  return {
    file: rel,
    kind,
    width: header.width,
    height: header.height,
    duration: header.durationSeconds,
    bytes,
    level: worstLevel(findings),
    findings,
  };
}

/**
 * Stores count screenshots per language and size. A language may be named by
 * its folder or by the prefix the web exporter puts on each filename.
 */
export function auditSets(rows: FileReport[], ruleset: StoreRuleset): SetReport[] {
  const groups = new Map<string, { label: string; kind: 'png' | 'video'; files: number }>();
  for (const row of rows) {
    if (!row.width || !row.height) continue;
    // One header per language is the whole set, and it is not a screenshot.
    if (row.kind === 'png' && isCreativeArt(row.width, row.height, ruleset)) continue;
    const folder = path.posix.dirname(row.file);
    const label = `${folder === '.' ? '' : `${folder} `}${row.locale ? `${row.locale} ` : ''}${row.width}x${row.height}`;
    const key = `${row.kind}:${label}`;
    const existing = groups.get(key);
    if (existing) existing.files += 1;
    else groups.set(key, { label, kind: row.kind, files: 1 });
  }

  const sets: SetReport[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const findings =
      group.kind === 'png'
        ? checkScreenshotCount(group.files, group.label, ruleset)
        : checkPreviewCount(group.files, group.label, ruleset);
    if (findings.length === 0) continue;
    sets.push({ label: group.label, kind: group.kind, files: group.files, level: worstLevel(findings), findings });
  }
  return sets;
}

export function auditListing(
  rows: FileReport[],
  ruleset: StoreRuleset,
  options: { locales?: string[]; formats?: string[] } = {}
): Finding[] {
  const groups = new Map<string | null, FileReport[]>();
  for (const locale of options.locales ?? []) groups.set(locale, []);
  for (const row of rows) {
    if (row.kind !== 'png') continue;
    const group = groups.get(row.locale) ?? [];
    group.push(row);
    groups.set(row.locale, group);
  }
  const findings: Finding[] = [];
  const formats = (options.formats ?? []).flatMap((id) => {
    const mapped = resolveDeviceFormat(id);
    return mapped ? [DEVICE_FORMAT_PRESETS.find((preset) => preset.id === mapped)!] : [];
  });
  for (const [locale, files] of groups) {
    const label = locale ?? 'base';
    if (files.length === 0 && options.locales?.includes(label)) {
      findings.push(...checkScreenshotCount(0, label, ruleset));
    }
    const sizes = files.flatMap((row) => row.width && row.height ? [{ width: row.width, height: row.height }] : []);
    findings.push(...checkRequiredIphoneSlot(sizes, ruleset).map((finding) => ({
      ...finding,
      message: locale ? `${locale}: ${finding.message}` : finding.message,
    })));
    for (const format of formats) {
      const { width, height } = format.artboard;
      if (sizes.some((size) => (size.width === width && size.height === height) || (size.width === height && size.height === width))) continue;
      findings.push({
        level: 'fail',
        code: 'set-required-format-missing',
        message: `${label} has no ${width}x${height} screenshots for ${format.label}`,
      });
    }
  }
  return findings;
}

const BADGE: Record<RuleLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

function badge(level: RuleLevel): string {
  if (level === 'fail') return red(BADGE.fail);
  return level === 'warn' ? yellow(BADGE.warn) : green(BADGE.ok);
}

function paint(finding: Finding): string {
  if (finding.level === 'fail') return red(finding.message);
  return finding.level === 'warn' ? yellow(finding.message) : finding.message;
}

function measure(row: FileReport): string {
  if (!row.width || !row.height) return '?';
  const size = `${row.width}x${row.height}`;
  return row.duration ? `${size} ${row.duration.toFixed(1)}s` : size;
}

function printTable(rows: FileReport[], sets: SetReport[]): void {
  // Padded before the colour goes on, or every escape sequence counts toward
  // the column width and the table shears on a TTY.
  const nameWidth = Math.max(...rows.map((row) => row.file.length));
  const sizeWidth = Math.max(...rows.map((row) => measure(row).length));
  const byteWidth = Math.max(...rows.map((row) => humanBytes(row.bytes).length));
  const gutter = ' '.repeat(4 + 2 + nameWidth + 2 + sizeWidth + 2 + byteWidth);

  for (const row of rows) {
    // An 'ok' finding is the rule saying it looked and found nothing, which is
    // worth having in --json and is noise in a table.
    const notes = row.findings.filter((finding) => finding.level !== 'ok');
    const head = `  ${badge(row.level)}  ${row.file.padEnd(nameWidth)}  ${measure(row).padStart(sizeWidth)}  ${humanBytes(row.bytes).padStart(byteWidth)}`;
    info(notes.length > 0 ? `${head}  ${paint(notes[0])}` : head);
    for (const note of notes.slice(1)) info(`  ${gutter}  ${paint(note)}`);
  }

  // A set that passes says so in the summary line's set count. A project with
  // five formats in ten languages has fifty sets, and fifty rows of "3
  // screenshots" would bury the two that matter.
  for (const set of sets) {
    for (const finding of set.findings) {
      if (finding.level !== 'ok') info(`  ${badge(finding.level)}  ${paint(finding)}`);
    }
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function run(ctx: CommandContext): Promise<number> {
  const strict = flagBool(ctx.args.flags, 'strict');
  const store = resolveStore(flagString(ctx.args.flags, 'store') ?? ctx.config.store ?? DEFAULTS.store);
  const ruleset = rulesetFor(store);
  const dir = path.resolve(ctx.root, ctx.args.positionals[0] ?? ctx.outDir);

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw usageError(
      `Nothing to verify: ${dir} is not a directory.`,
      'Run `osg render` first, or name the directory to check: `osg verify <dir>`.'
    );
  }

  const files = walk(dir, [])
    .filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return PNG_EXT.has(ext) || VIDEO_EXT.has(ext);
    })
    .sort();

  // Nothing produced is not a rule violation, it is a run that never happened,
  // so this exits 1 rather than 3 and says which of the two it is.
  if (files.length === 0) {
    throw usageError(
      `No PNG or MP4 files under ${dir}.`,
      'Run `osg render` first, or point verify at the directory that holds the store files.'
    );
  }

  step(`verify: ${plural(files.length, 'file')} against the ${ruleset.label} rules`);

  let projectLocales: { base: string | null; codes: string[] } = { base: null, codes: [] };
  if (fs.existsSync(ctx.projectFile)) {
    try {
      projectLocales = localesOf(readProjectFile(ctx.projectFile).boards);
    } catch {
      // Verification also accepts folders without a readable project file.
    }
  }
  const requestedLocales = flagList(ctx.args.flags, 'locales') ?? ctx.config.locales;
  const locales = requestedLocales?.includes('all') ? projectLocales.codes : requestedLocales;
  const knownLocales = [...projectLocales.codes, ...(locales ?? [])];
  const fallbackLocale = locales?.length === 1 ? locales[0] : projectLocales.base;
  const rows = files.map((file) => {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    return { ...auditFile(file, rel, ruleset), locale: localeOf(rel, knownLocales) ?? fallbackLocale };
  });
  const sets = auditSets(rows, ruleset);
  const listing = auditListing(rows, ruleset, { locales, formats: flagList(ctx.args.flags, 'formats') });

  const failures =
    rows.filter((row) => row.level === 'fail').length +
    sets.filter((set) => set.level === 'fail').length +
    listing.filter((finding) => finding.level === 'fail').length;
  const warnings =
    rows.filter((row) => row.level === 'warn').length +
    sets.filter((set) => set.level === 'warn').length +
    listing.filter((finding) => finding.level === 'warn').length;
  const passed = rows.length - rows.filter((row) => row.level !== 'ok').length;
  const accepted = failures === 0 && (!strict || warnings === 0);
  const summary =
    `${plural(rows.length, 'file')} in ${plural(sets.length, 'set')}, ` +
    `${passed} ok, ${plural(warnings, 'warning')}, ${plural(failures, 'failure')}`;

  if (ctx.json) {
    emit({
      command: 'verify',
      store,
      dir,
      ok: accepted,
      strict,
      summary: { files: rows.length, ok: passed, warnings, failures },
      files: rows,
      sets,
      listing,
    });
  } else {
    printTable(rows, sets);
    for (const finding of listing) info(`  ${badge(finding.level)}  ${paint(finding)}`);
    if (!accepted) fail(summary);
    else if (warnings > 0) warn(summary);
    else ok(summary);
  }

  return accepted ? EXIT.ok : EXIT.verify;
}
