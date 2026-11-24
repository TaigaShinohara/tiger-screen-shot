import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../../cli/src/args';
import { run } from '../../cli/src/commands/deliver';
import { isCompletePng } from '../../cli/src/delivery/png';
import { deflateSync } from 'node:zlib';
import { readDeliveryPlan, sha256 } from '../../cli/src/delivery/spec';
import { configureOutput } from '../../cli/src/log';
import type { CommandContext } from '../../cli/src/context';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFJ8AAAAASUVORK5CYII=', 'base64');
function testPng(width: number, height: number): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(root: string) {
  const capture = path.join(root, 'screen.png');
  fs.writeFileSync(capture, png);
  const project = path.join(root, 'project.json');
  fs.writeFileSync(project, JSON.stringify({ id: 'p1', projectData: [{ id: 'board1', elements: [{ id: 'e1', type: 'device', screenshotSrc: `data:image/png;base64,${png.toString('base64')}` }] }] }));
  const spec = path.join(root, 'spec.json');
  const value = { version: 1, name: 'Example', groups: [{ id: 'iphone', store: 'appstore', format: 'ios', locale: 'ja', projectLocale: null, project, screens: [{ id: 'home', boardId: 'board1', input: capture, inputFormat: 'ios', inputLocale: 'ja', claim: 'Home screen' }] }] };
  fs.writeFileSync(spec, JSON.stringify(value));
  return { capture, project, spec, value };
}
async function invoke(root: string, argv: string[]) {
  const args = parseArgs(['deliver', ...argv]);
  const ctx = { args, loaded: { config: {}, file: null, root }, config: {}, root, json: true, offline: true, outDir: root, projectFile: '', session: async () => { throw new Error('unexpected browser'); }, dispose: async () => {} } as unknown as CommandContext;
  const original = process.stdout.write;
  let output = '';
  configureOutput({ json: true, quiet: true });
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { const code = await run(ctx); return { code, result: JSON.parse(output) }; }
  finally { process.stdout.write = original; configureOutput({}); }
}
function review(root: string, f: ReturnType<typeof fixture>) {
  const work = path.join(root, 'work');
  const image = 'images/iphone/01-home.png', thumbnail = 'thumbnails/iphone/01-home.png';
  const rendered = testPng(1206, 2622), thumb = testPng(240, 522);
  for (const [rel, bytes] of [[image, rendered], [thumbnail, thumb]] as const) { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), bytes); }
  const item = { group: 'iphone', screen: 'home', boardId: 'board1', store: 'appstore', format: 'ios', locale: 'ja', order: 1, claim: 'Home screen', source: f.capture, sourceSha256: sha256(png), file: image, sha256: sha256(rendered), thumbnail, thumbnailSha256: sha256(thumb), width: 1206, height: 2622 };
  fs.writeFileSync(path.join(work, 'delivery-workspace.json'), JSON.stringify({ version: 1, status: 'review_required', plan: readDeliveryPlan(f.spec), items: [item] }));
  const checks = Object.fromEntries(['actualScreen', 'claimAccurate', 'readableFullSize', 'readableThumbnail', 'noClipping', 'appropriateDevice', 'noPlaceholder'].map((key) => [key, true]));
  const result = { version: 1, reviewer: 'ai', items: [{ group: 'iphone', screen: 'home', sha256: item.sha256, thumbnailSha256: item.thumbnailSha256, notes: 'Reviewed both views', checks }] };
  const reviewFile = path.join(root, 'review.json');
  fs.writeFileSync(reviewFile, JSON.stringify(result));
  return { work, item, result, reviewFile, rendered };
}

test('delivery dry run reads inputs but writes nothing and binds exact captures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-delivery-plan-'));
  try {
    const f = fixture(root); const before = fs.readdirSync(root).sort();
    const output = await invoke(root, ['prepare', '--spec', f.spec, '--work', path.join(root, 'work'), '--dry-run']);
    assert.equal(output.code, 0); assert.equal(output.result.status, 'planned');
    assert.equal(output.result.plan.groups[0].screens[0].sha256, sha256(png));
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    fs.writeFileSync(f.capture, Buffer.from('different'));
    assert.throws(() => readDeliveryPlan(f.spec), /does not contain the exact input/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('delivery rejects missing boards, wrong store formats and languages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-delivery-invalid-'));
  try {
    const f = fixture(root);
    f.value.groups[0].screens[0].boardId = 'missing'; fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /missing/);
    f.value.groups[0].screens[0].boardId = 'board1'; f.value.groups[0].format = 'android'; fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /does not match/);
    f.value.groups[0].format = 'ios'; f.value.groups[0].projectLocale = 'en'; fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /languages differ/);
    f.value.groups[0].projectLocale = null; f.value.groups[0].screens[0].inputFormat = 'android'; fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /Input screenshot format differs/);
    f.value.groups[0].screens[0].inputFormat = 'ios'; f.value.groups[0].screens[0].inputLocale = 'en'; fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /Input screenshot language differs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('delivery requires a complete review of unchanged images and refuses extra files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-delivery-finish-'));
  try {
    const f = fixture(root), r = review(root, f), out = path.join(root, 'out');
    const args = ['finish', '--work', r.work, '--review', r.reviewFile, '--out', out];
    r.result.items[0].checks.noClipping = false; fs.writeFileSync(r.reviewFile, JSON.stringify(r.result));
    await assert.rejects(invoke(root, args), /incomplete/); assert.equal(fs.existsSync(out), false);
    r.result.items[0].checks.noClipping = true; fs.writeFileSync(r.reviewFile, JSON.stringify(r.result));
    fs.writeFileSync(path.join(r.work, 'unexpected.png'), png);
    await assert.rejects(invoke(root, args), /Unexpected workspace file/); assert.equal(fs.existsSync(out), false);
    fs.unlinkSync(path.join(r.work, 'unexpected.png'));
    fs.writeFileSync(path.join(r.work, r.item.file), 'changed');
    await assert.rejects(invoke(root, args), /changed since preparation/); assert.equal(fs.existsSync(out), false);
    fs.writeFileSync(path.join(r.work, r.item.file), r.rendered);
    // Even a matching, edited workspace/review hash must not make corrupt PNG bytes deliverable.
    const corrupt = Buffer.from(r.rendered); corrupt[20] ^= 1;
    fs.writeFileSync(path.join(r.work, r.item.file), corrupt);
    const workFile = path.join(r.work, 'delivery-workspace.json');
    const workspace = JSON.parse(fs.readFileSync(workFile, 'utf8'));
    workspace.items[0].sha256 = sha256(corrupt); fs.writeFileSync(workFile, JSON.stringify(workspace));
    r.result.items[0].sha256 = sha256(corrupt); fs.writeFileSync(r.reviewFile, JSON.stringify(r.result));
    await assert.rejects(invoke(root, args), /PNG and store checks/); assert.equal(fs.existsSync(out), false);
    fs.writeFileSync(path.join(r.work, r.item.file), r.rendered);
    workspace.items[0].sha256 = sha256(r.rendered); fs.writeFileSync(workFile, JSON.stringify(workspace));
    r.result.items[0].sha256 = sha256(r.rendered); fs.writeFileSync(r.reviewFile, JSON.stringify(r.result));
    const done = await invoke(root, args);
    assert.equal(done.code, 0); assert.equal(done.result.status, 'delivered');
    assert.equal(fs.existsSync(path.join(out, 'appstore/ios/ja/01-home.png')), true);
    const delivered = JSON.parse(fs.readFileSync(path.join(out, 'delivery-manifest.json'), 'utf8')).files[0];
    assert.equal(delivered.sourceSha256, sha256(png));
    assert.equal(delivered.thumbnail, 'review-thumbnails/iphone/01-home.png');
    assert.equal(sha256(fs.readFileSync(path.join(out, delivered.thumbnail))), delivered.thumbnailSha256);
    await assert.rejects(invoke(root, args), /EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('PNG integrity rejects truncated chunks and incorrect CRCs', () => {
  const known = fs.readFileSync(path.join(process.cwd(), 'public/data/projects/nookly-focus-screen-1.png'));
  assert.equal(isCompletePng(known), true);
  assert.equal(isCompletePng(known.subarray(0, 33)), false);
  assert.equal(isCompletePng(Buffer.concat([known, Buffer.from([0])])), false);
  const changed = Buffer.from(known); changed[20] ^= 1;
  assert.equal(isCompletePng(changed), false);
});


test('delivery preview refuses duplicate targets and missing source images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-delivery-missing-'));
  try {
    const f = fixture(root);
    const other = structuredClone(f.value.groups[0]); other.id = 'second';
    f.value.groups.push(other); fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /Duplicate destination/);
    f.value.groups.pop();
    const screen = structuredClone(f.value.groups[0].screens[0]); screen.id = 'duplicate'; screen.boardId = 'board2';
    f.value.groups[0].screens.push(screen); fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /Duplicate input screenshot/);
    f.value.groups[0].screens.pop(); f.value.groups[0].screens[0].input = path.join(root, 'missing.png'); fs.writeFileSync(f.spec, JSON.stringify(f.value));
    assert.throws(() => readDeliveryPlan(f.spec), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
