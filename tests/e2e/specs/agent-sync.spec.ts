import { test, expect } from '../fixtures/test';
import type { TauriHarness } from '../fixtures/tauri';

let nextId = 0;
async function call(tauri: TauriHarness, name: string, args: Record<string, unknown>, agent: boolean) {
  const id = ++nextId;
  const callId = `agent-sync-${id}`;
  await tauri.emitFromBackend('abs-mcp-request', {
    callId, nonce: 'e2e-bridge-nonce', agent,
    message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const reply = async () => (await tauri.callsTo('abs_mcp_respond')).find((item) => item.args.callId === callId);
  await expect.poll(async () => !!(await reply()), { timeout: 30_000 }).toBe(true);
  const response = (await reply())!.args.response as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '' };
}

test('built-in agent previews and pauses the open project account sync', async ({ app, page, tauri, isDesktop }) => {
  test.skip(!isDesktop, 'The built-in agent uses the desktop MCP bridge');
  await app.startBlankProject();
  await page.evaluate(() => localStorage.setItem('open-screenshot-generator.account', JSON.stringify({ provider: 'github', account: { id: 'fixture-user', name: 'Fixture' }, accessToken: 'fixture-only-token' })));
  await page.reload();
  await app.waitForBoot();
  const projects = await call(tauri, 'list_projects', {}, true);
  const project = JSON.parse(projects.text).find((entry: { open: boolean }) => entry.open);
  expect(project?.id).toBeTruthy();
  await page.evaluate((projectId) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('ProjectDatabase');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('accountLinks', 'readwrite');
      tx.objectStore('accountLinks').put({ projectId, provider: 'github', accountId: 'fixture-user', remoteId: 'fixture-secret-remote', stamp: 'test', docHash: null, savedAt: new Date(1000), lastPushedName: 'Fixture', autoSync: true });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), project.id);
  expect((await call(tauri, 'get_project_sync_status', {}, false)).isError).toBe(true);
  const status = await call(tauri, 'get_project_sync_status', {}, true);
  expect(status.isError, status.text).toBe(false);
  expect(JSON.parse(status.text).account.connected).toBe(true);
  expect(status.text).not.toContain('fixture-only-token');
  const preview = await call(tauri, 'pause_project_account_sync', { projectId: project.id }, true);
  expect(preview.isError, preview.text).toBe(false);
  const plan = JSON.parse(preview.text);
  expect(plan).toMatchObject({ dryRun: true, expectedEnabled: true, mayFinishInFlight: true });
  expect(preview.text).not.toContain('fixture-secret-remote');
  const applied = await call(tauri, 'pause_project_account_sync', { ...plan, dryRun: false, confirmed: true }, true);
  expect(applied.isError, applied.text).toBe(false);
  const enabled = await page.evaluate((projectId) => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('ProjectDatabase');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('accountLinks').objectStore('accountLinks').get(projectId);
      read.onsuccess = () => { resolve(read.result.autoSync); db.close(); };
      read.onerror = () => reject(read.error);
    };
  }), project.id);
  expect(enabled).toBe(false);
});
