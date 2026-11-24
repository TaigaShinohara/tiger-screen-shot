import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVersionRestore, previewVersionRestore, type RestorePorts, type RestoreState } from '@/lib/versions/restore';
import type { ArtboardState } from '@/types/artboard';

function setup() {
  let state: RestoreState = { projectId: 'p1', loadedProjectId: 'p1', projectName: 'Project', openToken: 1, boards: [{ id: 'current' } as ArtboardState], liveEditing: false };
  let saved = true;
  let duringSave: (() => void) | undefined;
  let commits = 0;
  const version = { boards: [{ id: 'old' } as ArtboardState], projectName: 'Project', meta: { id: 'v1', projectId: 'p1', label: 'Earlier', kind: 'named' as const, createdAt: new Date(0), projectName: 'Project', boards: 1, encoding: 'none' as const, bytes: 5, assetIds: [] } };
  const ports: RestorePorts = { state: () => state, read: async () => version, canOpen: (boards) => boards.length > 0, saveSafety: async () => { duringSave?.(); return saved; }, commit: () => { commits++; return true; } };
  return { ports, setState: (next: RestoreState) => { state = next; }, getState: () => state, failSafety: () => { saved = false; }, onSave: (fn: () => void) => { duringSave = fn; }, get commits() { return commits; } };
}

test('a version restore requires the original project and a matching preview', async () => {
  const fixture = setup();
  const preview = await previewVersionRestore('p1', 'v1', fixture.ports);
  fixture.setState({ ...fixture.getState(), projectName: 'Changed' });
  await assert.rejects(applyVersionRestore('p1', 'v1', preview.expectedPlan, fixture.ports), /changed/);
  await assert.rejects(previewVersionRestore('p2', 'v1', fixture.ports), /Open that project/);
  assert.equal(fixture.commits, 0);
});

test('a restore is refused when the safety version fails or edits arrive during it', async () => {
  const fixture = setup();
  const preview = await previewVersionRestore('p1', 'v1', fixture.ports);
  fixture.failSafety();
  await assert.rejects(applyVersionRestore('p1', 'v1', preview.expectedPlan, fixture.ports), /safety version/);
  const race = setup();
  const racePreview = await previewVersionRestore('p1', 'v1', race.ports);
  race.onSave(() => race.setState({ ...race.getState(), openToken: 2 }));
  await assert.rejects(applyVersionRestore('p1', 'v1', racePreview.expectedPlan, race.ports), /changed/);
  assert.equal(fixture.commits + race.commits, 0);
});

test('a confirmed unchanged restore saves a safety version and reports pending persistence', async () => {
  const fixture = setup();
  const preview = await previewVersionRestore('p1', 'v1', fixture.ports);
  const result = await applyVersionRestore('p1', 'v1', preview.expectedPlan, fixture.ports);
  assert.equal(fixture.commits, 1);
  assert.equal(result.safetyVersionSaved, true);
  assert.equal(result.persistence, 'pending');
});
