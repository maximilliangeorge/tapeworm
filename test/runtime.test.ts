import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runtimeSource } from '../src/runtime.ts';
import { resolveConfig } from '../src/config.ts';
import type { Config, Resolved } from '../src/types.ts';

function cfg(over: Partial<Config> = {}): Resolved {
  return resolveConfig({ url: 'https://example.com', auto: true, ...over });
}

type Booted = {
  window: any;
  sr: any;
  /** Run every queued native rAF callback once (one "browser frame"). */
  pump: () => void;
  /** Pump until a promise from the runtime settles. */
  settle: <T>(p: Promise<T>) => Promise<T>;
};

/**
 * Boot the injected payload in a vm with the minimum DOM it touches on the paths
 * under test: no videos, no pending images, no WAAPI animations. Native rAF is a
 * queue the test pumps by hand, which is exactly the control the runtime is
 * designed around.
 */
function boot(resolved: Resolved, domOver: Record<string, unknown> = {}): Booted {
  const rafQueue: Array<(t: number) => void> = [];
  const noopStyle = { setProperty() {} };
  const collection = () => Object.assign([], { forEach: Array.prototype.forEach });

  const window: any = {
    innerWidth: resolved.width,
    innerHeight: resolved.height,
    scrollY: 0,
    requestAnimationFrame: (cb: (t: number) => void) => rafQueue.push(cb),
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => performance.now() },
    Date,
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
    scrollTo: ({ top }: { top: number }) => { window.scrollY = top; },
    document: {
      documentElement: { scrollHeight: 5000, appendChild() {}, querySelectorAll: () => collection(), style: noopStyle },
      head: { appendChild() {} },
      body: { children: [], style: noopStyle },
      images: [],
      createElement: () => ({ style: noopStyle }),
      querySelectorAll: () => collection(),
      ...domOver,
    },
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(runtimeSource(resolved), window);

  const pump = () => { for (const cb of rafQueue.splice(0)) cb(0); };
  const settle = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    p.finally(() => { done = true; }).catch(() => {});
    for (let i = 0; i < 50 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      pump();
    }
    return p;
  };
  return { window, sr: window.__sr, pump, settle };
}

test('runtimeSource emits syntactically valid JS for every clock/video mode', () => {
  for (const clock of ['virtual', 'real'] as const) {
    for (const video of ['sync', 'freeze', 'ignore'] as const) {
      const src = runtimeSource(cfg({ page: { clock, video } }));
      new vm.Script(src); // throws on a syntax error in the template literal
    }
  }
});

test('boots against a bare DOM and exposes the __sr API', () => {
  const { sr } = boot(cfg());
  for (const key of ['frame', 'resolveAnchor', 'discoverSections', 'beginCapture', 'setScroll', 'maxScroll', 'metrics']) {
    assert.equal(typeof sr[key], 'function', `__sr.${key}`);
  }
  assert.equal(sr.maxScroll(), 5000 - 800);
});

test('virtual clock: Date.now and performance.now follow the frame index, not the wall clock', async () => {
  const { window, sr, settle } = boot(cfg());
  sr.beginCapture(false);
  const origin = window.Date.now(); // vnow = 0 → this is the frozen origin
  await new Promise((r) => setTimeout(r, 30)); // real time passes...
  assert.equal(window.Date.now(), origin, 'Date.now moved without a frame');

  await settle(sr.frame(0, 2.5, 0));
  assert.equal(window.Date.now(), origin + 2500);
  assert.equal(window.performance.now(), 2500);

  // seeking the same frame index twice gives the same clock — frames are independent
  await settle(sr.frame(0, 2.5, 0));
  assert.equal(window.Date.now(), origin + 2500);
});

test('virtual timers fire when the timeline crosses them, in order, with intervals repeating', async () => {
  const { window, sr, settle } = boot(cfg());
  sr.beginCapture(false);
  const fired: string[] = [];
  window.setTimeout(() => fired.push('late'), 2000);
  window.setTimeout(() => fired.push('early'), 500);
  window.setInterval(() => fired.push('tick'), 1000);

  await settle(sr.frame(0, 0.25, 0));
  assert.deepEqual(fired, [], 'nothing due at 250ms');
  await settle(sr.frame(0, 0.75, 0));
  assert.deepEqual(fired, ['early']);
  // at vnow=2100 both the interval (due at 1000) and the timeout (2000) are due;
  // they fire in schedule order, and the interval reschedules relative to vnow
  await settle(sr.frame(0, 2.1, 0));
  assert.deepEqual(fired, ['early', 'tick', 'late']);
  await settle(sr.frame(0, 3.2, 0));
  assert.deepEqual(fired, ['early', 'tick', 'late', 'tick']);
});

test('clock "real" leaves the page timers alone', () => {
  const { window } = boot(cfg({ page: { clock: 'real' } }));
  assert.equal(window.setTimeout, setTimeout);
  assert.equal(window.Date, Date);
});

test('frame() applies the scroll clamped to the document', async () => {
  const { window, sr, settle } = boot(cfg());
  sr.beginCapture(false);
  type FrameResult = { requested: number; actual: number; max: number };
  const r: FrameResult = await settle(sr.frame(1000, 1, 0));
  assert.equal(window.scrollY, 1000);
  assert.equal(r.requested, 1000);
  assert.equal(r.actual, 1000);
  assert.equal(r.max, 4200);

  const over: FrameResult = await settle(sr.frame(999_999, 2, 0));
  assert.equal(over.actual, 4200, 'clamped to maxScroll');
});

test('resolveAnchor: keywords, raw offsets, and element alignment', () => {
  const hero = { getBoundingClientRect: () => ({ top: 1000, height: 400 }) };
  const { sr } = boot(cfg(), {
    querySelectorAll: (sel: string) => (sel === '.hero' ? [hero] : []),
  });
  assert.equal(sr.resolveAnchor('top'), 0);
  assert.equal(sr.resolveAnchor('bottom'), 4200);
  assert.equal(sr.resolveAnchor(123), 123);
  assert.equal(sr.resolveAnchor(999_999), 4200);
  assert.equal(sr.resolveAnchor({ selector: '.hero' }), 1000);
  assert.equal(sr.resolveAnchor({ selector: '.hero', align: 'center' }), 1000 - (800 - 400) / 2);
  assert.equal(sr.resolveAnchor({ selector: '.hero', align: 'bottom' }), 1000 + 400 - 800);
  assert.equal(sr.resolveAnchor({ selector: '.hero', offset: -50 }), 950);
  assert.throws(() => sr.resolveAnchor({ selector: '.missing' }), /matched nothing/);
});
