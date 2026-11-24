export interface AgentFailure {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function agentResult(requestId: string, exitCode: number, output: unknown[], thrown?: AgentFailure) {
  const meta = { schema_version: 1, request_id: requestId };
  const single = output.length === 1 ? output[0] : output.length ? output : null;
  const old = single && typeof single === 'object' && !Array.isArray(single) ? single as Record<string, unknown> : null;
  const isInspection = old?.meta && typeof old.meta === 'object' && 'schema_version' in old.meta && typeof old.ok === 'boolean';
  if (exitCode === 0 && !thrown) return { exitCode: 0, body: { ok: true, data: isInspection ? old?.data : single, meta } };
  const oldError = isInspection && old?.error && typeof old.error === 'object' ? old.error as AgentFailure : undefined;
  const failure: AgentFailure = thrown ?? oldError ?? {
    code: exitCode === 1 ? 'invalid_argument' : exitCode === 3 ? 'verification_failed' : exitCode === 4 ? 'not_found' : 'execution_failed',
    message: exitCode === 3 ? 'Verification failed.' : 'The command could not be completed.',
    retryable: false,
    ...(single === null ? {} : { details: single }),
  };
  const normalizedExit = failure.code === 'not_found' ? 4 : failure.code === 'permission_denied' ? 3
    : exitCode === 1 ? 1 : 2;
  return { exitCode: normalizedExit, body: { ok: false, error: failure, meta } };
}
