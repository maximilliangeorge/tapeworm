import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * embeds-core is a plain script installing one global, like the shared core —
 * booted here in a bare vm with a hand-built env, so both provider protocols
 * can be driven message by message with no DOM and no clock.
 */
function bootEmbeds(over: { mode?: 'sync' | 'freeze' | 'ignore'; location?: unknown } = {}) {
  const timers: { cb: () => void; ms: number; id: number }[] = [];
  let nextTimer = 1;
  const listeners: ((ev: { data: unknown; source: unknown }) => void)[] = [];
  const ctx: any = { URL };
  if (over.location) ctx.location = over.location;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../src/embeds-core.js', import.meta.url), 'utf8'), ctx);
  const env = {
    mode: over.mode ?? 'sync',
    fps: 60,
    nSetTimeout: (cb: () => void, ms: number) => { timers.push({ cb, ms, id: nextTimer }); return nextTimer++; },
    nClearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    addMessageListener: (type: string, cb: (ev: { data: unknown; source: unknown }) => void) => {
      if (type === 'message') listeners.push(cb);
    },
    nearViewport: () => true,
  };
  const controller = ctx.TapewormEmbeds.createController(env);
  return {
    controller,
    /** Deliver a message event as the browser would: parsed by the router. */
    deliver: (data: unknown, source: unknown) =>
      listeners.forEach((l) => l({ data: typeof data === 'string' ? data : JSON.stringify(data), source })),
    /** Run every currently queued native timer once. */
    fire: () => { timers.splice(0).forEach((t) => t.cb()); },
    timers,
    listenerCount: () => listeners.length,
  };
}

function fakeIframe(src: string, over: Record<string, unknown> = {}) {
  const sent: { msg: any; origin: string }[] = [];
  const iframe: any = {
    tagName: 'IFRAME',
    src,
    getBoundingClientRect: () => ({ width: 640, height: 360, top: 0, bottom: 360 }),
    querySelectorAll: () => [],
    contentWindow: {
      postMessage: (raw: string, origin: string) => sent.push({ msg: JSON.parse(raw), origin }),
    },
    ...over,
  };
  return { iframe, sent };
}

/**
 * Await a promise whose resolution needs escape-hatch timers that are only
 * scheduled on later microtasks (e.g. ready()'s poll → priming seek chain):
 * alternate microtask drains with timer fires until it settles.
 */
async function pumped<T>(b: { fire: () => void }, p: Promise<T>): Promise<T> {
  let done = false;
  const tracked = p.then((v) => { done = true; return v; });
  for (let i = 0; i < 50 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    if (!done) b.fire();
  }
  if (!done) throw new Error('promise never settled under the timer pump');
  return tracked;
}

const VIMEO_SRC = 'https://player.vimeo.com/video/123456';
const YT_SRC = 'https://www.youtube.com/embed/dQw4w9WgXcQ';

// ---------------------------------------------------------------- vimeo

test('vimeo: handshake knocks, readies on first answer, then pauses and mutes', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  assert.equal(b.controller.count(), 1);
  const methods = sent.map((p) => p.msg.method);
  assert.ok(methods.includes('addEventListener'), 'subscribes to events');
  assert.ok(methods.includes('getDuration'));
  assert.ok(sent.every((p) => p.origin === 'https://player.vimeo.com'), 'targets the src origin');

  b.fire(); // knock retries while unanswered
  assert.ok(sent.filter((p) => p.msg.method === 'getDuration').length >= 2);

  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  const after = sent.map((p) => p.msg.method);
  assert.ok(after.includes('pause'), 'pauses once ready');
  assert.ok(after.includes('setVolume'), 'mutes once ready');
  const r = b.controller.report()[0];
  assert.equal(r.ready, true);
  assert.equal(r.duration, 30);
});

test('vimeo: seek posts setCurrentTime with half-frame bias and resolves on the seeked ack', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;

  const wait = b.controller.sync(2);
  const seekMsg = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.ok(seekMsg, 'posts setCurrentTime');
  assert.ok(Math.abs(seekMsg.msg.value - (2 + 0.5 / 60)) < 1e-9);
  assert.ok(sent.some((p) => p.msg.method === 'pause'), 'pauses alongside the seek');

  b.deliver({ event: 'seeked', data: { seconds: seekMsg.msg.value } }, iframe.contentWindow);
  await wait;
  assert.equal(b.controller.report()[0].ok, true);
});

test('vimeo: a far-off report does not resolve the seek; the native timeout does', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 300 }, iframe.contentWindow);

  let resolved = false;
  const wait = b.controller.sync(100).then(() => { resolved = true; });
  b.deliver({ event: 'seeked', data: { seconds: 3 } }, iframe.contentWindow); // way off target
  await Promise.resolve();
  assert.equal(resolved, false, 'off-target ack must not resolve the wait');
  b.fire(); // the 1200ms escape hatch
  await wait;
  assert.equal(b.controller.report()[0].ok, false, 'health check records the miss');
});

test('vimeo: seek clamps to duration with no loop-wrap', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;
  b.controller.sync(100);
  const seekMsg = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.equal(seekMsg!.msg.value, 29.95);
});

test('vimeo: a play event triggers an immediate re-pause', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;
  b.deliver({ event: 'play' }, iframe.contentWindow);
  assert.ok(sent.some((p) => p.msg.method === 'pause'));
});

// ---------------------------------------------------------------- youtube

test('youtube: src gains enablejsapi=1 (and origin on http(s) pages), preserving params', () => {
  const b = bootEmbeds({ location: { protocol: 'https:', origin: 'https://example.com' } });
  const { iframe } = fakeIframe(YT_SRC + '?start=10');
  b.controller.scan(iframe);
  const u = new URL(iframe.src);
  assert.equal(u.searchParams.get('enablejsapi'), '1');
  assert.equal(u.searchParams.get('origin'), 'https://example.com');
  assert.equal(u.searchParams.get('start'), '10', 'existing params survive');
});

test('youtube: an already-enabled src is not rewritten', () => {
  const b = bootEmbeds();
  const src = YT_SRC + '?enablejsapi=1';
  const { iframe } = fakeIframe(src);
  b.controller.scan(iframe);
  assert.equal(iframe.src, src);
});

test('youtube: listening handshake retries until an answer, then pauses and mutes', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(YT_SRC);
  b.controller.scan(iframe);
  const hello = sent.find((p) => p.msg.event === 'listening');
  assert.ok(hello, 'posts the widget handshake');
  assert.equal(hello.msg.channel, 'widget');
  b.fire();
  assert.ok(sent.filter((p) => p.msg.event === 'listening').length >= 2, 'retries');

  b.deliver({ event: 'onReady', id: hello.msg.id }, iframe.contentWindow);
  const funcs = sent.filter((p) => p.msg.event === 'command').map((p) => p.msg.func);
  assert.ok(funcs.includes('pauseVideo'));
  assert.ok(funcs.includes('mute'));
});

test('youtube: seek posts seekTo+pauseVideo and resolves on a close-enough infoDelivery', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(YT_SRC);
  b.controller.scan(iframe);
  const id = sent.find((p) => p.msg.event === 'listening')!.msg.id;
  b.deliver({ event: 'onReady', id }, iframe.contentWindow);
  sent.length = 0;

  const wait = b.controller.sync(1);
  const seekMsg = sent.find((p) => p.msg.func === 'seekTo');
  assert.ok(seekMsg);
  assert.deepEqual(seekMsg.msg.args, [1 + 0.5 / 60, true]);
  assert.ok(sent.some((p) => p.msg.func === 'pauseVideo'));

  b.deliver({ event: 'infoDelivery', id, info: { currentTime: 1.01, duration: 60 } }, iframe.contentWindow);
  await wait;
  const r = b.controller.report()[0];
  assert.equal(r.ok, true);
  assert.equal(r.duration, 60);
});

test('youtube: playerState 1 in a delivery triggers a re-pause', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(YT_SRC);
  b.controller.scan(iframe);
  const id = sent.find((p) => p.msg.event === 'listening')!.msg.id;
  b.deliver({ event: 'onReady', id }, iframe.contentWindow);
  sent.length = 0;
  b.deliver({ event: 'infoDelivery', id, info: { playerState: 1, currentTime: 5 } }, iframe.contentWindow);
  assert.ok(sent.some((p) => p.msg.func === 'pauseVideo'));
});

// ---------------------------------------------------------------- registry

test('ignore mode: no tracking and no src rewrite side effects', () => {
  const b = bootEmbeds({ mode: 'ignore' });
  const { iframe, sent } = fakeIframe(YT_SRC);
  b.controller.scan(iframe);
  assert.equal(b.controller.count(), 0);
  assert.equal(iframe.src, YT_SRC, 'ignore must not rewrite the src');
  assert.equal(sent.length, 0);
  assert.equal(b.listenerCount(), 0, 'no message listener installed');
});

test('freeze mode: sync() resolves immediately and pauses ready sessions', async () => {
  const b = bootEmbeds({ mode: 'freeze' });
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;
  await b.controller.sync(5);
  assert.ok(sent.some((p) => p.msg.method === 'pause'));
  assert.ok(!sent.some((p) => p.msg.method === 'setCurrentTime'), 'freeze never seeks');
});

test('unknown media-sized cross-origin iframe is reported, never messaged', () => {
  const b = bootEmbeds({ location: { protocol: 'https:', origin: 'https://example.com' } });
  const big = fakeIframe('https://cdn.stranger.example/player/99');
  const small = fakeIframe('https://cdn.stranger.example/pixel', {
    getBoundingClientRect: () => ({ width: 100, height: 50, top: 0, bottom: 50 }),
  });
  const sameOrigin = fakeIframe('https://example.com/inline-frame');
  b.controller.scan(big.iframe);
  b.controller.scan(small.iframe);
  b.controller.scan(sameOrigin.iframe);
  assert.equal(b.controller.count(), 0);
  const rows = b.controller.report();
  assert.equal(rows.length, 1, 'only the media-sized stranger is worth a note');
  assert.equal(rows[0].controllable, false);
  assert.equal(rows[0].ok, false);
  assert.equal(big.sent.length, 0);
});

test('scan handles a root that is itself an iframe, and containers of iframes', () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  const container = { tagName: 'DIV', querySelectorAll: () => [iframe] };
  b.controller.scan(container);
  assert.equal(b.controller.count(), 1);
  b.controller.scan(iframe); // re-scan of a tracked iframe is a no-op
  assert.equal(b.controller.count(), 1);
});

test('report truncates long srcs like videoReport does', () => {
  const b = bootEmbeds();
  const long = VIMEO_SRC + '?h=' + 'x'.repeat(80);
  const { iframe } = fakeIframe(long);
  b.controller.scan(iframe);
  const r = b.controller.report()[0];
  assert.ok(r.src.startsWith('…'));
  assert.equal(r.src.length, 69);
  assert.ok(long.endsWith(r.src.slice(1)));
});

// ---------------------------------------------------------------- ready()

test('ready() with no embeds resolves immediately', async () => {
  const b = bootEmbeds();
  assert.deepEqual({ ...(await b.controller.ready(4000, 0)) }, { embeds: 0, ready: true });
});

test('ready() resolves as soon as handshakes complete, then primes a seek', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;
  const r = { ...(await pumped<Record<string, unknown>>(b, b.controller.ready(4000, 2))) };
  assert.deepEqual(r, { embeds: 1, ready: true });
  assert.ok(sent.some((m) => m.msg.method === 'setCurrentTime'), 'primes the first frame seek');
});

test('ready() gives up after maxMs when a handshake never answers', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  const p = b.controller.ready(200, 0);
  b.fire(); // poll at 0ms → waited 100
  b.fire(); // poll at 100ms → waited 200
  b.fire(); // poll at 200ms → gives up
  const r = { ...(await p) };
  assert.deepEqual(r, { embeds: 1, ready: false });
});
