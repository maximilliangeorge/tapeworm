import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig, resolveConfig } from '../src/config.ts';
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

test('legacy segments normalise to typed steps; the resolved timeline is always Step[]', () => {
  const r = resolveConfig({
    url: BASE.url,
    timeline: [{ at: 'top', hold: 1 }, { to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 }],
  });
  assert.deepEqual(r.timeline, [
    { type: 'start', at: 'top', hold: 1 },
    { type: 'move', to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 },
  ]);
});

test('a typed timeline passes through; a leading non-start step gets an implicit start at top', () => {
  const r = resolveConfig({
    url: BASE.url,
    timeline: [{ type: 'move', to: 'bottom' }, { type: 'hold', seconds: 1 }],
  });
  assert.deepEqual(r.timeline[0], { type: 'start', at: 'top', hold: 0 });
  assert.deepEqual(r.timeline[1], { type: 'move', to: 'bottom' });
  assert.deepEqual(r.timeline[2], { type: 'hold', seconds: 1 });
});

test('click and hover steps are accepted; wait is still format-only', () => {
  const r = resolveConfig({
    url: BASE.url,
    timeline: [
      { at: 'top' },
      { type: 'click', target: { selector: '.cta' }, settle: 1 },
      { type: 'hover', target: { selector: '.menu' } },
    ],
  });
  assert.deepEqual(r.timeline[1], { type: 'click', target: { selector: '.cta' }, settle: 1 });
  assert.deepEqual(r.timeline[2], { type: 'hover', target: { selector: '.menu' } });
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, { type: 'wait', seconds: 1 }] }),
    /not executable yet.*will work unchanged/s,
  );
});

test('interactions need an element target and a sane settle', () => {
  for (const target of ['top', 1200, undefined] as const) {
    assert.throws(
      () => resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, { type: 'click', target } as never] }),
      /needs a "target" element anchor/,
      String(target),
    );
  }
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, { type: 'click', target: { selector: '.x' }, settle: -1 }] }),
    /"settle" must be seconds/,
  );
});

// Frame N shows whatever earlier clicks did to the page — interactive
// timelines are path-dependent, so they cannot shard, same as prewarm cache/none.
test('an interactive timeline forces jobs=1', () => {
  const r = resolveConfig({
    url: BASE.url,
    jobs: 4,
    timeline: [{ at: 'top' }, { type: 'click', target: { selector: '.cta' } }, { to: 'bottom' }],
  });
  assert.equal(r.jobs, 1);
});

test('malformed steps fail with the index and the problem', () => {
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, { type: 'start', at: 'top' }] }),
    /timeline\[1\].*only valid as the first/,
  );
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: [{ type: 'hold' } as never] }),
    /"seconds" >= 0/,
  );
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: [{ type: 'teleport' } as never] }),
    /unknown step type "teleport"/,
  );
  assert.throws(
    () => resolveConfig({ url: BASE.url, timeline: ['top' as never] }),
    /timeline\[0\] must be an object/,
  );
});

test('the start step can pin the url: used when config.url is absent, must agree when both exist', () => {
  const timeline = [
    { type: 'start', at: 'top', url: 'https://example.com/about' },
    { type: 'move', to: 'bottom' },
  ] as const;
  const r = resolveConfig({ timeline: [...timeline] } as never);
  assert.equal(r.url, 'https://example.com/about');

  assert.equal(
    resolveConfig({ url: 'https://example.com/about', timeline: [...timeline] }).url,
    'https://example.com/about',
    'agreement is fine',
  );
  assert.throws(
    () => resolveConfig({ url: 'https://example.com/other', timeline: [...timeline] }),
    /disagree.*authored against one of them/s,
  );
  assert.throws(() => resolveConfig({ timeline: [{ at: 'top' }, { to: 'bottom' }] } as never), /needs a "url"/);
});

test('anchors carry fallbackText through normalisation', () => {
  const r = resolveConfig({
    url: BASE.url,
    timeline: [{ at: 'top' }, { to: { selector: '#pricing', fallbackText: 'Pricing' } }],
  });
  const move = r.timeline[1];
  assert.ok(move.type === 'move' && typeof move.to === 'object' && move.to.fallbackText === 'Pricing');
});

test('parseConfig parses raw text (the stdin path) with the same tolerances as loadConfig', () => {
  const cfg = parseConfig(`{
    // pasted from the extension's Copy command heredoc
    "url": "https://example.com",
    "timeline": [{ "at": "top" }, { "to": "bottom" },],
  }`, 'stdin');
  assert.equal(cfg.url, 'https://example.com');
  assert.throws(() => parseConfig('{ nope }', 'stdin'), /not valid JSON \(stdin\)/);
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
