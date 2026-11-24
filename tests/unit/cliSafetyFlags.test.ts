import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseArgs } from '../../cli/src/args';
import { validateSafetyFlags } from '../../cli/src/safetyFlags';

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
    ['upload', '--dry-run'],
    ['cache', 'prune', '--dry-run'],
    ['localize', '--csv-in', 'copy.csv', '--dry-run'],
  ]) assert.doesNotThrow(() => validateSafetyFlags(parseArgs(argv)));
});

test('rejects unsupported safety and timeout flags', () => {
  for (const argv of [
    ['edit', '--yes'], ['new', '--idempotency-key', 'key'], ['edit', '--timeout', '2'],
  ]) assert.throws(() => validateSafetyFlags(parseArgs(argv)), /not supported/);
  assert.doesNotThrow(() => validateSafetyFlags(parseArgs(['render', '--timeout', '2'])));
});
