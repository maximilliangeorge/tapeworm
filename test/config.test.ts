import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfig } from '../src/config.ts';
import type { Config } from '../src/types.ts';

const BASE: Config = { url: 'https://example.com', timeline: [{ at: 'top' }, { to: 'bottom' }] };

test('minimal config gets documented defaults', () => {
  const r = resolveConfig(BASE);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 800);
  assert.equal(r.dpr, 2);
  assert.equal(r.fps, 60);
  assert.equal(r.codec, 'h264');
  assert.equal(r.crf, 12);
  assert.ok(r.outPath.endsWith('out.mp4'));
  assert.equal(r.prewarm.mode, 'full');
  assert.equal(r.page.clock, 'virtual');
  assert.equal(r.page.video, 'sync');
  assert.equal(r.page.unlockIntro.enabled, true);
  assert.ok(r.jobs >= 1);
});

test('url is required and must parse', () => {
  assert.throws(() => resolveConfig({} as Config), /needs a "url"/);
  assert.throws(() => resolveConfig({ ...BASE, url: 'not a url' }), /not a valid URL/);
});

test('dpr must be an integer 1-4', () => {
  for (const dpr of [1.5, 0, 5]) {
    assert.throws(() => resolveConfig({ ...BASE, viewport: { dpr } }), /dpr must be an integer/);
  }
  assert.equal(resolveConfig({ ...BASE, viewport: { dpr: 3 } }).dpr, 3);
});

test('fps bounds', () => {
  assert.throws(() => resolveConfig({ ...BASE, fps: 0 }), /fps must be/);
  assert.throws(() => resolveConfig({ ...BASE, fps: 500 }), /fps must be/);
});

test('codec inferred from extension; png output becomes a directory path', () => {
  assert.equal(resolveConfig({ ...BASE, output: { path: 'x.mov' } }).codec, 'prores');
  const png = resolveConfig({ ...BASE, output: { path: 'frames.png' } });
  assert.equal(png.codec, 'png');
  assert.ok(png.outPath.endsWith('frames'), 'png strips the extension');
  const bare = resolveConfig({ ...BASE, output: { path: 'clip', codec: 'prores' } });
  assert.ok(bare.outPath.endsWith('clip.mov'), 'missing extension is added from codec');
});

test('prewarm legacy aliases map to modes', () => {
  assert.equal(resolveConfig({ ...BASE, prewarm: { enabled: false } }).prewarm.mode, 'none');
  assert.equal(resolveConfig({ ...BASE, prewarm: { reloadAfter: true } }).prewarm.mode, 'cache');
  assert.equal(
    resolveConfig({ ...BASE, prewarm: { mode: 'full', reloadAfter: true } }).prewarm.mode,
    'full',
    'explicit mode beats the alias',
  );
});

// Reveal state depends on the scroll path taken, so cache/none cannot shard.
test('prewarm cache/none force jobs=1; full respects jobs', () => {
  assert.equal(resolveConfig({ ...BASE, jobs: 4, prewarm: { mode: 'cache' } }).jobs, 1);
  assert.equal(resolveConfig({ ...BASE, jobs: 4, prewarm: { enabled: false } }).jobs, 1);
  assert.equal(resolveConfig({ ...BASE, jobs: 3 }).jobs, 3);
});

test('needs a timeline or auto', () => {
  assert.throws(() => resolveConfig({ url: BASE.url }), /needs a "timeline"/);
  const auto = resolveConfig({ url: BASE.url, auto: true });
  assert.deepEqual(auto.auto, { maxSections: 6 });
  assert.deepEqual(resolveConfig({ url: BASE.url, auto: { maxSections: 9 } }).auto, { maxSections: 9 });
});

test('loadConfig tolerates // comments and trailing commas, rejects garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeworm-test-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, `{
      // a hand-edited config
      "url": "https://example.com",
      "timeline": [{ "at": "top" }, { "to": "bottom" },],
    }`);
    assert.equal(loadConfig(good).url, 'https://example.com');

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ url: nope }');
    assert.throws(() => loadConfig(bad), /not valid JSON/);
    assert.throws(() => loadConfig(join(dir, 'missing.json')), /cannot read config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
