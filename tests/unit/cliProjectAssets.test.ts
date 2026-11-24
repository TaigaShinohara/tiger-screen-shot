import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProjectAssets, projectFileFingerprint, writeProjectAtomically } from '../../cli/src/projectAssets';

test('editing refuses missing bundled images and fonts before touching a project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-assets-'));
  const file = path.join(root, 'project.json');
  try {
    const project = { projectData: [{ elements: [{ screenshotSrc: 'asset:screen' }, { fontFamily: 'Imported' }] }], media: [{ id: 'screen' }], mediaData: {}, fonts: [{ id: 'font', family: 'Imported' }], fontData: {} };
    const write = () => fs.writeFileSync(file, JSON.stringify(project));
    write(); const before = fs.readFileSync(file);
    assert.throws(() => assertProjectAssets(file), /media screen/);
    assert.deepEqual(fs.readFileSync(file), before);
    project.mediaData = { screen: 'aW1hZ2U=' }; write();
    assert.throws(() => assertProjectAssets(file), /font Imported/);
    project.fontData = { font: 'Zm9udA==' }; write();
    assert.doesNotThrow(() => assertProjectAssets(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('atomic project save refuses an external change and preserves the newer file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-project-save-'));
  const file = path.join(root, 'project.json');
  try {
    fs.writeFileSync(file, 'before');
    const expected = projectFileFingerprint(file);
    fs.writeFileSync(file, 'changed by another editor');
    assert.throws(() => writeProjectAtomically(file, 'our old result', expected), /changed while editing/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed by another editor');
    assert.deepEqual(fs.readdirSync(root), ['project.json']);
    writeProjectAtomically(file, 'new result', projectFileFingerprint(file));
    assert.equal(fs.readFileSync(file, 'utf8'), 'new result');
    const fresh = path.join(root, 'new.json');
    writeProjectAtomically(fresh, 'new file', null);
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'new file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
