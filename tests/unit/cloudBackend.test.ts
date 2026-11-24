import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(resolve('infra/vps/pb-hooks/060_projects.pb.js'), 'utf8');
const assetSource = readFileSync(resolve('infra/vps/pb-hooks/lib/cloudAssets.js'), 'utf8');
const sharingSource = readFileSync(resolve('infra/vps/pb-hooks/lib/cloudSharing.js'), 'utf8');

function backend() {
  const routes = new Map<string, (event: unknown) => { status: number; body: unknown }>();
  let writes = 0;
  let creates = 0;
  let assetWrites = 0;
  let exists = true;
  const assets: Array<{ getString: (key: string) => string; getInt: (key: string) => number }> = [];
  const fields: Record<string, unknown> = {
    owner: 'owner', project_id: 'local', updated: 'stamp', asset_bytes: 0, visibility: 'private', share_slug: '',
  };
  const row = {
    id: 'record',
    getString: (key: string) => String(fields[key] ?? ''),
    getInt: (key: string) => Number(fields[key] ?? 0),
    getDateTime: (key: string) => ({ string: () => String(fields[key]) }),
    set: (key: string, value: unknown) => { fields[key] = value; },
  };
  const tx = {
    save: (record: unknown) => {
      if (record === row) { writes++; fields.updated = `saved-${writes}`; }
      else { assetWrites++; if (!assets.includes(record as typeof assets[number])) assets.push(record as typeof assets[number]); }
    },
    delete: () => {},
    findCollectionByNameOrId: (name: string) => name,
  };
  const app = {
    runInTransaction: (callback: (value: typeof tx) => void) => callback(tx),
    findFirstRecordByFilter: () => { if (!exists) throw new Error('missing'); return row; },
    findRecordsByFilter: () => [],
    findCollectionByNameOrId: (name: string) => name,
    save: tx.save,
  };
  const helpers = {
    settings: () => ({
      cloud_projects_enabled: true, writes_enabled: true, max_cloud_doc_bytes: 1000, max_cloud_projects: 30,
      max_cloud_asset_bytes: 1000, max_cloud_project_bytes: 1000, max_cloud_user_bytes: 1000,
    }),
    authUser: () => ({ user: { id: 'owner' } }),
    clampText: (value: unknown, max: number) => String(value ?? '').slice(0, max),
    formValue: (event: { form: Record<string, string> }, key: string) => event.form[key] ?? '',
    readBody: (event: { body: Record<string, unknown> }) => event.body,
    newShareSlug: () => 'new-secret-slug',
    ownedProject: (database: unknown, id: string, owner: string) => {
      assert.equal(database, tx);
      return exists && id === row.id && fields.owner === owner ? row : null;
    },
    projectAssets: () => assets,
    cloudBytesForUser: () => 0,
    cloudProjectOf: () => ({ id: row.id, updated: fields.updated }),
  };
  function record(collection: string) {
    creates++;
    if (collection !== 'cloud_project_assets') return row;
    const values: Record<string, unknown> = {};
    return {
      getString: (key: string) => String(values[key] ?? ''),
      getInt: (key: string) => Number(values[key] ?? 0),
      set: (key: string, value: unknown) => { values[key] = value; },
    };
  }
  const assetModule = { exports: {} };
  runInNewContext(assetSource, { module: assetModule, Record: record, console });
  const sharingModule = { exports: {} };
  runInNewContext(sharingSource, { module: sharingModule });
  runInNewContext(source, {
    routerAdd: (method: string, path: string, handler: (event: unknown) => { status: number; body: unknown }) => routes.set(`${method} ${path}`, handler),
    require: (path: string) => path.endsWith('/cloudAssets.js') ? assetModule.exports : path.endsWith('/cloudSharing.js') ? sharingModule.exports : helpers,
    __hooks: '/hooks', $app: app, $apis: { bodyLimit: () => {} }, console, Record: record,
  });
  function request(method = 'PUT', changes: Record<string, string> = {}) {
    return routes.get(`${method} /api/openscreengen/projects${method === 'PUT' ? '/{id}' : ''}`)!({
      form: { project_id: 'local', expected_record_id: 'record', expected_updated: 'stamp', ...changes },
      request: { pathValue: () => 'record' },
      findUploadedFiles: () => [{ size: 2 }],
      json: (status: number, body: unknown) => ({ status, body }),
    });
  }
  function upload(changes: Record<string, string> = {}, method = 'PUT') {
    return routes.get(`${method} /api/openscreengen/projects/{id}/assets`)!({
      form: {
        project_id: 'local', expected_record_id: 'record', expected_updated: 'stamp', asset_id: 'image', ...changes,
      },
      request: { pathValue: () => 'record' },
      findUploadedFiles: () => [{ size: 2 }],
      json: (status: number, body: unknown) => ({ status, body }),
    });
  }
  function share(changes: Record<string, unknown> = {}) {
    return routes.get('PUT /api/openscreengen/projects/{id}/share-conditional')!({
      body: { projectId: 'local', expectedUpdated: 'stamp', on: true, ...changes },
      request: { pathValue: () => 'record' }, json: (status: number, body: unknown) => ({ status, body }),
    });
  }
  return {
    fields, request, upload, share, remove: () => { exists = false; },
    writes: () => writes, creates: () => creates, assetWrites: () => assetWrites,
  };
}

test('conditional sharing rejects stale revisions and never rotates an already shared link', () => {
  for (const invalid of [{ projectId: '' }, { expectedUpdated: '' }, { on: 'true' }]) {
    const server = backend();
    assert.equal(server.share(invalid).status, 400);
    assert.equal(server.writes(), 0);
  }
  const wrongProject = backend();
  assert.equal(wrongProject.share({ projectId: 'other' }).status, 404);
  assert.equal(wrongProject.writes(), 0);
  const wrongOwner = backend();
  wrongOwner.fields.owner = 'other';
  assert.equal(wrongOwner.share().status, 404);
  assert.equal(wrongOwner.writes(), 0);
  const stale = backend();
  stale.fields.updated = 'other';
  assert.equal(stale.share().status, 409);
  assert.equal(stale.writes(), 0);
  const server = backend();
  assert.equal(server.share().status, 200);
  assert.equal(server.fields.visibility, 'link');
  assert.equal(server.writes(), 1);
  assert.equal(server.share({ expectedUpdated: 'saved-1' }).status, 200);
  assert.equal(server.writes(), 1);
  assert.equal(server.fields.share_slug, 'new-secret-slug');
  assert.equal(server.share({ expectedUpdated: 'stamp', on: false }).status, 409);
  assert.equal(server.fields.visibility, 'link');
  assert.equal(server.share({ expectedUpdated: 'saved-1', on: false }).status, 200);
  assert.equal(server.fields.visibility, 'private');
});

test('conditional cloud updates match the record, account, project and saved revision before writing', () => {
  const scenarios = [
    (server: ReturnType<typeof backend>) => { server.remove(); return 404; },
    (server: ReturnType<typeof backend>) => { server.fields.owner = 'other'; return 404; },
    (server: ReturnType<typeof backend>) => { server.fields.project_id = 'other'; return 404; },
    (server: ReturnType<typeof backend>) => { server.fields.updated = 'newer'; return 409; },
  ];
  for (const arrange of scenarios) {
    const server = backend();
    const expected = arrange(server);
    assert.equal(server.request().status, expected);
    assert.equal(server.writes(), 0);
    assert.equal(server.creates(), 0);
  }
});

test('conditional cloud updates reject missing or mismatched preconditions', () => {
  const cases: Array<Record<string, string>> = [{ expected_updated: '' }, { expected_record_id: 'other' }];
  for (const fields of cases) {
    const server = backend();
    assert.equal(server.request('PUT', fields).status, 400);
    assert.equal(server.writes(), 0);
  }
});

test('only the first automatic update can write against the same saved revision', () => {
  const server = backend();
  assert.equal(server.request().status, 200);
  assert.equal(server.request().status, 409);
  assert.equal(server.writes(), 1);
  assert.equal(server.creates(), 0);
});

test('manual saves retain the create route when no cloud row exists', () => {
  const server = backend();
  server.remove();
  assert.equal(server.request('POST').status, 200);
  assert.equal(server.creates(), 1);
  assert.equal(server.writes(), 1);
});

test('a delayed asset cannot advance the revision after another device saved its document', () => {
  const server = backend();
  assert.equal(server.request().status, 200);
  server.fields.doc = 'B document';
  server.fields.updated = 'B revision';
  assert.equal(server.upload({ expected_updated: 'saved-1' }).status, 409);
  assert.equal(server.fields.doc, 'B document');
  assert.equal(server.fields.updated, 'B revision');
  assert.equal(server.writes(), 1);
  assert.equal(server.assetWrites(), 0);
});

test('asset uploads confirm and advance only the document save revision chain', () => {
  const server = backend();
  const first = server.upload();
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(first.body)), {
    assetId: 'image', size: 2, assetBytes: 2, previousUpdated: 'stamp', updated: 'saved-1',
  });
  assert.equal(server.upload({ expected_updated: 'saved-1', asset_id: 'second' }).status, 200);
  assert.equal(server.upload({ expected_updated: 'stamp' }).status, 409);
  assert.equal(server.writes(), 2);
  assert.equal(server.assetWrites(), 2);
});

test('asset updates reject a different record, account, project or missing revision', () => {
  for (const change of ['account', 'project', 'record', 'revision', 'missing']) {
    const server = backend();
    if (change === 'account') server.fields.owner = 'other';
    if (change === 'project') server.fields.project_id = 'other';
    if (change === 'missing') server.remove();
    const form = change === 'record' ? { expected_record_id: 'other' }
      : change === 'revision' ? { expected_updated: '' } : {};
    assert.equal(server.upload(form as Record<string, string>).status, change === 'record' || change === 'revision' ? 400 : 404);
    assert.equal(server.assetWrites(), 0);
    assert.equal(server.writes(), 0);
  }
});

test('legacy manual asset uploads keep their POST route and response', () => {
  const server = backend();
  const result = server.upload({ expected_updated: '' }, 'POST');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body)), {
    assetId: 'image', size: 2, assetBytes: 2, updated: 'saved-1',
  });
});
