import { flagBool, flagString, type ParsedArgs } from './args.js';
import { usageError } from './errors.js';
import { DESTRUCTIVE_DESIGN_TOOLS } from '@/lib/mcp/toolSafety';

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
  if (flags.timeout !== undefined && !['import', 'render', 'video', 'desktop-call'].includes(command)) {
    throw usageError(`--timeout is not supported by osg ${command}.`);
  }
  if (flags['dry-run'] === undefined) return;
  const deliveryPreview = command === 'deliver' && (!positionals[0] || positionals[0] === 'prepare');
  const cachePrune = command === 'cache' && positionals[0]?.toLowerCase() === 'prune';
  const csvImport = command === 'localize' && !!flagString(flags, 'csv-in') &&
    !flags.add && !flags.base && !flags.text && !flags['csv-out'] && !flagBool(flags, 'translate');
  if (command !== 'upload' && !cachePrune && !csvImport && !deliveryPreview) {
    throw usageError(`--dry-run is not supported for this osg ${command} operation.`,
      'Supported operations: deliver prepare, upload, cache prune, and localize --csv-in without other writes.');
  }
}

export function requireToolConfirmation(tools: string[], confirmed: boolean): void {
  const destructive = tools.filter((tool) => DESTRUCTIVE_DESIGN_TOOLS.has(tool));
  if (destructive.length && !confirmed) {
    throw usageError(`Destructive tool calls require --yes: ${destructive.join(', ')}.`, 'Review the target and pass --yes to run them.');
  }
}

export function confirmedToolArgs(tool: string, args: Record<string, unknown>, confirmed: boolean): Record<string, unknown> {
  return confirmed && DESTRUCTIVE_DESIGN_TOOLS.has(tool) ? { ...args, confirmed: true } : args;
}
