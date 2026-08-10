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
  assert.equal(r.page.embeds, 'sync');
  assert.equal(r.page.unlockIntro.enabled, true);
  assert.ok(r.jobs >= 1);
});

test('page.embeds follows page.video unless set explicitly', () => {
  assert.equal(resolveConfig({ ...BASE, page: { video: 'freeze' } }).page.embeds, 'freeze');
  assert.equal(resolveConfig({ ...BASE, page: { video: 'ignore' } }).page.embeds, 'ignore');
  const split = resolveConfig({ ...BASE, page: { video: 'sync', embeds: 'freeze' } });
  assert.equal(split.page.video, 'sync');
  assert.equal(split.page.embeds, 'freeze');
});

test('page.video and page.embeds reject unknown modes', () => {
  assert.throws(
    () => resolveConfig({ ...BASE, page: { video: 'syncc' as never } }),
    /page.video must be sync, freeze or ignore/,
  );
  assert.throws(
    () => resolveConfig({ ...BASE, page: { embeds: 'pause' as never } }),
    /page.embeds must be sync, freeze or ignore/,
  );
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

// A minimal valid recording at the default 1280×800 viewport.
const REC = {
  type: 'record' as const,
  samples: { t: [0, 500, 1000], x: [100, 200, 300], y: [50, 60, 70], s: [0, 40, 100] },
  buttons: [{ t: 400, action: 'down' as const }, { t: 600, action: 'up' as const }],
  viewport: { width: 1280, height: 800, dpr: 2 },
};

test('record steps are accepted and pass through verbatim', () => {
  const r = resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, REC] });
  assert.deepEqual(r.timeline[1], REC);
  assert.deepEqual(r.page.cursor, { image: null, tipX: 5, tipY: 3, size: 22 }, 'drawn cursor defaults to the built-in arrow');
  assert.equal(resolveConfig({ url: BASE.url, page: { cursor: false }, timeline: [{ at: 'top' }, REC] }).page.cursor, false);
});

test('a recording forces jobs=1: replayed input is path-dependent', () => {
  const r = resolveConfig({ url: BASE.url, jobs: 4, timeline: [{ at: 'top' }, REC] });
  assert.equal(r.jobs, 1);
});

test('a recording made at a different viewport is refused, not scaled', () => {
  assert.throws(
    () => resolveConfig({ url: BASE.url, viewport: { width: 1440, height: 900 }, timeline: [{ at: 'top' }, REC] }),
    /recorded at 1280×800.*render viewport is 1440×900|made at 1280×800/,
  );
  // and the message says what to do about it
  assert.throws(
    () => resolveConfig({ url: BASE.url, viewport: { width: 1440, height: 900 }, timeline: [{ at: 'top' }, REC] }),
    /Set viewport to the recorded size, or re-record/,
  );
});

test('malformed recordings fail with the index and the defect', () => {
  const bad = (over: Record<string, unknown>, re: RegExp) =>
    assert.throws(() => resolveConfig({ url: BASE.url, timeline: [{ at: 'top' }, { ...REC, ...over } as never] }), re);

  bad({ samples: undefined }, /timeline\[1\].*parallel number arrays/);
  bad({ samples: { t: [0, 100], x: [0], y: [0, 0], s: [0, 0] } }, /same length.*x=1/);
  bad({ samples: { t: [0], x: [0], y: [0], s: [0] } }, /at least 2 entries/);
  bad({ samples: { t: [0, 500, 400], x: [0, 0, 0], y: [0, 0, 0], s: [0, 0, 0] } }, /non-decreasing \(sample 2 goes 500 → 400\)/);
  bad({ buttons: [{ t: 400, action: 'up' }] }, /must begin with a "down"/);
  bad({ buttons: [{ t: 4000, action: 'down' }] }, /outside the recording/);
  bad({ buttons: [{ t: 400, action: 'press' }] }, /buttons\[0\] must be/);
  bad({ viewport: undefined }, /needs the "viewport" it was recorded at/);
  bad({ hold: -1 }, /"hold" must be seconds >= 0/);
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

test('page.substitute: validated and resolved; local files must exist at config time', () => {
  assert.equal(resolveConfig(BASE).page.substitute.length, 0);

  const sub = (substitute: unknown) =>
    resolveConfig({ ...BASE, page: { substitute } } as unknown as Config);

  assert.throws(() => sub('nope'), /must be an array/);
  assert.throws(() => sub([{ from: '*/hero.mp4' }]), /page\.substitute\[0\] must be/);
  assert.throws(() => sub([{ from: '', to: 'https://example.com/a.mp4' }]), /page\.substitute\[0\] must be/);
  assert.throws(() => sub([{ from: '*/hero.mp4', to: './no-such-file.mp4' }]), /replacement file not found/);
  assert.throws(
    () => sub([{ from: '*/hero.mp4', to: 'http://cdn.example.com/a.mp4' }]),
    /can't be given an http:\/\/ replacement/,
  );

  // A remote replacement passes through untouched; a local one resolves absolute.
  const dir = mkdtempSync(join(tmpdir(), 'tapeworm-test-'));
  try {
    const file = join(dir, 'other.mp4');
    writeFileSync(file, 'x');
    const r = sub([
      { from: '*/hero.mp4', to: 'https://example.com/other.mp4' },
      { from: '*/promo.webm', to: file },
    ]);
    assert.deepEqual(r.page.substitute[0], { from: '*/hero.mp4', to: 'https://example.com/other.mp4' });
    assert.equal(r.page.substitute[1].to, file);
    assert.throws(() => sub([{ from: '*', to: dir }]), /replacement is a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('page.cursor: a replacement image is validated and embedded at config time', () => {
  const cur = (cursor: unknown) =>
    resolveConfig({ ...BASE, page: { cursor } } as unknown as Config).page.cursor;

  assert.throws(() => cur({}), /"page\.cursor" must be/);
  assert.throws(() => cur({ image: '' }), /"page\.cursor" must be/);
  assert.throws(() => cur({ image: './no-such-cursor.png' }), /file not found/);
  assert.throws(() => cur({ image: 'https://example.com/c.png', tip: [5] }), /tip must be \[x, y\]/);
  assert.throws(() => cur({ image: 'https://example.com/c.png', tip: [-1, 0] }), /tip must be \[x, y\]/);
  assert.throws(() => cur({ image: 'https://example.com/c.png', size: 0 }), /size must be/);
  assert.throws(() => cur({ image: 'http://example.com/c.png' }), /can't load an http:\/\/ image/);

  // Remote and data: URLs pass through; tip and size default to top-left, 32px.
  assert.deepEqual(cur({ image: 'https://example.com/c.png' }),
    { image: 'https://example.com/c.png', tipX: 0, tipY: 0, size: 32 });
  assert.deepEqual(cur({ image: 'data:image/png;base64,AAAA', tip: [4, 6], size: 48 }),
    { image: 'data:image/png;base64,AAAA', tipX: 4, tipY: 6, size: 48 });

  // A local file becomes a data: URI — a typo'd path fails here, not mid-render.
  const dir = mkdtempSync(join(tmpdir(), 'tapeworm-test-'));
  try {
    const file = join(dir, 'hand.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = cur({ image: file });
    assert.ok(r && r.image === `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
    const odd = join(dir, 'hand.tiff');
    writeFileSync(odd, 'x');
    assert.throws(() => cur({ image: odd }), /can't tell the image type/);
    assert.throws(() => cur({ image: dir }), /is a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
