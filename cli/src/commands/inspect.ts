import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { projectDataOf } from '../projectDocument.js';
import { historyFile, readHistory } from '../history.js';
import { emit } from '../log.js';

class InspectError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number) { super(message); }
}

function project(file: string): { value: unknown; boards: unknown[] } {
  let source: string;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InspectError('not_found', 'Project file not found.', 4);
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') throw new InspectError('permission_denied', 'Cannot read the project file.', 3);
    throw new InspectError('read_failed', 'Could not read the project file.', 2);
  }
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new InspectError('invalid_project', 'Project file is not valid JSON.', 1); }
  const boards = projectDataOf(value);
  if (!boards) throw new InspectError('invalid_project', 'Project has no projectData array.', 1);
  return { value, boards };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function runInspection(args: ParsedArgs, version: string): number {
  const requestId = randomUUID();
  try {
    const allowed = new Set(args.command === 'history' ? ['json', 'limit'] : ['json', 'project']);
    for (const flag of Object.keys(args.flags)) if (!allowed.has(flag)) throw new InspectError('unsupported_flag', `--${flag} is not supported by ${args.command}.`, 1);
    if (args.flags.json !== undefined && !flagBool(args.flags, 'json')) throw new InspectError('unsupported_flag', 'This command returns JSON.', 1);
    if (args.flags.project !== undefined && !flagString(args.flags, 'project')) throw new InspectError('invalid_argument', '--project needs a path.', 1);
    const file = path.resolve(flagString(args.flags, 'project') ?? 'osg/project.json');
    let data: unknown;
    if (args.command === 'history') {
      if (args.positionals.length) throw new InspectError('invalid_argument', 'history takes no positional arguments.', 1);
      const rawLimit = flagString(args.flags, 'limit') ?? '50';
      if (args.flags.limit !== undefined && !flagString(args.flags, 'limit')) throw new InspectError('invalid_argument', '--limit needs a number.', 1);
      if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500) throw new InspectError('invalid_argument', '--limit must be between 1 and 500.', 1);
      data = { file: historyFile(), ...readHistory(Number(rawLimit)) };
    } else if (args.command === 'status') {
      if (args.positionals.length) throw new InspectError('invalid_argument', 'status takes no positional arguments.', 1);
      let state: 'present' | 'missing';
      try { fs.accessSync(file, fs.constants.F_OK); state = 'present'; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = 'missing';
        else if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new InspectError('permission_denied', 'Cannot access the project path.', 3);
        else throw new InspectError('read_failed', 'Could not check the project path.', 2);
      }
      data = { app: 'tiger screen shot', version, project_file: file, project_file_state: state, scope: 'exported_project_file', config_loaded: false };
    } else {
      if (args.command === 'list' && args.positionals.length) throw new InspectError('invalid_argument', 'list takes no positional arguments.', 1);
      if (args.command === 'get' && args.positionals.length !== 1) throw new InspectError('invalid_argument', 'get needs one artboard ID.', 1);
      const doc = project(file);
      if (args.command === 'list') {
        const root = object(doc.value);
        data = { project: { id: typeof root?.id === 'string' ? root.id : null, name: typeof root?.name === 'string' ? root.name : null }, artboards: doc.boards.map((value) => {
          const board = object(value);
          return { id: typeof board?.id === 'string' ? board.id : null, name: typeof board?.name === 'string' ? board.name : null, element_count: Array.isArray(board?.elements) ? board.elements.length : null };
        }) };
      } else {
        const matches = doc.boards.filter((value) => object(value)?.id === args.positionals[0]);
        if (!matches.length) throw new InspectError('not_found', 'Artboard ID not found.', 4);
        if (matches.length > 1) throw new InspectError('ambiguous_id', 'Artboard ID occurs more than once.', 1);
        data = { artboard: matches[0] };
      }
    }
    emit({ ok: true, data, meta: { schema_version: 1, request_id: requestId } });
    return 0;
  } catch (error) {
    const issue = error instanceof InspectError ? error : new InspectError('read_failed', 'Could not read the requested data.', 2);
    emit({ ok: false, error: { code: issue.code, message: issue.message, retryable: false }, meta: { schema_version: 1, request_id: requestId } });
    return issue.exitCode;
  }
}
