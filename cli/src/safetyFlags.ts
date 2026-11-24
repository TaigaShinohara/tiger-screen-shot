import { flagBool, flagString, type ParsedArgs } from './args.js';
import { usageError } from './errors.js';

export function validateSafetyFlags(args: ParsedArgs): void {
  const { command, flags, positionals } = args;
  for (const name of ['idempotency-key']) {
    if (flags[name] !== undefined) throw usageError(`--${name} is not supported by osg ${command}.`);
  }
  if (flags.yes !== undefined && !['edit', 'call', 'cache', 'upload'].includes(command)) {
    throw usageError(`--yes is not supported by osg ${command}.`);
  }
  if (flags.yes !== undefined && command === 'cache' && positionals[0]?.toLowerCase() !== 'prune') {
    throw usageError('--yes is only supported by osg cache prune.');
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

const DESTRUCTIVE_TOOLS = new Set(['delete_artboard', 'delete_element', 'delete_asset', 'remove_locales', 'reset_locale_overrides', 'apply_template']);

export function requireToolConfirmation(tools: string[], confirmed: boolean): void {
  const destructive = tools.filter((tool) => DESTRUCTIVE_TOOLS.has(tool));
  if (destructive.length && !confirmed) {
    throw usageError(`Destructive tool calls require --yes: ${destructive.join(', ')}.`, 'Review the target and pass --yes to run them.');
  }
}
