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

test('the two injection lists agree — worker (action click) and panel (reattach) inject the same files', () => {
  // background.js's list isn't covered by the manifest disk-check above, so a
  // file added only to panel.js would work from "Attach to current tab" and
  // silently fail on the normal action-click path.
  const listFrom = (src: string) => [...src.matchAll(/'((?:shared|content)\/[\w-]+\.js)'/g)].map((m) => m[1]);
  assert.deepEqual(listFrom(read('extension/background.js')), listFrom(read('extension/sidepanel/panel.js')));
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
  el.remove = () => { el.__removed = true; };
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
    MouseEvent: class { type: string; constructor(type: string, init: object) { this.type = type; Object.assign(this, init); } },
    PointerEvent: class { type: string; constructor(type: string, init: object) { this.type = type; Object.assign(this, init); } },
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

test('destroy leaves no trace in the page, and a later mount starts clean', () => {
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
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));
  // seeking into a hover span creates BOTH page-side artifacts: the cloned
  // :hover rules sheet on documentElement and the marker class on the element
  O.seek([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'hover', target: { selector: '.menu' }, settle: 1 },
  ], 1.5);
  assert.ok(classes.has('__tw-hover'));

  O.destroy();
  assert.ok(!classes.has('__tw-hover'), 'destroy un-hovers the page');
  // everything the overlay appended to documentElement (the host, the cloned
  // :hover rules sheet) is removed again
  const appended = w.document.documentElement.children;
  assert.ok(appended.length >= 2, 'host and hover rules sheet were appended');
  for (const el of appended) assert.ok(el.__removed, 'appended element removed on destroy');

  events.length = 0;
  w.__dispatch('scroll', {});
  w.__dispatch('resize', {});
  assert.equal(events.length, 0, 'page listeners were removed');

  O.mount((t: string, d: any) => events.push([t, d]));
  assert.ok(events.some(([t]) => t === 'page:info'), 'remount announces the page again');
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
  assert.equal(d.url, 'https://example.com/', 'the take carries the page it was recorded on');

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

test('a navigation mid-recording splits the take at the last click: record + click target, cleanly cut', () => {
  const link: any = {
    nodeType: 1,
    id: 'cta',
    tagName: 'A',
    className: '',
    innerText: 'Read more',
    getAttribute: () => null,
  };
  const w = bootOverlay({ queries: { '#cta': [link] } });
  w.document.elementFromPoint = () => link;
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));

  w.__setNow(0);
  O.startRecording();
  w.__dispatch('pointermove', { clientX: 100, clientY: 50 });
  w.__pumpRaf(); // t=0
  w.__setNow(100); w.scrollY = 40;
  w.__dispatch('pointermove', { clientX: 110, clientY: 60 });
  w.__pumpRaf(); // t=100
  w.__setNow(200);
  w.__pumpRaf(); // t=200
  w.__setNow(300);
  w.__dispatch('pointerdown', { button: 0, clientX: 120, clientY: 70 });
  w.__pumpRaf(); // t=300 — the click that will navigate
  w.__setNow(350);
  w.__dispatch('pointerup', { button: 0 });
  w.__pumpRaf(); // t=350 — dying-page tail, must be cut
  w.__setNow(400);
  w.__dispatch('pagehide', {});

  assert.ok(!events.some(([t]) => t === 'record:done'), 'a split is not a normal finish');
  const splits = events.filter(([t]) => t === 'record:split');
  assert.equal(splits.length, 1, 'exactly one record:split');
  const d = splits[0][1];
  // the take ends AT the navigating click's press — the cursor lands on the
  // link, then the click step (not the recording) performs the navigation
  assert.deepEqual(plain(d.take.samples.t), [0, 100, 200, 300]);
  assert.deepEqual(plain(d.take.samples.x), [100, 110, 110, 120]);
  assert.deepEqual(plain(d.take.samples.s), [0, 40, 40, 40]);
  assert.equal(d.take.buttons, undefined, 'the navigating click is the click step\'s, not the recording\'s');
  assert.equal(d.take.durationMs, 300);
  assert.deepEqual(plain(d.click), {
    anchor: { selector: '#cta', fallbackText: 'Read more' },
    quality: 'id',
  });
  assert.equal(d.url, 'https://example.com/', 'the split still knows the page the take began on');

  // the recording is fully torn down: further input goes nowhere
  w.__dispatch('pointermove', { clientX: 999, clientY: 999 });
  w.__pumpRaf();
  assert.equal(events.filter(([t]) => t === 'record:split').length, 1);
});

test('a navigation mid-recording with no recorded click keeps the take as a normal record:done', () => {
  const w = bootOverlay();
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));

  w.__setNow(0);
  O.startRecording();
  w.__dispatch('pointermove', { clientX: 100, clientY: 50 });
  w.__pumpRaf();
  w.__setNow(100);
  w.__pumpRaf();
  w.__dispatch('pagehide', {}); // reload / typed URL — nothing to blame a split on

  assert.ok(!events.some(([t]) => t === 'record:split'));
  const done = events.filter(([t]) => t === 'record:done');
  assert.equal(done.length, 1, 'what was captured is kept');
  assert.deepEqual(plain(done[0][1].samples.t), [0, 100]);
});

test('a click that navigates before two samples exist still splits — with the click alone, no take', () => {
  const link: any = {
    nodeType: 1, id: 'cta', tagName: 'A', className: '', innerText: 'Go', getAttribute: () => null,
  };
  const w = bootOverlay({ queries: { '#cta': [link] } });
  w.document.elementFromPoint = () => link;
  const O = w.TapewormOverlay;
  const events: Array<[string, any]> = [];
  O.mount((t: string, d: any) => events.push([t, d]));

  w.__setNow(0);
  O.startRecording();
  w.__dispatch('pointerdown', { button: 0, clientX: 120, clientY: 70 });
  w.__pumpRaf(); // the one and only sample, at the press itself
  w.__dispatch('pagehide', {});

  const splits = events.filter(([t]) => t === 'record:split');
  assert.equal(splits.length, 1);
  assert.equal(splits[0][1].take, null, 'no replayable material before the click');
  assert.equal(plain(splits[0][1].click.anchor.selector), '#cta');
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

test('preview emulates hover under the recorded pointer, and a recording ends earlier hovers', () => {
  const boxClasses = new Set<string>();
  const box: any = {
    nodeType: 1,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 150, top: 30, width: 100, height: 40 }),
    classList: { add: (c: string) => boxClasses.add(c), remove: (c: string) => boxClasses.delete(c) },
  };
  const menuClasses = new Set<string>();
  const menu: any = {
    nodeType: 1,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }),
    classList: { add: (c: string) => menuClasses.add(c), remove: (c: string) => menuClasses.delete(c) },
  };
  const w = bootOverlay({ queries: { '.menu': [menu] } });
  // what the render's trusted pointer would be over: the box occupies x 150-250
  w.document.elementFromPoint = (x: number, y: number) => (x >= 150 && x < 250 && y >= 30 ? box : null);
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  // start hold 1s → hover settle 1s → 2s recording (pointer x 100→300) → 0.5s hold
  const steps = [
    { type: 'start', at: 'top', hold: 1 },
    { type: 'hover', target: { selector: '.menu' }, settle: 1 },
    GEO_REC,
  ];
  O.seek(steps, 1.5); // mid-hover-settle
  assert.ok(menuClasses.has('__tw-hover'), 'the hover step still works');

  O.seek(steps, 3.0); // 1s into the recording: pointer at x=200 — over the box
  assert.ok(boxClasses.has('__tw-hover'), 'hover follows the recorded pointer');
  assert.ok(!menuClasses.has('__tw-hover'), 'starting the recording ended the earlier hover');

  O.seek(steps, 2.2); // 0.2s in: pointer at x=120 — over nothing
  assert.ok(!boxClasses.has('__tw-hover'));

  O.seek(steps, 4.4); // in the trailing hold: the render parks the pointer here
  assert.ok(!boxClasses.has('__tw-hover'), 'nothing hovered after the recording');
  assert.ok(!menuClasses.has('__tw-hover'), 'the earlier hover does not come back either');
});

test('recorded hover raises the events a real pointer would: pointer + mouse, chain-walked, at the pointer', () => {
  const fired: string[] = [];
  const noClasses = { add: () => {}, remove: () => {} };
  const parent: any = {
    nodeType: 1,
    parentElement: null,
    classList: noClasses,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 100 }),
    dispatchEvent: (e: any) => fired.push('parent:' + e.type),
  };
  const box: any = {
    nodeType: 1,
    parentElement: parent,
    classList: noClasses,
    getBoundingClientRect: () => ({ left: 150, top: 30, width: 100, height: 40 }),
    dispatchEvent: (e: any) => fired.push('box:' + e.type + '@' + Math.round(e.clientX) +
      (e.relatedTarget === parent ? '(rel:parent)' : '')),
  };
  const w = bootOverlay();
  w.document.elementFromPoint = (x: number) => (x >= 150 ? box : null);
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });
  const steps = [{ type: 'start', at: 'top', hold: 1 }, GEO_REC]; // recording spans t=1..3, x 100→300

  O.seek(steps, 2.0); // 1s in: pointer at x=200 enters the box
  assert.ok(fired.includes('box:pointerover@200'), 'pointerover, at the recorded position: ' + fired);
  assert.ok(fired.includes('box:mouseover@200'));
  assert.deepEqual(
    fired.filter((f) => f.includes('pointerenter')),
    ['parent:pointerenter', 'box:pointerenter@200'],
    'enter walks the chain outermost-first',
  );
  assert.ok(fired.includes('box:pointermove@200') && fired.includes('box:mousemove@200'));

  fired.length = 0;
  O.seek(steps, 2.5); // still over the box at x=250: moves keep flowing, no re-enter
  assert.ok(fired.includes('box:pointermove@250'), 'moves are continuous, at the live position');
  assert.ok(!fired.some((f) => f.includes('over') || f.includes('enter')), 'no spurious re-enter');

  fired.length = 0;
  O.seek(steps, 1.2); // back to x=120: off the box
  assert.ok(fired.includes('box:pointerout@120'));
  assert.ok(fired.includes('box:mouseout@120'));
  assert.deepEqual(
    fired.filter((f) => f.includes('pointerleave')),
    ['box:pointerleave@120', 'parent:pointerleave'],
    'leave walks the chain innermost-first',
  );
});

test('preview fires a recorded click at the recorded spot — once, in playback only; travel is a drag, not a click', () => {
  const fired: string[] = [];
  const btn: any = {
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 150, top: 30, width: 100, height: 40 }),
    dispatchEvent: (e: any) => fired.push(e.type + '@' + Math.round(e.clientX)),
  };
  const w = bootOverlay();
  w.document.elementFromPoint = (x: number) => (x >= 150 ? btn : null);
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  // 2s recording, pointer parked at x=200 for the second half; a stationary
  // down→up at t=1.4/1.45 — a click, released over the button
  const rec = {
    type: 'record',
    samples: { t: [0, 1000, 2000], x: [100, 200, 200], y: [50, 50, 50], s: [0, 0, 0] },
    viewport: { width: 1000, height: 700, dpr: 2 },
    buttons: [{ t: 1400, action: 'down' }, { t: 1450, action: 'up' }],
  };
  const steps = [{ type: 'start', at: 'top', hold: 1 }, rec];

  // scrubbing across the click must NOT fire it — back-and-forth would toggle state
  O.seek(steps, 2.6);
  assert.ok(!fired.some((f) => f.startsWith('click')), 'no click on scrub: ' + fired);

  w.__setNow(0);
  O.play(steps);
  w.__pumpRaf();
  w.__setNow(2000); w.__pumpRaf(); // t=2.0 — before the release
  assert.ok(!fired.some((f) => f.startsWith('click')), 'not before playback crosses the release');
  w.__setNow(2500); w.__pumpRaf(); // t=2.5 — crossed it
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    assert.equal(fired.filter((f) => f === type + '@200').length, 1, `${type} at the press position: ` + fired);
  }
  w.__setNow(2700); w.__pumpRaf();
  assert.equal(fired.filter((f) => f.startsWith('click')).length, 1, 'fired exactly once');
  O.stopPreview();

  // a down→up with real pointer travel is a drag: pressed where the press
  // landed, per-tick moves, released at the release point — and NO click
  fired.length = 0;
  const drag = {
    ...rec,
    samples: { t: [0, 1000, 2000], x: [100, 300, 300], y: [50, 50, 50], s: [0, 0, 0] },
    buttons: [{ t: 500, action: 'down' }, { t: 900, action: 'up' }], // x 200 → 280
  };
  w.__setNow(0);
  O.play([{ type: 'start', at: 'top', hold: 1 }, drag]);
  w.__setNow(1600); w.__pumpRaf(); // t=1.6 — mid-drag
  w.__setNow(2900); w.__pumpRaf(); // past the release
  assert.ok(fired.includes('pointerdown@200') && fired.includes('mousedown@200'),
    'pressed where the press landed: ' + fired);
  assert.ok(fired.includes('pointerup@280') && fired.includes('mouseup@280'),
    'released at the release point: ' + fired);
  assert.ok(!fired.some((f) => f.startsWith('click')), 'a drag is not a click: ' + fired);
  O.stopPreview();
});

test('preview replays a recorded drag natively when the source is draggable: dragstart → dragover → drop → dragend', () => {
  const fired: string[] = [];
  const mk = (name: string, cancels: string[] = []): any => ({
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    dispatchEvent: (e: any) => {
      fired.push(name + ':' + e.type + '@' + Math.round(e.clientX));
      return !cancels.includes(e.type); // false = preventDefault, as the DOM reports it
    },
  });
  const card = mk('card');
  card.closest = (sel: string) => (sel === '[draggable="true"]' ? card : null);
  const zone = mk('zone', ['dragover', 'drop']); // a drop target accepts by cancelling dragover
  const w = bootOverlay();
  w.document.elementFromPoint = (x: number) => (x < 200 ? card : zone);
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  // 2s recording: pointer x 100→300, held from t=0.1 to t=1.9 — a drag from
  // the card (x<200) onto the zone
  const rec = {
    type: 'record',
    samples: { t: [0, 1000, 2000], x: [100, 300, 300], y: [50, 50, 50], s: [0, 0, 0] },
    viewport: { width: 1000, height: 700, dpr: 2 },
    buttons: [{ t: 100, action: 'down' }, { t: 1900, action: 'up' }],
  };
  w.__setNow(0);
  O.play([{ type: 'start', at: 'top', hold: 1 }, rec]);
  w.__setNow(1200); w.__pumpRaf(); // t=1.2 — pressed at x=120, past the slop at x=140: dragstart
  assert.ok(fired.some((f) => f.startsWith('card:pointerdown@120')), 'pressed on the card: ' + fired);
  assert.ok(fired.some((f) => f.startsWith('card:dragstart')), 'native drag started: ' + fired);
  w.__setNow(1600); w.__pumpRaf(); // t=1.6 — x=220, over the zone
  assert.ok(fired.includes('zone:dragenter@220'), 'entered the drop target: ' + fired);
  assert.ok(fired.includes('card:dragleave@220'), 'left the source: ' + fired);
  assert.ok(fired.includes('zone:dragover@220'), 'dragover flows per tick: ' + fired);
  w.__setNow(3000); w.__pumpRaf(); // past the release at t=2.9
  assert.ok(fired.includes('zone:drop@300'), 'dropped where dragover was accepted: ' + fired);
  assert.ok(fired.includes('card:dragend@300'), 'dragend on the source, always: ' + fired);
  assert.ok(!fired.some((f) => f.includes(':click')), 'a drag is not a click: ' + fired);
  assert.ok(
    fired.indexOf('card:dragstart@140') < fired.indexOf('zone:dragenter@220') &&
    fired.indexOf('zone:dragenter@220') < fired.indexOf('zone:drop@300') &&
    fired.indexOf('zone:drop@300') < fired.indexOf('card:dragend@300'),
    'the native protocol order holds: ' + fired,
  );
  O.stopPreview();
});

test('a page that captures the pointer on pointerdown keeps recorded drag moves aimed at the capturer', () => {
  const fired: string[] = [];
  let captured = false;
  const knob: any = {
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    dispatchEvent: (e: any) => {
      fired.push('knob:' + e.type + '@' + Math.round(e.clientX));
      // a slider library grabs the pointer in its pointerdown handler;
      // pointerId 1 is the real mouse, so the grab takes
      if (e.type === 'pointerdown') captured = true;
      return true;
    },
    hasPointerCapture: (id: number) => captured && id === 1,
    releasePointerCapture: () => { captured = false; },
  };
  const other: any = {
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 200, top: 0, width: 400, height: 100 }),
    dispatchEvent: (e: any) => fired.push('other:' + e.type),
  };
  const w = bootOverlay();
  w.document.elementFromPoint = (x: number) => (x < 200 ? knob : other);
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  const rec = {
    type: 'record',
    samples: { t: [0, 1000, 2000], x: [100, 300, 300], y: [50, 50, 50], s: [0, 0, 0] },
    viewport: { width: 1000, height: 700, dpr: 2 },
    buttons: [{ t: 100, action: 'down' }, { t: 1900, action: 'up' }],
  };
  w.__setNow(0);
  O.play([{ type: 'start', at: 'top', hold: 1 }, rec]);
  w.__setNow(1600); w.__pumpRaf(); // t=1.6 — x=220: over `other`, but the knob holds capture
  assert.ok(fired.includes('knob:pointermove@220'), 'moves retarget to the capturing element: ' + fired);
  assert.ok(!fired.some((f) => f.startsWith('other:pointermove')), 'nothing leaks to the element underneath: ' + fired);
  w.__setNow(3000); w.__pumpRaf(); // past the release
  assert.ok(fired.includes('knob:pointerup@300'), 'released on the capturer: ' + fired);
  assert.ok(fired.includes('knob:lostpointercapture@300'), 'capture is released with the press: ' + fired);
  assert.equal(captured, false, 'releasePointerCapture was called');
  O.stopPreview();
});

test('preview resume after a navigation: earlier clicks stay fired, the interrupted settle dwells at the top', () => {
  const mkCta = (fired: string[]): any => ({
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30 }),
    dispatchEvent: (e: any) => fired.push(e.type),
  });
  // start at the bottom (y=4000) → click at t=1, settle to t=2 → 2s recording
  // whose scroll was captured on the DESTINATION (0 → 200)
  const steps = (cta: any) => [
    { type: 'start', at: 'bottom', hold: 1 },
    { type: 'click', target: { selector: '.cta' }, settle: 1 },
    {
      type: 'record',
      samples: { t: [0, 1000, 2000], x: [100, 200, 300], y: [50, 50, 50], s: [0, 100, 200] },
      viewport: { width: 1000, height: 700, dpr: 2 },
    },
  ];

  // sanity: a plain play crosses the click and fires it
  {
    const fired: string[] = [];
    const cta = mkCta(fired);
    const w = bootOverlay({ queries: { '.cta': [cta] } });
    const O = w.TapewormOverlay;
    O.mount(() => {});
    O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });
    w.__setNow(0);
    O.play(steps(cta));
    w.__setNow(1100); w.__pumpRaf();
    assert.equal(fired.filter((f) => f === 'click').length, 1, 'plain play fires the click');
    O.stopPreview();
  }

  // resume at t=1.3 — mid-settle, on the "destination" document
  {
    const fired: string[] = [];
    const cta = mkCta(fired);
    const w = bootOverlay({ queries: { '.cta': [cta] } });
    const O = w.TapewormOverlay;
    O.mount(() => {});
    O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });
    w.__setNow(0);
    const r = O.play(steps(cta), 1.3);
    assert.ok(r && Math.abs(r.total - 4) < 1e-9, 'resume returns the full total');
    w.__pumpRaf(); // t=1.3
    assert.equal(fired.filter((f) => f === 'click').length, 0, 'the click that navigated is not re-fired');
    assert.equal(w.scrollY, 0, 'the interrupted settle dwells at the destination\'s top, not the old page\'s offset');
    w.__setNow(400); w.__pumpRaf(); // t=1.7 — still in the settle
    assert.equal(w.scrollY, 0);
    w.__setNow(900); w.__pumpRaf(); // t=2.2 — 0.2s into the recording
    assert.ok(Math.abs(w.scrollY - 20) < 1e-9, 'the recording resumes at its own (destination-recorded) scroll: ' + w.scrollY);
    O.stopPreview();
  }
});

test('a Scroll-to on the far side of a navigation resolves when playback reaches it', () => {
  const cta: any = {
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30 }),
    dispatchEvent: () => {},
  };
  const dest: any = {
    nodeType: 1,
    parentElement: null,
    classList: { add: () => {}, remove: () => {} },
    getBoundingClientRect: () => ({ left: 0, top: 1000, width: 800, height: 400 }),
  };
  const queries: Record<string, unknown[]> = { '.cta': [cta] }; // .dest doesn't exist yet
  const w = bootOverlay({ queries });
  const O = w.TapewormOverlay;
  O.mount(() => {});
  O.setSettings({ width: 1000, height: 700, dpr: 2, fps: 60 });

  // without an interaction upstream, a missing anchor is still just a bad selector
  const bad = O.duration([{ type: 'start', at: 'top', hold: 0.5 }, { type: 'move', to: { selector: '.dest' } }]);
  assert.equal(bad.errors.length, 1, 'no interaction — the miss is an error');

  // behind a click, the move keeps a placeholder span instead of being dropped
  const steps = [
    { type: 'start', at: 'top', hold: 0.5 },
    { type: 'click', target: { selector: '.cta' }, settle: 0.5 },
    { type: 'move', to: { selector: '.dest' }, duration: 1, hold: 0 },
  ];
  const d = O.duration(steps);
  assert.equal(d.errors.length, 0, 'behind an interaction the miss defers instead of erroring');
  assert.ok(d.spans.some((sp: any) => sp.index === 2), 'the deferred move owns a span on the ruler');
  assert.ok(Math.abs(d.total - 2) < 1e-9, 'placeholder span counts toward the total: ' + d.total);

  w.__setNow(0);
  O.play(steps);
  w.__setNow(700); w.__pumpRaf(); // t=0.7 — the click fired; "navigation" mounts .dest
  queries['.dest'] = [dest];
  w.__setNow(1600); w.__pumpRaf(); // t=1.6 — mid-move, resolved live on the destination
  assert.ok(w.scrollY > 0 && w.scrollY < 1000, 'the deferred move is scrolling: ' + w.scrollY);
  w.__setNow(2100); w.__pumpRaf(); // past the end — clamped to the move's target
  assert.ok(Math.abs(w.scrollY - 1000) < 1e-9, 'lands on the late-resolved anchor: ' + w.scrollY);
  O.stopPreview();

  // scrubbing can't navigate: the unresolved span seeks as a hold, not an error
  delete queries['.dest'];
  O.seek(steps, 1.6);
  assert.equal(w.scrollY, 0, 'seek holds the current position through an unresolved span');
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
