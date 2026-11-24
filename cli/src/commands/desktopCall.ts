import { flagNumber, flagString } from '../args.js';
import type { CommandContext } from '../context.js';
import { driverError, EXIT, OsgError, usageError } from '../errors.js';
import { emit } from '../log.js';

export async function desktopRequest(port: number, token: string, name: string, args: object, timeout: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout * 1000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch { throw driverError('Could not reach the desktop MCP server.'); }
  if (response.status === 401 || response.status === 403) throw new OsgError('The desktop MCP server refused access.', { code: EXIT.driver, detail: { agentCode: 'permission_denied' } });
  if (!response.ok) throw driverError(`Desktop MCP returned HTTP ${response.status}.`);
  let reply: { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }; error?: { message?: string } };
  try { reply = await response.json() as typeof reply; } catch { throw driverError('Desktop MCP returned an invalid response.'); }
  if (reply.error || !reply.result) throw driverError(reply.error?.message ?? 'Desktop MCP returned no result.');
  if (reply.result.isError) throw driverError(reply.result.content?.find((part) => part.type === 'text')?.text ?? 'The desktop tool failed.');
  const content = reply.result.content;
  if (content?.length === 1 && content[0].type === 'text' && typeof content[0].text === 'string') {
    try { return JSON.parse(content[0].text); } catch { return content[0].text; }
  }
  return reply.result;
}

export async function run(ctx: CommandContext): Promise<number> {
  const allowed = new Set(['port', 'args', 'timeout', 'json', 'config', 'verbose', 'quiet']);
  for (const key of Object.keys(ctx.args.flags)) if (!allowed.has(key)) throw usageError(`--${key} is not supported by desktop-call.`);
  if (ctx.args.passthrough.length) throw usageError('desktop-call does not accept arguments after --.');
  const port = flagNumber(ctx.args.flags, 'port');
  if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw usageError('Pass the desktop MCP port with --port.');
  const timeout = flagNumber(ctx.args.flags, 'timeout') ?? 180;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw usageError('--timeout must be between 0 and 600 seconds.');
  const token = process.env.OSG_DESKTOP_MCP_TOKEN ?? process.env.OSG_MCP_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) throw usageError('Set a desktop MCP bearer token in OSG_DESKTOP_MCP_TOKEN or OSG_MCP_TOKEN.');
  const name = ctx.args.positionals[0];
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name) || ctx.args.positionals.length !== 1) throw usageError('Pass one desktop tool name.');
  if (ctx.args.flags.args !== undefined && flagString(ctx.args.flags, 'args') === undefined) throw usageError('--args needs a JSON object.');
  const raw = flagString(ctx.args.flags, 'args') ?? '{}';
  let args: unknown;
  try { args = JSON.parse(raw); } catch { throw usageError('--args must be a JSON object.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw usageError('--args must be a JSON object.');
  emit(await desktopRequest(port!, token, name, args, timeout));
  return EXIT.ok;
}
