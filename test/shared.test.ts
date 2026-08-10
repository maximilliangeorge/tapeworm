import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * The shared core files are plain scripts that install globals — the same files run
 * in Node (via src/easing.ts), in the injected page runtime, and as extension
 * content scripts. Here they are booted in a vm with a stub DOM.
 */
function bootShared(dom: { queries?: Record<string, unknown[]>; bodyText?: string } = {}) {
  const queries = dom.queries ?? {};
  const window: any = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    scrollTo: ({ top }: { top: number }) => { window.scrollY = top; },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => '\\' + c) },
    document: {
      documentElement: { scrollHeight: 5000 },
      body: { innerText: dom.bodyText ?? '' },
      querySelectorAll: (sel: string) => queries[sel] ?? [],
    },
  };
  window.window = window;
  vm.createContext(window);
  for (const f of ['easing-core.js', 'anchor-core.js', 'selector.js', 'gesture-core.js']) {
    vm.runInContext(readFileSync(new URL(`../src/shared/${f}`, import.meta.url), 'utf8'), window);
  }
  return window;
}

function el(over: Record<string, unknown> = {}) {
  return {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    className: '',
    getAttribute: () => null,
    innerText: '',
    parentElement: null,
    previousElementSibling: null,
    ...over,
  };
}

test('each shared file installs exactly its one global, and nothing needs a build step', () => {
  const w = bootShared();
  assert.equal(typeof w.TapewormEasing.cubicBezier, 'function');
  assert.equal(typeof w.TapewormAnchors.resolveAnchor, 'function');
  assert.equal(typeof w.TapewormSelector.bestSelector, 'function');
  assert.equal(typeof w.TapewormGesture.resample, 'function');
});

// The regression table from the Phase 0 verification: extraction must not have
// changed the numbers the renderer computes durations from.
test('peakSlope table is unchanged after extraction', () => {
  const { TapewormEasing: E } = bootShared();
  const at = (name: string) => Math.round(E.peakSlope(E.resolveEase(name)) * 10_000) / 10_000;
  assert.equal(at('inOutCubic'), 2.857);
  assert.equal(at('inOutQuint'), 5.8779);
  assert.equal(at('outCubic'), 3.024);
});

test('Node imports the very same implementation the page runs', async () => {
  const easing = await import('../src/easing.ts');
  const w = bootShared();
  for (const t of [0.1, 0.33, 0.5, 0.77, 0.9]) {
    assert.equal(easing.resolveEase('inOutQuint')(t), w.TapewormEasing.resolveEase('inOutQuint')(t));
    assert.equal(easing.resolveEase('natural', 3.2)(t), w.TapewormEasing.resolveEase('natural', 3.2)(t));
  }
  assert.equal(easing.MAX_PEAK_VH_PER_SEC, w.TapewormEasing.MAX_PEAK_VH_PER_SEC);
});

test('an authored id wins', () => {
  const features = el({ id: 'features', tagName: 'SECTION', innerText: 'Features' });
  const w = bootShared({ queries: { '#features': [features] } });
  const r = w.TapewormSelector.bestSelector(features);
  assert.equal(r.selector, '#features');
  assert.equal(r.quality, 'id');
  assert.equal(r.unique, true);
  assert.equal(r.fallbackText, 'Features');
});

test('hashed ids and classes are refused: falls through to structural', () => {
  const body = el({ tagName: 'BODY' });
  const target = el({
    id: 'r1a2b3c4d5e6',
    className: 'css-1x2y3z sc-aBcDeF',
    parentElement: body,
  });
  const w = bootShared({ queries: { div: [el(), target, el()] } });
  Object.assign(w.document, { body });
  const r = w.TapewormSelector.bestSelector(target);
  assert.equal(r.quality, 'structural');
  assert.equal(r.unique, false);
  assert.equal(r.nth, 1, 'disambiguated by nth among the matches');
});

test('Tailwind arbitrary values and CSS-module hashes are filtered; stable classes survive', () => {
  // taken from the class soup real builds produce (djernesbell.com's actual markup)
  const a = el({ className: 'text-size-[clamp(64px,4.5vw+1rem,128px)] lg:whitespace-normal flex-column' });
  const b = el({ className: 'Header_nav__aBc12 nav-primary' });
  const w = bootShared({ queries: { 'div.flex-column': [a], 'div.nav-primary': [b] } });
  assert.equal(w.TapewormSelector.bestSelector(a).selector, 'div.flex-column');
  assert.equal(w.TapewormSelector.bestSelector(a).quality, 'class');
  assert.equal(w.TapewormSelector.bestSelector(b).selector, 'div.nav-primary');
});

test("tapeworm's own marker classes are never used in selectors", () => {
  // picking an element while the preview's hover emulation is active must not
  // capture the __tw-hover marker — it only exists during emulation
  const item = el({ tagName: 'SPAN', className: '__tw-hover menu-item' });
  const w = bootShared({ queries: { 'span.menu-item': [item], 'span.__tw-hover': [item] } });
  const r = w.TapewormSelector.bestSelector(item);
  assert.equal(r.selector, 'span.menu-item');
});

test('data attributes beat classes', () => {
  const target = el({
    className: 'hero',
    getAttribute: (n: string) => (n === 'data-testid' ? 'hero-section' : null),
  });
  const w = bootShared({ queries: { '[data-testid="hero-section"]': [target] } });
  const r = w.TapewormSelector.bestSelector(target);
  assert.equal(r.selector, '[data-testid="hero-section"]');
  assert.equal(r.quality, 'data');
});

test('checkSelector validates hand-edits live', () => {
  const target = el();
  const w = bootShared({ queries: { '.a': [el(), target] } });
  const miss = w.TapewormSelector.checkSelector('.missing');
  assert.equal(miss.valid, true);
  assert.equal(miss.count, 0);
  const hit = w.TapewormSelector.checkSelector('.a', target);
  assert.equal(hit.count, 2);
  assert.equal(hit.matchesTarget, true);
  assert.equal(hit.nth, 1);
});

test('describeMiss says whether the content is gone or just re-marked-up', () => {
  const w = bootShared({ bodyText: 'Welcome\nPricing that scales\nFooter' });
  const remarked = w.TapewormAnchors.describeMiss({ selector: '#pricing', fallbackText: 'Pricing that scales' });
  assert.match(remarked, /matched nothing: #pricing/);
  assert.match(remarked, /still on the page.*selector needs updating/);

  const gone = w.TapewormAnchors.describeMiss({ selector: '#pricing', fallbackText: 'Enterprise plan' });
  assert.match(gone, /content itself was removed/);

  const bare = w.TapewormAnchors.describeMiss({ selector: '#pricing', nth: 2 });
  assert.equal(bare, 'selector matched nothing: #pricing [nth=2]');
});

test('resolveAnchor throws the describeMiss message, so the CLI shows the diagnosis', () => {
  const w = bootShared({ bodyText: 'Pricing' });
  assert.throws(
    () => w.TapewormAnchors.resolveAnchor({ selector: '#pricing', fallbackText: 'Pricing' }),
    /still on the page/,
  );
});

/** vm-realm objects carry the vm's Object.prototype, which deepEqual rejects. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// A recording: pointer sweeps right and down over one second while the page
// scrolls 0 → 100, with a click in the middle.
const rec = {
  samples: {
    t: [0, 500, 1000],
    x: [100, 200, 300],
    y: [50, 150, 250],
    s: [0, 40, 100],
  },
  buttons: [
    { t: 400, action: 'down' as const },
    { t: 600, action: 'up' as const },
  ],
};

test('pointerAt interpolates linearly between adjacent samples', () => {
  const { TapewormGesture: G } = bootShared();
  assert.deepEqual(plain(G.pointerAt(rec, 0.25)), { x: 150, y: 100, scroll: 20, down: false });
  assert.deepEqual(plain(G.pointerAt(rec, 0.75)), { x: 250, y: 200, scroll: 70, down: false });
  assert.equal(G.pointerAt(rec, 0.5).down, true, 'inside the down..up window');
});

test('pointerAt clamps to the recorded time range at both ends', () => {
  const { TapewormGesture: G } = bootShared();
  assert.deepEqual(plain(G.pointerAt(rec, -1)), { x: 100, y: 50, scroll: 0, down: false });
  assert.deepEqual(plain(G.pointerAt(rec, 99)), { x: 300, y: 250, scroll: 100, down: false });
});

test('pointerAt survives repeated timestamps without dividing by zero', () => {
  const { TapewormGesture: G } = bootShared();
  const dup = { samples: { t: [0, 100, 100, 200], x: [0, 10, 20, 30], y: [0, 0, 0, 0], s: [0, 0, 0, 0] } };
  const p = G.pointerAt(dup, 0.1);
  assert.ok(Number.isFinite(p.x));
});

test('resample lands the last frame exactly on the recording end', () => {
  const { TapewormGesture: G } = bootShared();
  const { frames } = G.resample(rec, 10);
  assert.equal(frames.length, 10, 'round(1.0s * 10fps)');
  // frame n shows (n+1)/fps, the same convention move steps use
  assert.deepEqual(plain(frames[0]), plain(G.pointerAt(rec, 0.1)));
  assert.deepEqual(plain(frames[9]), { x: 300, y: 250, scroll: 100, down: false });
});

test('resample places edges at their own timestamps, on the frame that first shows them', () => {
  const { TapewormGesture: G } = bootShared();
  const { edges } = G.resample(rec, 10);
  assert.equal(edges.length, 2);
  // down at 400ms → frame 3 (which shows t=0.4s); its x is the pointer AT 400ms
  assert.equal(edges[0].frame, 3);
  assert.equal(edges[0].kind, 'down');
  assert.equal(edges[0].x, 180);
  assert.equal(edges[1].frame, 5);
  assert.equal(edges[1].kind, 'up');
});

test('a sub-frame click keeps both edges, in order, on one frame', () => {
  const { TapewormGesture: G } = bootShared();
  const quick = {
    samples: { t: [0, 2000], x: [0, 100], y: [0, 0], s: [0, 0] },
    buttons: [
      { t: 1010, action: 'down' as const },
      { t: 1020, action: 'up' as const },
    ],
  };
  const { edges } = G.resample(quick, 10);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].frame, edges[1].frame);
  assert.equal(edges[0].kind, 'down');
  assert.equal(edges[1].kind, 'up');
});

test('the frame that dispatches a press also shows the pressed state', () => {
  const { TapewormGesture: G } = bootShared();
  const { frames, edges } = G.resample(rec, 10);
  assert.equal(frames[edges[0].frame].down, true);
});

test('Node imports the very same gesture implementation the page runs', async () => {
  const gesture = await import('../src/gesture.ts');
  const w = bootShared();
  for (const t of [0.1, 0.4, 0.5, 0.9]) {
    assert.deepEqual(gesture.pointerAt(rec, t), plain(w.TapewormGesture.pointerAt(rec, t)));
  }
  assert.deepEqual(gesture.resample(rec, 24), plain(w.TapewormGesture.resample(rec, 24)));
  const smoothedRec = { ...rec, smoothing: true };
  assert.deepEqual(gesture.resample(smoothedRec, 24), plain(w.TapewormGesture.resample({ ...rec, smoothing: true }, 24)));
});

// A 1-second straight sweep sampled at ~60Hz with ±4px alternating y-jitter —
// the shape of real capture noise (hand tremor + integer rounding).
function jitterySweep(buttons?: Array<{ t: number; action: 'down' | 'up' }>) {
  const t: number[] = [], x: number[] = [], y: number[] = [], s: number[] = [];
  for (let i = 0; i <= 60; i++) {
    t.push(i * 16);
    x.push(i * 10);
    y.push(200 + (i % 2 ? 4 : -4));
    s.push(i * 2);
  }
  return { samples: { t, x, y, s }, buttons };
}

test('smoothing is opt-in: absent and false both resolve the raw samples verbatim', () => {
  const { TapewormGesture: G } = bootShared();
  const raw = jitterySweep();
  const off = { ...jitterySweep(), smoothing: false };
  for (const t of [0.32, 0.48, 0.8]) { // sample-aligned times, where the raw jitter peaks
    assert.deepEqual(plain(G.pointerAt(raw, t)), plain(G.pointerAt(off, t)));
    assert.equal(Math.abs(G.pointerAt(raw, t).y - 200), 4, 'the jitter is really there un-smoothed');
  }
});

test('smoothing flattens jitter while keeping the route', () => {
  const { TapewormGesture: G } = bootShared();
  const sm = { ...jitterySweep(), smoothing: true };
  for (const t of [0.3, 0.5, 0.7]) {
    const p = G.pointerAt(sm, t);
    assert.ok(Math.abs(p.y - 200) < 0.5, `mid-take jitter is gone (y=${p.y})`);
    assert.ok(Math.abs(p.x - t * 625) < 1, `the sweep itself is preserved (x=${p.x} at t=${t})`);
  }
});

test('smoothing strength scales the kernel', () => {
  const { TapewormGesture: G } = bootShared();
  const light = { ...jitterySweep(), smoothing: { mode: 'denoise', strength: 0.1 } };
  const strong = { ...jitterySweep(), smoothing: { mode: 'denoise', strength: 1 } };
  const dev = (p: { y: number }) => Math.abs(p.y - 200);
  assert.ok(dev(G.pointerAt(strong, 0.5)) < dev(G.pointerAt(light, 0.5)));
  assert.ok(dev(G.pointerAt(light, 0.5)) < 4, 'even light smoothing reduces the jitter');
});

test('smoothing never touches scroll, timing, or the frame grid', () => {
  const { TapewormGesture: G } = bootShared();
  const raw = jitterySweep();
  const sm = { ...jitterySweep(), smoothing: true };
  assert.equal(G.durationSec(sm), G.durationSec(raw));
  const a = G.resample(raw, 30), b = G.resample(sm, 30);
  assert.equal(b.frames.length, a.frames.length);
  for (let n = 0; n < a.frames.length; n++) {
    assert.equal(b.frames[n].scroll, a.frames[n].scroll);
    assert.equal(b.frames[n].down, a.frames[n].down);
  }
});

test('the take\'s endpoints are bit-exact under smoothing', () => {
  const { TapewormGesture: G } = bootShared();
  const raw = jitterySweep();
  const sm = { ...jitterySweep(), smoothing: true };
  assert.deepEqual(plain(G.pointerAt(sm, 0)), plain(G.pointerAt(raw, 0)));
  assert.deepEqual(plain(G.pointerAt(sm, 99)), plain(G.pointerAt(raw, 99)));
});

test('button edges stay pinned: a press on a sample is bit-exact, off-sample within a pixel', () => {
  const { TapewormGesture: G } = bootShared();
  // on-sample: t=480 is the 30th sample exactly → fully pinned there
  const on = { ...jitterySweep([{ t: 480, action: 'down' }, { t: 496, action: 'up' }]), smoothing: true };
  const rawOn = jitterySweep([{ t: 480, action: 'down' }, { t: 496, action: 'up' }]);
  assert.equal(G.pointerAt(on, 0.48).x, G.pointerAt(rawOn, 0.48).x);
  assert.equal(G.pointerAt(on, 0.48).y, G.pointerAt(rawOn, 0.48).y);
  const { edges } = G.resample(on, 60);
  const { edges: rawEdges } = G.resample(rawOn, 60);
  assert.deepEqual(plain(edges), plain(rawEdges), 'dispatched click coordinates are the recorded ones');
  // off-sample: an edge between samples interpolates two nearly-raw neighbours
  const off = { ...jitterySweep([{ t: 487, action: 'down' }, { t: 503, action: 'up' }]), smoothing: true };
  const rawOff = jitterySweep([{ t: 487, action: 'down' }, { t: 503, action: 'up' }]);
  const d = Math.hypot(
    G.pointerAt(off, 0.487).x - G.pointerAt(rawOff, 0.487).x,
    G.pointerAt(off, 0.487).y - G.pointerAt(rawOff, 0.487).y,
  );
  assert.ok(d < 1, `press lands within a device pixel of the recorded spot (off by ${d})`);
});

test('pinning must not re-expose raw tremor around a click (regression: mouse-up jank)', () => {
  const { TapewormGesture: G } = bootShared();
  // A decelerating approach with sinusoidal hand tremor, clicking at the end —
  // the shape that made the original blend-toward-raw pinning visibly wobble
  // at press/release while the rest of the path was glassy.
  const mk = (smoothing?: boolean) => {
    const t: number[] = [], x: number[] = [], y: number[] = [], s: number[] = [];
    for (let i = 0; i <= 90; i++) {
      const p = Math.min(1, (i * 16) / 700);
      const ease = 1 - Math.pow(1 - p, 3);
      t.push(i * 16);
      x.push(Math.round(100 + 400 * ease + 3 * Math.sin(i * 2.1)));
      y.push(Math.round(300 - 80 * ease + 3 * Math.sin(i * 1.7 + 1)));
      s.push(0);
    }
    const buttons: Array<{ t: number; action: 'down' | 'up' }> = [
      { t: 487, action: 'down' },
      { t: 587, action: 'up' },
    ];
    return smoothing === undefined ? { samples: { t, x, y, s }, buttons } : { samples: { t, x, y, s }, buttons, smoothing };
  };
  // Worst frame-to-frame speed CHANGE across the click (down@487ms → up@587ms
  // at 60fps is frames ~29–35; the window covers both pin ramps).
  const maxJerk = (rec: ReturnType<typeof mk>) => {
    const { frames } = G.resample(rec, 60);
    let prevV: number | null = null, worst = 0;
    for (let n = 26; n <= 40; n++) {
      const v = Math.hypot(frames[n].x - frames[n - 1].x, frames[n].y - frames[n - 1].y);
      if (prevV != null) worst = Math.max(worst, Math.abs(v - prevV));
      prevV = v;
    }
    return worst;
  };
  assert.ok(maxJerk(mk()) > 2, 'the raw tremor is really there — otherwise this test proves nothing');
  assert.ok(maxJerk(mk(true)) < 1, 'smoothed speed through the click changes gradually — no wobble at press or release');
});

test('a drag\'s route is smoothed but its grab and release points hold still', () => {
  const { TapewormGesture: G } = bootShared();
  const buttons: Array<{ t: number; action: 'down' | 'up' }> = [
    { t: 160, action: 'down' },
    { t: 800, action: 'up' },
  ];
  const sm = { ...jitterySweep(buttons), smoothing: true };
  const raw = jitterySweep(buttons);
  const mid = G.pointerAt(sm, 0.48); // deep inside the drag, far from both pins
  assert.equal(mid.down, true);
  assert.ok(Math.abs(mid.y - 200) < 0.5, 'the drag path itself is denoised');
  for (const tMs of [160, 800]) {
    const d = Math.hypot(
      G.pointerAt(sm, tMs / 1000).x - G.pointerAt(raw, tMs / 1000).x,
      G.pointerAt(sm, tMs / 1000).y - G.pointerAt(raw, tMs / 1000).y,
    );
    assert.ok(d < 1e-9, 'grab/release are on samples here, so they are exact');
  }
});
