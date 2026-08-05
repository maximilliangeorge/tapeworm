import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

/**
 * The anti-drift contract: the extension ships src/shared/*.js VERBATIM. Chrome
 * needs real files inside the extension directory, so they're copies — and this
 * test is what makes forgetting to copy a failure instead of a lying picker.
 */
test('extension/shared/*.js are byte-identical to src/shared/*.js (else: npm run sync-shared)', () => {
  const files = readdirSync(new URL('src/shared/', root)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 3, 'expected the shared core files');
  for (const f of files) {
    assert.ok(
      existsSync(new URL(`extension/shared/${f}`, root)),
      `extension/shared/${f} is missing — run: npm run sync-shared`,
    );
    assert.equal(
      read(`extension/shared/${f}`),
      read(`src/shared/${f}`),
      `extension/shared/${f} differs from src/shared/${f} — run: npm run sync-shared`,
    );
  }
});

test('manifest stays review-friendly: minimal permissions, no host permissions, files exist', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'sidePanel', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'no host permissions up front — injection is on demand');
  assert.equal(manifest.content_scripts, undefined, 'content scripts are injected via chrome.scripting, not declared');
  for (const rel of [manifest.background.service_worker, manifest.side_panel.default_path]) {
    assert.ok(existsSync(new URL(`extension/${rel}`, root)), `${rel} missing`);
  }
  // the panel's on-demand injection list must point at real files
  const panel = read('extension/sidepanel/panel.js');
  const injected = [...panel.matchAll(/'((?:shared|content)\/[\w-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(injected.length >= 5, 'expected the injection list in panel.js');
  for (const rel of injected) {
    assert.ok(existsSync(new URL(`extension/${rel}`, root)), `${rel} injected but missing`);
  }
});

test('every extension script parses', () => {
  for (const f of ['background.js', 'content/overlay.js', 'content/bridge.js', 'sidepanel/panel.js']) {
    new vm.Script(read(`extension/${f}`)); // throws on a syntax error
  }
});

// ---------------------------------------------------------------------------
// Boot the overlay in a vm and check its preview geometry uses the renderer's
// exact defaults (start hold 0.8, mid-move hold 0.6, last 0.8, autoDuration).

/** vm-realm objects carry the vm's prototypes, which strict deepEqual rejects. */
function plain<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function fakeEl(): any {
  const el: any = {
    className: '',
    textContent: '',
    style: {},
    title: '',
    children: [] as unknown[],
    innerHTML: '',
  };
  el.appendChild = (c: unknown) => { el.children.push(c); return c; };
  el.append = (...cs: unknown[]) => { el.children.push(...cs); };
  el.remove = () => {};
  el.attachShadow = () => fakeEl();
  return el;
}

function bootOverlay(opts: { maxScroll?: number; queries?: Record<string, unknown[]> } = {}) {
  const docHeight = (opts.maxScroll ?? 4000) + 700; // + innerHeight below
  // Real listener registry + hand-pumped rAF + a settable clock, so the tests
  // can feed the overlay synthetic input exactly like a page would.
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  const rafQueue: Array<(t: number) => void> = [];
  let now = 0;
  const window: any = {
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 2,
    scrollY: 0,
    location: { href: 'https://example.com/' },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    requestAnimationFrame: (cb: (t: number) => void) => rafQueue.push(cb),
    cancelAnimationFrame: () => {},
    performance: { now: () => now },
    scrollTo: ({ top }: { top: number }) => { window.scrollY = top; },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: {
      title: 'Example',
      documentElement: Object.assign(fakeEl(), { scrollHeight: docHeight }),
      body: { innerText: '' },
      createElement: () => fakeEl(),
      querySelectorAll: (sel: string) => (opts.queries ? opts.queries[sel] ?? [] : []),
      elementFromPoint: () => null,
    },
  };
  window.window = window;
  window.__dispatch = (type: string, ev: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  window.__pumpRaf = () => { for (const cb of rafQueue.splice(0)) cb(now); };
  window.__setNow = (ms: number) => { now = ms; };
  vm.createContext(window);
  for (const f of ['easing-core.js', 'anchor-core.js', 'selector.js', 'gesture-core.js']) {
    vm.runInContext(read(`src/shared/${f}`), window);
  }
  vm.runInContext(read('extension/content/overlay.js'), window);
  return window;
}

test('overlay preview geometry matches the renderer: same hold defaults and autoDuration', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  const E = w.TapewormEasing;
  O.mount(() => {});
  O.setSettings({ width: 1280, height: 800, dpr: 2, fps: 60 });

  const steps = [
    { type: 'start', at: 'top', hold: 1 },
    { type: 'move', to: 2000, duration: 2, ease: 'linear' },   // not last: default hold 0.6
    { type: 'hold', seconds: 0.5 },
    { type: 'move', to: 'bottom' },                            // last: default hold 0.8, auto duration
  ];
  const auto = E.autoDuration(4000 - 2000, 800, E.resolveEase(undefined, (4000 - 2000) / 800));
  const { total, errors } = O.duration(steps);
  assert.equal(errors.length, 0);
  assert.ok(Math.abs(total - (1 + 2 + 0.6 + 0.5 + auto + 0.8)) < 1e-9, `total ${total}`);

  // interactions can't run in the preview, but their settle time must still
  // pass or every later timestamp would disagree with the render
  const withClick = O.duration([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'click', target: { selector: '.cta' }, settle: 2 },
    { type: 'hover', target: { selector: '.menu' } },
  ]);
  assert.ok(Math.abs(withClick.total - (1 + 2 + 0.6)) < 1e-9, `total ${withClick.total}`);
});

test('overlay seek lands the same offsets the renderer would', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1280, height: 800 });
  const steps = [
    { type: 'start', at: 'top', hold: 1 },
    { type: 'move', to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 },
  ];
  O.seek(steps, 0.5);
  assert.equal(w.scrollY, 0, 'mid-hold stays at start');
  O.seek(steps, 2);                    // 1s into a 2s linear ramp to 4000
  assert.equal(w.scrollY, 2000);
  O.seek(steps, 99);
  assert.equal(w.scrollY, 4000, 'clamped to the end');
});

test('preview emulates hover: marker class applied at hover time, cleared by later interactions', () => {
  const classes = new Set<string>();
  const menu: any = {
    nodeType: 1,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }),
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
    },
  };
  const w = bootOverlay({ queries: { '.menu': [menu] } });
  const O = w.TapewormOverlay;
  O.mount(() => {});
  const steps = [
    { type: 'start', at: 'top', hold: 1 },
    { type: 'hover', target: { selector: '.menu' }, settle: 1 },
    { type: 'click', target: { selector: '.btn' }, settle: 1 },
  ];
  O.seek(steps, 1.5); // mid-hover-settle
  assert.ok(classes.has('__tw-hover'), 'hover class applied during the hover span');
  O.seek(steps, 2.5); // after the click — the pointer moved away
  assert.ok(!classes.has('__tw-hover'), 'a later interaction ends the hover');
  O.seek(steps, 1.2);
  assert.ok(classes.has('__tw-hover'), 'scrubbing back re-applies it');
  O.stopPreview();
  assert.ok(!classes.has('__tw-hover'), 'stopping the preview clears it');
});

test('record mode: real input is sampled per display frame, ESC finishes with one record:done', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));

  w.__setNow(0);
  assert.deepEqual(plain(O.startRecording()), { recording: true });
  assert.deepEqual(plain(O.startRecording()), { error: 'already-recording' });

  w.__dispatch('pointermove', { clientX: 100.4, clientY: 50.6 });
  w.__pumpRaf(); // sample at t=0
  w.__setNow(100); w.scrollY = 40;
  w.__dispatch('pointerdown', { button: 0, clientX: 110, clientY: 60 });
  w.__pumpRaf(); // t=100, with the press position and the scroll
  w.__setNow(150);
  w.__dispatch('pointerup', { button: 0 });
  w.__pumpRaf();
  w.__setNow(200);
  w.__dispatch('pointermove', { clientX: 130, clientY: 80 });
  w.__pumpRaf();

  let prevented = false;
  w.__dispatch('keydown', {
    key: 'Escape',
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => {},
  });
  assert.ok(prevented, 'ESC is consumed, same as the picker');

  const done = events.filter(([t]) => t === 'record:done');
  assert.equal(done.length, 1, 'exactly one record:done');
  const d = done[0][1];
  assert.deepEqual(plain(d.samples.t), [0, 100, 150, 200]);
  assert.deepEqual(plain(d.samples.x), [100, 110, 110, 130], 'integer-rounded, held between moves');
  assert.deepEqual(plain(d.samples.y), [51, 60, 60, 80]);
  assert.deepEqual(plain(d.samples.s), [0, 40, 40, 40], 'scroll captured per sample');
  assert.deepEqual(plain(d.buttons), [{ t: 100, action: 'down' }, { t: 150, action: 'up' }]);
  assert.deepEqual(plain(d.viewport), { width: 1000, height: 700, dpr: 2 }, 'the ACTUAL window, honestly stamped');
  assert.equal(d.durationMs, 200);

  // listeners are gone: further input goes nowhere
  w.__dispatch('pointermove', { clientX: 999, clientY: 999 });
  w.__pumpRaf();
  assert.equal(events.filter(([t]) => t === 'record:done').length, 1);
});

test('record mode: nothing captured means record:cancelled, not an empty step', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));
  O.startRecording();
  // the pointer never moved — no samples exist
  w.__dispatch('keydown', { key: 'Escape', preventDefault: () => {}, stopImmediatePropagation: () => {} });
  assert.ok(events.some(([t]) => t === 'record:cancelled'));
  assert.ok(!events.some(([t]) => t === 'record:done'));
});

test('record mode and preview playback exclude each other', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  O.mount(() => {});
  const steps = [{ type: 'start', at: 'top', hold: 1 }];

  O.play(steps);
  assert.deepEqual(plain(O.startRecording()), { error: 'preview-playing' }, 'the shield would swallow the input');
  O.stopPreview();

  O.startRecording();
  assert.equal(O.play(steps), null, 'no playback while recording');
  O.stopRecording();
});

// A recording usable in geometry tests: 2s, scroll 0 → 200, pointer drifting right.
const GEO_REC = {
  type: 'record',
  samples: { t: [0, 1000, 2000], x: [100, 200, 300], y: [50, 50, 50], s: [0, 100, 200] },
  viewport: { width: 1000, height: 700, dpr: 2 },
  hold: 0.5,
};

test('preview geometry gives record steps their real duration, and seek replays their scroll', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  const E = w.TapewormEasing;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  const steps = [
    { type: 'start', at: 'top', hold: 1 },
    GEO_REC,
    { type: 'move', to: 'bottom' }, // last: default hold 0.8, auto duration from the recording's end
  ];
  const auto = E.autoDuration(4000 - 200, 700, E.resolveEase(undefined, (4000 - 200) / 700));
  const { total, errors } = O.duration(steps);
  assert.equal(errors.length, 0);
  assert.ok(Math.abs(total - (1 + 2 + 0.5 + auto + 0.8)) < 1e-9, `total ${total}`);

  O.seek(steps, 1.5); // 0.5s into the recording: scroll lerps 0→100
  assert.equal(w.scrollY, 50);
  O.seek(steps, 3.2); // in the record hold: parked at the recording's end
  assert.equal(w.scrollY, 200);
});

test('overlay reports whether the window IS the render viewport — never a scaled stand-in', () => {
  const w = bootOverlay(); // window is 1000×700
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1280, height: 800 });
  assert.equal(O.pageInfo().viewportMatched, false);
  O.setSettings({ width: 1000, height: 700 });
  assert.equal(O.pageInfo().viewportMatched, true);
  assert.deepEqual({ ...O.pageInfo().target }, { width: 1000, height: 700 });
});

test('overlay reports a scroll-gated page instead of hiding it', () => {
  const w = bootOverlay({ maxScroll: 0 });
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((type: string, data: any) => events.push([type, data]));
  const info = O.pageInfo();
  assert.equal(info.scrollGated, true);
  const gate = events.find(([t]) => t === 'page:info');
  assert.ok(gate && gate[1].scrollGated, 'emits page:info with scrollGated on mount');
});
