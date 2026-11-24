import test from 'node:test';
import assert from 'node:assert/strict';
import { agentResult } from '../../cli/src/agentContract';

test('agent contract wraps one or multiple command results with a request ID', () => {
  assert.deepEqual(agentResult('r1', 0, [{ project: 'p1' }]), {
    exitCode: 0, body: { ok: true, data: { project: 'p1' }, meta: { schema_version: 1, request_id: 'r1' } },
  });
  assert.deepEqual(agentResult('r2', 0, [1, 2]).body, { ok: true, data: [1, 2], meta: { schema_version: 1, request_id: 'r2' } });
});

test('agent contract preserves inspection errors and distinguishes verification from permission', () => {
  const error = { code: 'not_found', message: 'Missing', retryable: false };
  assert.deepEqual(agentResult('r3', 4, [{ ok: false, error, meta: { schema_version: 1 } }]), {
    exitCode: 4, body: { ok: false, error, meta: { schema_version: 1, request_id: 'r3' } },
  });
  const verify = agentResult('r4', 3, [{ issues: ['bad size'] }]);
  assert.equal(verify.exitCode, 2);
  assert.deepEqual(verify.body, { ok: false, error: { code: 'verification_failed', message: 'Verification failed.', retryable: false, details: { issues: ['bad size'] } }, meta: { schema_version: 1, request_id: 'r4' } });
});
