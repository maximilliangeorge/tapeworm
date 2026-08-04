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
  // the background worker's on-demand injection list must point at real files
  const bg = read('extension/background.js');
  for (const m of bg.matchAll(/'((?:shared|content)\/[\w-]+\.js)'/g)) {
    assert.ok(existsSync(new URL(`extension/${m[1]}`, root)), `${m[1]} injected but missing`);
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

function bootOverlay(opts: { maxScroll?: number } = {}) {
  const docHeight = (opts.maxScroll ?? 4000) + 700; // + innerHeight below
  const window: any = {
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 2,
    scrollY: 0,
    location: { href: 'https://example.com/' },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
    scrollTo: ({ top }: { top: number }) => { window.scrollY = top; },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: {
      title: 'Example',
      documentElement: Object.assign(fakeEl(), { scrollHeight: docHeight }),
      body: { innerText: '' },
      createElement: () => fakeEl(),
      querySelectorAll: () => [],
      elementFromPoint: () => null,
    },
  };
  window.window = window;
  vm.createContext(window);
  for (const f of ['easing-core.js', 'anchor-core.js', 'selector.js']) {
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
  const auto = E.autoDuration(4000 - 2000, 800, E.resolveEase(undefined));
  const { total, errors } = O.duration(steps);
  assert.equal(errors.length, 0);
  assert.ok(Math.abs(total - (1 + 2 + 0.6 + 0.5 + auto + 0.8)) < 1e-9, `total ${total}`);
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
