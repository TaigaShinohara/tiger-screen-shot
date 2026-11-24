import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../../cli/src/args';
import { runInspection } from '../../cli/src/commands/inspect';
import { readHistory, recordCommand } from '../../cli/src/history';

function inspect(args: string[]): { code: number; value: any } {
  let out = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try { return { code: runInspection(parseArgs(args), '1.0.9'), value: JSON.parse(out) }; }
  finally { process.stdout.write = write; }
}

test('inspects only the named project file and resolves stable artboard IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-inspect-'));
  try {
    const file = path.join(dir, 'project.json');
    const document = { id: 'project-1', name: 'Example', projectData: [{ id: 'board-1', name: 'First', elements: [{ id: 'element-1' }] }] };
    fs.writeFileSync(file, JSON.stringify(document));
    const before = fs.readFileSync(file);
    const list = inspect(['list', '--project', file]);
    assert.equal(list.code, 0);
    assert.deepEqual(list.value.data.artboards, [{ id: 'board-1', name: 'First', element_count: 1 }]);
    assert.deepEqual(inspect(['get', 'board-1', '--project', file]).value.data.artboard, document.projectData[0]);
    assert.equal(inspect(['get', 'missing', '--project', file]).code, 4);
    assert.equal(inspect(['status', '--project', file]).value.data.project_file_state, 'present');
    assert.deepEqual(fs.readFileSync(file), before);
    fs.writeFileSync(file, JSON.stringify({ projectData: [...document.projectData, ...document.projectData] }));
    assert.equal(inspect(['get', 'board-1', '--project', file]).value.error.code, 'ambiguous_id');
    fs.writeFileSync(file, '{');
    assert.equal(inspect(['list', '--project', file]).value.error.code, 'invalid_project');
    assert.equal(inspect(['status', '--config', 'untrusted.js']).value.error.code, 'unsupported_flag');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history records outcomes without arguments or secrets and leaves reads unrecorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-history-'));
  const previous = process.env.OSG_HISTORY_FILE;
  process.env.OSG_HISTORY_FILE = path.join(dir, 'private', 'history.jsonl');
  try {
    recordCommand(['edit', '--args', 'private-secret'], 2);
    recordCommand(['list'], 0);
    const file = process.env.OSG_HISTORY_FILE;
    assert.equal(fs.readFileSync(file, 'utf8').includes('private-secret'), false);
    const history = readHistory(50);
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].outcome, 'execution_failed');
    assert.equal(inspect(['history']).value.data.entries[0].command, 'edit');
    assert.equal(inspect(['history', '--limit', '0']).value.error.code, 'invalid_argument');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.OSG_HISTORY_FILE; else process.env.OSG_HISTORY_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
