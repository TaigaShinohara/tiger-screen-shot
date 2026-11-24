import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs, flagBool } from './args.js';

const RECORDED = new Set(['init', 'import', 'new', 'fill', 'design', 'edit', 'call', 'desktop-call', 'render', 'video', 'localize', 'manifest', 'upload', 'cache', 'editor', 'install', 'all']);
const MAX_BYTES = 1024 * 1024;

export interface HistoryEntry {
  schema_version: 1;
  request_id: string;
  finished_at: string;
  command: string;
  dry_run: boolean;
  exit_code: number;
  outcome: string;
}

export function historyFile(): string {
  const override = process.env.OSG_HISTORY_FILE?.trim();
  if (override) return path.resolve(override);
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'open-screenshot-generator', 'history.jsonl');
}

export function recordCommand(argv: string[], exitCode: number, requestId?: string, outcome?: string): void {
  const args = parseArgs(argv);
  if (!RECORDED.has(args.command) || flagBool(args.flags, 'help') || flagBool(args.flags, 'h')) return;
  const file = historyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entry: HistoryEntry = {
    schema_version: 1, request_id: requestId ?? randomUUID(), finished_at: new Date().toISOString(),
    command: args.command, dry_run: flagBool(args.flags, 'dry-run'), exit_code: exitCode,
    outcome: outcome ?? (exitCode === 0 ? 'success' : exitCode === 1 ? 'usage_or_environment_error' : exitCode === 3 ? 'verification_failed' : 'execution_failed'),
  };
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('History target is not a regular file');
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally { fs.closeSync(fd); }
}

export function readHistory(limit: number): { entries: HistoryEntry[]; truncated: boolean; invalid_lines: number } {
  let fd: number;
  try { fd = fs.openSync(historyFile(), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], truncated: false, invalid_lines: 0 };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('History target is not a regular file');
    const start = Math.max(0, stat.size - MAX_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    const read = fs.readSync(fd, bytes, 0, bytes.length, start);
    let lines = bytes.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const entries: HistoryEntry[] = [];
    let invalid = 0;
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.schema_version !== 1 || typeof entry.request_id !== 'string' || typeof entry.command !== 'string' || typeof entry.exit_code !== 'number' || typeof entry.finished_at !== 'string' || typeof entry.outcome !== 'string' || typeof entry.dry_run !== 'boolean') throw new Error('Invalid entry');
        entries.push({schema_version: 1, request_id: entry.request_id, finished_at: entry.finished_at, command: entry.command, dry_run: entry.dry_run, exit_code: entry.exit_code, outcome: entry.outcome});
      } catch { invalid++; }
    }
    return { entries: entries.slice(-limit).reverse(), truncated: start > 0 || entries.length > limit, invalid_lines: invalid };
  } finally { fs.closeSync(fd); }
}
