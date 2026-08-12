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
  /** Deliver a message event to the runtime's captured window listener. */
  deliverMessage: (data: unknown, source: unknown) => void;
};

/**
 * Boot the injected payload in a vm with the minimum DOM it touches on the paths
 * under test: no videos, no pending images, no WAAPI animations. Native rAF is a
 * queue the test pumps by hand, which is exactly the control the runtime is
 * designed around.
 */
function boot(resolved: Resolved, domOver: Record<string, unknown> = {}, winOver: Record<string, unknown> = {}): Booted {
  const rafQueue: Array<(t: number) => void> = [];
  const noopStyle = { setProperty() {} };
  const collection = () => Object.assign([], { forEach: Array.prototype.forEach });

  const messageListeners: Array<(ev: { data: unknown; source: unknown }) => void> = [];
  const window: any = {
    innerWidth: resolved.width,
    innerHeight: resolved.height,
    scrollY: 0,
    requestAnimationFrame: (cb: (t: number) => void) => rafQueue.push(cb),
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, cb: (ev: { data: unknown; source: unknown }) => void) => {
      if (type === 'message') messageListeners.push(cb);
    },
    MessageEvent: class {
      type: string;
      constructor(type: string, init: Record<string, unknown>) { this.type = type; Object.assign(this, init); }
    },
    dispatchEvent: (ev: any) => {
      if (ev.type === 'message') messageListeners.forEach((l) => l(ev));
      return true;
    },
    URL,
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
  Object.assign(window, winOver);
  window.window = window;
  window.top = window; // the tests emulate the top frame
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
  const deliverMessage = (data: unknown, source: unknown) =>
    messageListeners.forEach((l) => l({ data: JSON.stringify(data), source }));
  return { window, sr: window.__sr, pump, settle, deliverMessage };
}

/** A provider iframe as the embeds controller sees one, recording its posts. */
function embedIframe(src: string) {
  const sent: any[] = [];
  const iframe: any = {
    tagName: 'IFRAME',
    src,
    getBoundingClientRect: () => ({ width: 640, height: 360, top: 0, bottom: 360 }),
    querySelectorAll: () => [],
    contentWindow: { postMessage: (raw: string) => sent.push(JSON.parse(raw)) },
  };
  return { iframe, sent };
}

test('runtimeSource emits syntactically valid JS for every clock/video/embeds mode', () => {
  for (const clock of ['virtual', 'real'] as const) {
    for (const video of ['sync', 'freeze', 'ignore'] as const) {
      for (const embeds of ['sync', 'freeze', 'ignore'] as const) {
        const src = runtimeSource(cfg({ page: { clock, video, embeds } }));
        new vm.Script(src); // throws on a syntax error in the template literal
      }
    }
  }
});

test('a provider iframe is discovered at boot and counted in metrics', () => {
  const { iframe, sent } = embedIframe('https://player.vimeo.com/video/76979871');
  const { sr } = boot(cfg(), { querySelectorAll: (sel: string) => (sel === 'iframe' ? [iframe] : []) });
  assert.equal(sr.metrics().embeds, 1);
  assert.equal(sr.embedCount(), 1);
  assert.ok(sent.some((m) => m.method === 'getDuration'), 'handshake went out at boot');
  const r = sr.embedReport()[0];
  assert.equal(r.provider, 'vimeo');
  assert.equal(r.ready, false, 'not ready until the player answers');
});

test('frame() waits on the embed seek and resolves on the provider ack', async () => {
  const { iframe, sent } = embedIframe('https://player.vimeo.com/video/76979871');
  const b = boot(cfg(), { querySelectorAll: (sel: string) => (sel === 'iframe' ? [iframe] : []) });
  b.deliverMessage({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  b.sr.beginCapture(false);
  sent.length = 0;

  const p = b.sr.frame(0, 1, 0);
  const seekMsg = sent.find((m) => m.method === 'setCurrentTime');
  assert.ok(seekMsg, 'the frame seeks the embed');
  assert.ok(Math.abs(seekMsg.value - (1 + 0.5 / 60)) < 1e-9, 'half-frame bias, like seekVideo');
  b.deliverMessage({ event: 'seeked', data: { seconds: seekMsg.value } }, iframe.contentWindow);
  await b.settle(p);

  const r = b.sr.embedReport()[0];
  assert.equal(r.ready, true);
  assert.equal(r.ok, true);
});

test('frame() re-broadcasts a vimeo timeupdate that a page-registered SDK listener hears', async () => {
  const { iframe, sent } = embedIframe('https://player.vimeo.com/video/76979871');
  const b = boot(cfg(), { querySelectorAll: (sel: string) => (sel === 'iframe' ? [iframe] : []) });
  b.deliverMessage({ method: 'getDuration', value: 30 }, iframe.contentWindow);

  // a page SDK's message listener, registered on the (un-shadowed) window API
  const heard: any[] = [];
  b.window.addEventListener('message', (ev: any) => {
    try {
      const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (d && d.event === 'timeupdate') heard.push({ ev, d });
    } catch (e) {}
  });

  b.sr.beginCapture(false);
  sent.length = 0;
  const p = b.sr.frame(0, 2, 0);
  const seekMsg = sent.find((m) => m.method === 'setCurrentTime');
  b.deliverMessage({ event: 'seeked', data: { seconds: seekMsg.value } }, iframe.contentWindow);
  await b.settle(p);

  assert.equal(heard.length, 1, 'one timeupdate per frame');
  assert.equal(heard[0].ev.origin, 'https://player.vimeo.com', 'passes the SDK origin check');
  assert.equal(heard[0].ev.source, iframe.contentWindow, 'passes the SDK source check');
  assert.equal(heard[0].d.data.seconds, Math.round((2 + 0.5 / 60) * 1000) / 1000);
  assert.equal(heard[0].d.data.duration, 30);
});

test('embeds: "ignore" tracks nothing and frame() ignores the iframe', async () => {
  const { iframe, sent } = embedIframe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  const b = boot(cfg({ page: { embeds: 'ignore' } }), {
    querySelectorAll: (sel: string) => (sel === 'iframe' ? [iframe] : []),
  });
  assert.equal(b.sr.metrics().embeds, 0);
  assert.equal(iframe.src, 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'no enablejsapi rewrite in ignore mode');
  b.sr.beginCapture(false);
  await b.settle(b.sr.frame(0, 1, 0));
  assert.equal(sent.length, 0);
});

test('embedsReady gates on the handshake and primes the first frame seek', async () => {
  const { iframe, sent } = embedIframe('https://player.vimeo.com/video/76979871');
  const b = boot(cfg(), { querySelectorAll: (sel: string) => (sel === 'iframe' ? [iframe] : []) });
  b.deliverMessage({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;

  const p = b.sr.embedsReady(4000, 2);
  await new Promise((r) => setTimeout(r, 20)); // the ready-poll chain arms the priming seek
  const seekMsg = sent.find((m) => m.method === 'setCurrentTime');
  assert.ok(seekMsg, 'primes a seek to the shard start time');
  b.deliverMessage({ event: 'seeked', data: { seconds: seekMsg.value } }, iframe.contentWindow);
  const r = await p;
  assert.equal(r.embeds, 1);
  assert.equal(r.ready, true);
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

test('frame(null) is a free frame: the page keeps the scroll it has', async () => {
  // A client-side route transition owns the scroll while it plays — the old
  // view sits at the click offset until the router itself jumps to the top.
  const { window, sr, settle } = boot(cfg());
  sr.beginCapture(false);
  await settle(sr.frame(1234, 1, 0));
  window.scrollTo = () => { throw new Error('a free frame must not touch the scroll'); };
  const r: { actual: number } = await settle(sr.frame(null, 1.5, 0));
  assert.equal(r.actual, 1234, 'reports where the page actually is');
  assert.equal(window.scrollY, 1234);
});

test('actionPoint aims at the element centre in viewport coords, clamped', () => {
  const cta = { getBoundingClientRect: () => ({ left: 100, top: 300, width: 200, height: 50, bottom: 350 }) };
  const off = { getBoundingClientRect: () => ({ left: -500, top: 2000, width: 100, height: 40, bottom: 2040 }) };
  const { sr } = boot(cfg(), {
    querySelectorAll: (sel: string) => (sel === '.cta' ? [cta] : sel === '.off' ? [off] : []),
  });
  const hit = sr.actionPoint({ selector: '.cta' });
  assert.equal(hit.found, true);
  assert.equal(hit.x, 200);
  assert.equal(hit.y, 325);
  assert.equal(hit.visible, true);
  const clamped = sr.actionPoint({ selector: '.off' });
  assert.equal(clamped.visible, false);
  assert.ok(clamped.x >= 0 && clamped.y <= 799, 'clamped into the viewport');
  assert.equal(sr.actionPoint({ selector: '.missing' }).found, false);
});

function bootWithCursorDom(over: Partial<Config> = {}) {
  const appended: any[] = [];
  const booted = boot(cfg(over), {});
  const { window } = booted;
  window.document.createElement = () => {
    const el: any = { className: '', innerHTML: '', style: {} };
    return el;
  };
  window.document.documentElement.appendChild = (el: any) => appended.push(el);
  return { ...booted, appended };
}

test('frame() draws the cursor sprite: positioned, pressed, hidden — and old callers leave it alone', async () => {
  const { sr, settle, appended } = bootWithCursorDom();
  sr.beginCapture(false);

  await settle(sr.frame(0, 1, 0)); // 3-arg caller: cursor untouched
  assert.equal(appended.length, 0, 'no cursor element until someone draws it');

  await settle(sr.frame(0, 1.1, 0, { x: 100, y: 50, down: false }));
  assert.equal(appended.length, 1, 'created lazily, on documentElement — hideOverlays only scans body');
  const el = appended[0];
  assert.equal(el.className, '__tw-cursor', 'the __tw- prefix keeps it out of generated selectors');
  assert.match(el.style.cssText, /pointer-events:none/, 'never hit-tested');
  assert.match(el.style.transform, /translate\(95px,47px\)/, 'tip of the arrow sits on the point');
  assert.doesNotMatch(el.style.transform, /scale/);

  await settle(sr.frame(0, 1.2, 0, { x: 100, y: 50, down: true }));
  assert.match(el.style.transform, /scale\(0\.88\)/, 'press feedback');

  await settle(sr.frame(0, 1.3, 0, null));
  assert.match(el.style.transform, /-9999px/, 'null hides it');

  await settle(sr.frame(0, 1.4, 0));
  assert.match(el.style.transform, /-9999px/, 'undefined leaves it as it was');
});

test('frame() applies the cursor fade alpha as opacity; an alpha-less draw clears it', async () => {
  const { sr, settle, appended } = bootWithCursorDom();
  sr.beginCapture(false);

  await settle(sr.frame(0, 1, 0, { x: 100, y: 50, down: false, alpha: 0.25 }));
  const el = appended[0];
  assert.equal(el.style.opacity, '0.25', 'mid-fade frame');

  await settle(sr.frame(0, 1.1, 0, { x: 110, y: 50, down: false, alpha: 1 }));
  assert.equal(el.style.opacity, '1');

  await settle(sr.frame(0, 1.2, 0, { x: 120, y: 50, down: false, alpha: 1.7 }));
  assert.equal(el.style.opacity, '1', 'clamped to 1');

  await settle(sr.frame(0, 1.3, 0, { x: 130, y: 50, down: false }));
  assert.equal(el.style.opacity, '', 'no alpha (fade off): opacity left to the stylesheet default');
});

test('__sr.cursor drives the same sprite by hand', () => {
  const { sr, appended } = bootWithCursorDom();
  sr.cursor(10, 20, false);
  assert.equal(appended.length, 1);
  assert.match(appended[0].style.transform, /translate\(5px,17px\)/);
  sr.cursor(null);
  assert.match(appended[0].style.transform, /-9999px/);
});

test('a replacement cursor image is drawn instead of the built-in arrow, tip on the point', () => {
  const { sr, appended } = bootWithCursorDom({
    page: { cursor: { image: 'data:image/png;base64,AAAA', tip: [10, 4], size: 40 } },
  });
  sr.cursor(100, 50, false);
  assert.equal(appended.length, 1);
  const el = appended[0];
  assert.match(el.innerHTML, /<img src="data:image\/png;base64,AAAA"/);
  assert.match(el.innerHTML, /width:40px/);
  assert.doesNotMatch(el.innerHTML, /<svg/);
  assert.match(el.style.cssText, /transform-origin:10px 4px/, 'press scale pivots on the custom tip');
  assert.match(el.style.transform, /translate\(90px,46px\)/, 'the custom tip sits on the point');
});

test('beginCapture pre-creates a replacement image cursor so it cannot pop in mid-gesture', () => {
  const { sr, appended } = bootWithCursorDom({ page: { cursor: { image: 'data:image/png;base64,AAAA' } } });
  sr.beginCapture(false);
  assert.equal(appended.length, 1, 'created at capture start, before the first drawn frame');
  assert.match(appended[0].style.cssText, /-9999px/, 'hidden until a gesture draws it');
});

test('auto cursor: the sprite follows the CSS cursor under the pointer, gestures included', () => {
  const resolved = cfg({ page: { cursor: { auto: true } } });
  const sprites = (resolved.page.cursor as { auto: Record<string, { url: string; tipX: number; tipY: number }> }).auto;
  const appended: any[] = [];
  const booted = boot(resolved, {});
  const { window, sr } = booted;
  window.document.createElement = () => ({
    className: '', innerHTML: '', style: {}, children: [] as any[],
    appendChild(child: any) { this.children.push(child); },
  });
  window.document.documentElement.appendChild = (el: any) => appended.push(el);
  let cssCursor = 'default';
  window.document.elementFromPoint = () => ({});
  window.getComputedStyle = () => ({ cursor: cssCursor });
  const shown = () => appended[0].children.filter((c: any) => c.style.display === 'block');

  sr.beginCapture(false);
  assert.equal(appended.length, 1, 'the whole set is pre-created at capture start');
  assert.equal(appended[0].children.length, Object.keys(sprites).length, 'one hidden <img> per cursor');

  sr.cursor(100, 50, false);
  assert.equal(shown().length, 1, 'exactly one sprite visible at a time');
  assert.equal(shown()[0].src, sprites.cursor.url, 'default CSS cursor draws the arrow');
  assert.match(appended[0].style.transform, /translate\(91px,43px\)/, "the arrow's hotspot (9,7) sits on the point");

  cssCursor = 'pointer';
  sr.cursor(100, 50, false);
  assert.equal(shown().length, 1);
  assert.equal(shown()[0].src, sprites.pointinghand.url, 'links get the pointing hand');
  assert.match(appended[0].style.transform, /translate\(88px,42px\)/, 'placed by the fingertip (12,8)');
  assert.equal(appended[0].style.transformOrigin, '12px 8px', 'press shrink pivots on this hotspot');

  cssCursor = 'grab';
  sr.cursor(100, 50, false);
  assert.equal(shown()[0].src, sprites.openhand.url, 'grabbable shows the open hand');
  sr.cursor(100, 50, true);
  assert.equal(shown()[0].src, sprites.closedhand.url, 'holding the button closes it');
  assert.match(appended[0].style.transform, /scale\(0\.88\)/);

  cssCursor = 'url(sprite.png) 4 4, copy';
  sr.cursor(100, 50, false);
  assert.equal(shown()[0].src, sprites.copy.url, 'a cursor list degrades to its trailing keyword');

  cssCursor = 'text';
  sr.cursor(100, 50, false);
  assert.equal(shown()[0].src, sprites.cursor.url, 'keywords outside the set fall back to the arrow');
});

test('dot cursor: a centred disc that turns blue while pressed', () => {
  const appended: any[] = [];
  const booted = boot(cfg({ page: { cursor: { dot: true } } }), {});
  const { window, sr } = booted;
  window.document.createElement = () => ({
    className: '', innerHTML: '', style: {}, children: [] as any[],
    appendChild(child: any) { this.children.push(child); },
  });
  window.document.documentElement.appendChild = (el: any) => appended.push(el);

  sr.cursor(100, 50, false);
  const root = appended[0];
  const disc = root.children[0];
  assert.match(disc.style.cssText, /border-radius:50%/);
  assert.match(disc.style.cssText, /width:18px/);
  assert.match(root.style.cssText, /transform-origin:9px 9px/, 'press shrink pivots on the centre');
  assert.match(root.style.transform, /translate\(91px,41px\)/, 'the centre sits on the point');
  assert.equal(disc.style.background, 'rgba(22,24,29,0.85)');

  sr.cursor(100, 50, true);
  assert.equal(disc.style.background, 'rgba(64,156,255,0.95)', 'pressed = blue, like the preview');
  assert.match(root.style.transform, /scale\(0\.88\)/);

  sr.cursor(100, 50, false);
  assert.equal(disc.style.background, 'rgba(22,24,29,0.85)', 'release restores the idle colour');
});

test('page.cursor false: input still flows but nothing is ever drawn', async () => {
  const { sr, settle, appended } = bootWithCursorDom({ page: { cursor: false } });
  sr.beginCapture(false);
  await settle(sr.frame(0, 1, 0, { x: 100, y: 50, down: false }));
  sr.cursor(100, 50, true);
  assert.equal(appended.length, 0, 'the knob suppresses the sprite entirely');
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

// ---------------------------------------------------------------- storage restore
test('page.localStorage is seeded on the config origin before anything else runs', () => {
  const store = new Map<string, string>();
  boot(
    cfg({ page: { localStorage: { 'intro-seen': '1', theme: 'dark' } } }),
    {},
    {
      location: { origin: 'https://example.com' },
      localStorage: { setItem: (k: string, v: string) => store.set(k, v) },
    },
  );
  assert.equal(store.get('intro-seen'), '1');
  assert.equal(store.get('theme'), 'dark');
});

test('the snapshot stays off documents on other origins', () => {
  const store = new Map<string, string>();
  boot(
    cfg({ page: { localStorage: { 'intro-seen': '1' } } }),
    {},
    {
      location: { origin: 'https://elsewhere.example' },
      localStorage: { setItem: (k: string, v: string) => store.set(k, v) },
    },
  );
  assert.equal(store.size, 0);
});

test('without page.localStorage the runtime never touches storage', () => {
  const store = new Map<string, string>();
  boot(cfg(), {}, {
    location: { origin: 'https://example.com' },
    localStorage: { setItem: (k: string, v: string) => store.set(k, v) },
  });
  assert.equal(store.size, 0);
});
