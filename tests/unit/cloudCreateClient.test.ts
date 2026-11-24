import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a create-only cloud request never falls back to the legacy upsert', async () => {
  const previousUrl = process.env.NEXT_PUBLIC_DISCOVER_URL;
  process.env.NEXT_PUBLIC_DISCOVER_URL = 'https://fixture.invalid';
  const { cloudApi } = await import('@/lib/cloud/api');
  const { setDiscoverSession } = await import('@/lib/discover/session');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined }> = [];
  try {
    setDiscoverSession({ token: 'fixture-only', viewer: { id: 'fixture', name: 'Fixture' } as never, provider: 'github', accountId: 'fixture' });
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ error: 'missing' }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const input = { projectId: 'p1', name: 'Fixture', boards: 1, formatVersion: 1, doc: new Blob(['fixture']), docEncoding: 'none' as const, manifestAssets: [], createOnly: true };
    await assert.rejects(cloudApi.saveProject({ ...input, expectedRecordId: 'r', expectedUpdated: 'rev' }));
    assert.equal(calls.length, 0);
    await assert.rejects(cloudApi.saveProject(input));
    assert.deepEqual(calls, [{ url: 'https://fixture.invalid/api/openscreengen/projects/create-only', method: 'POST' }]);
  } finally {
    globalThis.fetch = originalFetch;
    setDiscoverSession(null);
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_DISCOVER_URL;
    else process.env.NEXT_PUBLIC_DISCOVER_URL = previousUrl;
  }
});
