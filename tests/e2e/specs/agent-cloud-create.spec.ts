import { test, expect } from '../fixtures/test';
import type { TauriHarness } from '../fixtures/tauri';

let sequence = 0;
async function call(tauri: TauriHarness, name: string, args: Record<string, unknown>, agent = true) {
  const id = ++sequence;
  const callId = `cloud-create-${id}`;
  await tauri.emitFromBackend('abs-mcp-request', { callId, nonce: 'e2e-bridge-nonce', agent, message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
  const reply = async () => (await tauri.callsTo('abs_mcp_respond')).find((entry) => entry.args.callId === callId);
  await expect.poll(async () => !!await reply()).toBe(true);
  const response = (await reply())!.args.response as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '' };
}

test('a first cloud save uses the create-only endpoint and records the private copy', async ({ app, page, tauri, isDesktop }) => {
  test.skip(!isDesktop || process.env.E2E_CLOUD_FIXTURE !== '1', 'Requires the desktop bridge and the isolated cloud fixture build');
  await app.startBlankProject();
  await page.evaluate(() => {
    localStorage.setItem('open-screenshot-generator.account', JSON.stringify({ provider: 'github', account: { id: 'fixture-account', name: 'Fixture' }, accessToken: 'fixture-only' }));
    localStorage.setItem('open-screenshot-generator.discover.session', JSON.stringify({ token: 'fixture-only', viewer: { id: 'fixture-viewer', name: 'Fixture' }, provider: 'github', accountId: 'fixture-account' }));
  });
  await page.reload();
  await app.waitForBoot();
  const projects = await call(tauri, 'list_projects', {});
  const project = JSON.parse(projects.text).find((item: { open: boolean }) => item.open);
  expect(project?.id).toBeTruthy();
  let sends = 0;
  await page.route('https://fixture.invalid/api/openscreengen/projects/create-only', async (route) => {
    sends += 1;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project: { id: 'fixture-record', projectId: project.id, name: project.name, boards: 1, docBytes: 1, assetBytes: 0, formatVersion: 1, docEncoding: 'none', visibility: 'private', created: '2026-11-24T00:00:00Z', updated: '2026-11-24T00:00:00Z', shareSlug: '' }, missing: [] }) });
  });
  const args = { projectId: project.id };
  expect((await call(tauri, 'create_project_cloud_copy', args, false)).isError).toBe(true);
  const preview = await call(tauri, 'create_project_cloud_copy', args);
  expect(preview.isError, preview.text).toBe(false);
  const plan = JSON.parse(preview.text);
  expect(plan).toMatchObject({ dryRun: true, sendsProject: true, visibility: 'private' });
  expect(sends).toBe(0);
  expect((await call(tauri, 'create_project_cloud_copy', { ...args, dryRun: false, confirmed: true, expectedPlan: 'wrong' })).isError).toBe(true);
  expect(sends).toBe(0);
  const saved = await call(tauri, 'create_project_cloud_copy', { ...args, dryRun: false, confirmed: true, expectedPlan: plan.expectedPlan });
  expect(saved.isError, saved.text).toBe(false);
  expect(JSON.parse(saved.text)).toMatchObject({ saved: true, complete: true, visibility: 'private' });
  expect(sends).toBe(1);
  expect((await call(tauri, 'create_project_cloud_copy', args)).isError).toBe(true);
  expect(sends).toBe(1);
});
