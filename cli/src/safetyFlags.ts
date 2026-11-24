import { flagBool, flagString, type ParsedArgs } from './args.js';
import { usageError } from './errors.js';

export function validateSafetyFlags(args: ParsedArgs): void {
  const { command, flags, positionals } = args;
  for (const name of ['yes', 'idempotency-key']) {
    if (flags[name] !== undefined) throw usageError(`--${name} is not supported by osg ${command}.`);
  }
  if (flags.timeout !== undefined && !['import', 'render', 'video'].includes(command)) {
    throw usageError(`--timeout is not supported by osg ${command}.`);
  }
  if (flags['dry-run'] === undefined) return;
  const cachePrune = command === 'cache' && positionals[0]?.toLowerCase() === 'prune';
  const csvImport = command === 'localize' && !!flagString(flags, 'csv-in') &&
    !flags.add && !flags.base && !flags.text && !flags['csv-out'] && !flagBool(flags, 'translate');
  if (command !== 'upload' && !cachePrune && !csvImport) {
    throw usageError(`--dry-run is not supported for this osg ${command} operation.`,
      'Supported operations: upload, cache prune, and localize --csv-in without other writes.');
  }
}
