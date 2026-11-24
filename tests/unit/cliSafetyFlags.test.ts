import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseArgs } from '../../cli/src/args';
import { confirmedToolArgs, requireToolConfirmation, validateSafetyFlags } from '../../cli/src/safetyFlags';
import { run as edit } from '../../cli/src/commands/edit';
import type { CommandContext } from '../../cli/src/context';

test('rejects dry runs that would otherwise perform writes', () => {
  for (const argv of [
    ['edit', '--tool', 'add_element', '--dry-run'],
    ['call', 'add_element', '--save', '--dry-run'],
    ['cache', 'warm', '--dry-run'],
    ['localize', '--translate', '--dry-run'],
    ['localize', '--csv-in', 'copy.csv', '--add', 'ja', '--dry-run'],
    ['localize', '--csv-in', 'copy.csv', '--csv-out', 'out.csv', '--dry-run'],
  ]) assert.throws(() => validateSafetyFlags(parseArgs(argv)), /--dry-run is not supported/);
});

test('accepts only the operations that implement dry run', () => {
  for (const argv of [
    ['deliver', 'prepare', '--dry-run'],
    ['upload', '--dry-run'],
    ['cache', 'prune', '--dry-run'],
    ['localize', '--csv-in', 'copy.csv', '--dry-run'],
  ]) assert.doesNotThrow(() => validateSafetyFlags(parseArgs(argv)));
});

test('rejects unsupported safety and timeout flags', () => {
  for (const argv of [
    ['new', '--yes'], ['new', '--idempotency-key', 'key'], ['edit', '--timeout', '2'],
  ]) assert.throws(() => validateSafetyFlags(parseArgs(argv)), /not supported/);
  assert.doesNotThrow(() => validateSafetyFlags(parseArgs(['render', '--timeout', '2'])));
  assert.doesNotThrow(() => validateSafetyFlags(parseArgs(['edit', '--yes'])));
});

test('checks destructive tools before running any part of a batch', () => {
  assert.throws(() => requireToolConfirmation(['add_element', 'delete_artboard'], false), /--yes/);
  assert.throws(() => requireToolConfirmation(['apply_template'], false), /--yes/);
  assert.doesNotThrow(() => requireToolConfirmation(['add_element'], false));
  assert.doesNotThrow(() => requireToolConfirmation(['delete_artboard'], true));
  assert.deepEqual(confirmedToolArgs('delete_artboard', { artboardId: 'a1' }, true), { artboardId: 'a1', confirmed: true });
  assert.deepEqual(confirmedToolArgs('get_artboard', { artboardId: 'a1' }, true), { artboardId: 'a1' });
});

test('refuses a destructive edit before starting the editor', async () => {
  let started = false;
  const ctx = {
    args: parseArgs(['edit', '--tool', 'delete_artboard', '--args', '{"artboardId":"board-1"}']),
    session: async () => { started = true; throw new Error('Editor must not start'); },
  } as unknown as CommandContext;
  await assert.rejects(edit(ctx), /--yes/);
  assert.equal(started, false);
});
