import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext } from '../../cli/src/context';
import { parseArgs } from '../../cli/src/args';
import { findTemplate, run as fill } from '../../cli/src/commands/fill';
import { run as verify } from '../../cli/src/commands/verify';
import { localeOf } from '../../cli/src/verify/locales';
import { configureOutput } from '../../cli/src/log';
import type { Project } from '@/types/artboard';

const repo = process.cwd();

function png(width = 1206, height = 2622): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

async function jsonRun(command: typeof verify, root: string, argv: string[], config = {}) {
  const args = parseArgs(argv);
  const ctx = {
    args, config, loaded: { config, file: null, root }, root, json: true, offline: true,
    projectFile: path.join(root, 'osg/project.json'), outDir: root,
    session: async () => { throw new Error('This command must not open a browser'); },
    dispose: async () => {},
  } as CommandContext;
  const write = process.stdout.write;
  let output = '';
  configureOutput({ json: true, quiet: true });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await command(ctx);
    return { code, result: JSON.parse(output) };
  } finally {
    process.stdout.write = write;
    configureOutput({});
    await ctx.dispose();
  }
}

test('fill accepts Taiga ids and JSON filenames from a fixed local catalog outside the checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-fill-test-'));
  try {
    const shots = path.join(root, 'shots');
    fs.mkdirSync(shots);
    for (let index = 1; index <= 5; index++) fs.writeFileSync(path.join(shots, `${index}.png`), png());
    for (const style of ['taiga-md3', 'taiga-glass']) {
      const name = `${style}.json`;
      const template = JSON.parse(fs.readFileSync(path.join(repo, 'public/data/projects', name), 'utf8'));
      const project = { ...template, id: `template_${style}`, sourceId: template.id } as Project;
      for (const wanted of [style, name, `template_${style}`, `template_${style}.json`]) {
        assert.equal(findTemplate([project], wanted), project);
      }
      const { code, result } = await jsonRun(fill, root,
        ['fill', '--screenshots', shots, '--template', name, '--format', 'ios', '--offline', '--force', '--json'],
        { templatesDir: path.join(repo, 'public/data/projects'), store: 'appstore' });
      assert.equal(code, 0);
      assert.equal(result.template.id, `template_${style}`);
      const slots = template.projectData.flatMap((board: { elements: { type: string }[] }) => board.elements).filter((element: { type: string }) => element.type === 'device').length;
      assert.equal(result.placed, slots);
      const written = JSON.parse(fs.readFileSync(path.join(root, 'osg/project.json'), 'utf8'));
      assert.equal(written.projectData.length, 5);
      assert.equal(written.projectData[0].size.width, 1206);
      assert.equal(written.projectData[0].size.height, 2622);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locale detection reads web prefixes and desktop folders without treating board names as languages', () => {
  assert.equal(localeOf('ja_01_Hero.png'), 'ja');
  assert.equal(localeOf('en-US_01_Hero.png'), 'en-US');
  assert.equal(localeOf('screenshots/en-US/01_Hero.png'), 'en-US');
  assert.equal(localeOf('01_en-US_Hero.png'), null);
  assert.equal(localeOf('Hero_01.png'), null);
});

test('verify counts six Japanese and six English screenshots as separate sets in one folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-verify-test-'));
  try {
    for (const locale of ['ja', 'en-US']) {
      for (let index = 1; index <= 6; index++) fs.writeFileSync(path.join(root, `${locale}_${index}_Hero.png`), png());
    }
    const { code, result } = await jsonRun(verify, root, ['verify', root, '--json']);
    assert.equal(code, 0);
    assert.equal(result.sets.length, 2);
    assert.deepEqual(result.sets.map((set: { files: number }) => set.files), [6, 6]);
    assert.equal(result.summary.failures, 0);
    assert.equal(result.summary.warnings, 0);
    for (let index = 7; index <= 11; index++) fs.writeFileSync(path.join(root, `en-US_${index}_Hero.png`), png());
    const excessive = await jsonRun(verify, root, ['verify', root, '--json']);
    assert.equal(excessive.code, 3);
    assert.equal(excessive.result.sets.filter((set: { level: string }) => set.level === 'fail').length, 1);
    assert.match(excessive.result.sets.find((set: { level: string }) => set.level === 'fail').label, /en-US/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify checks required iPhone sizes per language and can require the selected format', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-required-test-'));
  try {
    fs.writeFileSync(path.join(root, 'ja_01_Hero.png'), png());
    fs.writeFileSync(path.join(root, 'en-US_01_Hero.png'), png(1290, 2796));
    const ordinary = await jsonRun(verify, root, ['verify', root, '--json']);
    assert.equal(ordinary.code, 0);
    assert.equal(ordinary.result.listing.length, 1);
    assert.match(ordinary.result.listing[0].message, /^en-US:/);
    const strict = await jsonRun(verify, root, ['verify', root, '--json', '--locales', 'ja,en-US', '--formats', 'ios']);
    assert.equal(strict.code, 3);
    assert.equal(strict.result.listing.filter((finding: { code: string }) => finding.code === 'set-required-format-missing').length, 1);
    fs.unlinkSync(path.join(root, 'en-US_01_Hero.png'));
    const absent = await jsonRun(verify, root, ['verify', root, '--json', '--locales', 'ja,en-US']);
    assert.equal(absent.code, 3);
    assert.ok(absent.result.listing.some((finding: { code: string }) => finding.code === 'set-too-few'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify enforces Play minimum counts per language and preserves unprefixed filenames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-play-test-'));
  try {
    fs.writeFileSync(path.join(root, 'ja_01_Hero.png'), png(1080, 1920));
    fs.writeFileSync(path.join(root, 'ja_02_Hero.png'), png(1080, 1920));
    fs.writeFileSync(path.join(root, 'en-US_01_Hero.png'), png(1080, 1920));
    const short = await jsonRun(verify, root, ['verify', root, '--json', '--store', 'play']);
    assert.equal(short.code, 3);
    assert.equal(short.result.sets.filter((set: { level: string }) => set.level === 'fail').length, 1);
    fs.rmSync(root, { recursive: true });
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '01_Hero.png'), png());
    const plain = await jsonRun(verify, root, ['verify', root, '--json']);
    assert.equal(plain.code, 0);
    assert.equal(plain.result.sets.length, 1);
    assert.equal(plain.result.files[0].locale, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('verify strict treats warnings as failures while preserving the warning details', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-verify-strict-'));
  try {
    const image = png();
    image[24] = 16;
    fs.writeFileSync(path.join(root, '01_Hero.png'), image);
    const ordinary = await jsonRun(verify, root, ['verify', root, '--json']);
    assert.equal(ordinary.code, 0);
    assert.equal(ordinary.result.ok, true);
    assert.equal(ordinary.result.summary.warnings, 1);
    const strict = await jsonRun(verify, root, ['verify', root, '--json', '--strict']);
    assert.equal(strict.code, 3);
    assert.equal(strict.result.ok, false);
    assert.equal(strict.result.strict, true);
    assert.equal(strict.result.summary.failures, 0);
    assert.equal(strict.result.files[0].findings[0].code, 'png-bit-depth');
    const disabled = await jsonRun(verify, root, ['verify', root, '--json', '--no-strict']);
    assert.equal(disabled.code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('fill can refuse a template that cannot place every input without overwriting a project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-fill-all-'));
  try {
    const shots = path.join(root, 'shots');
    const project = path.join(root, 'osg/project.json');
    fs.mkdirSync(shots);
    fs.mkdirSync(path.dirname(project));
    fs.writeFileSync(project, 'original project');
    for (let index = 1; index <= 5; index++) fs.writeFileSync(path.join(shots, `${index}.png`), png());
    const args = ['fill', '--screenshots', shots, '--template', 'taiga-md3', '--format', 'ios', '--offline', '--force', '--json'];
    const config = { templatesDir: path.join(repo, 'public/data/projects'), store: 'appstore' };
    await assert.rejects(jsonRun(fill, root, [...args, '--require-all'], config), /1 of 5 screenshots do not fit/);
    assert.equal(fs.readFileSync(project, 'utf8'), 'original project');
    const partial = await jsonRun(fill, root, args, config);
    assert.equal(partial.result.placed, 4);
    assert.deepEqual(partial.result.unusedScreenshots, ['shots/5.png']);
    fs.unlinkSync(path.join(shots, '5.png'));
    const complete = await jsonRun(fill, root, [...args, '--require-all'], config);
    assert.equal(complete.code, 0);
    assert.deepEqual(complete.result.unusedScreenshots, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
