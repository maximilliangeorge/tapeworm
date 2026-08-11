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
  const announced: { iframe: unknown; msg: any }[] = [];
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
    // The real dispatcher fires a genuine MessageEvent sourced from the iframe
    // — which is what the page SDK's provenance checks want, and also exactly
    // what the controller's own router matches on. Echo it here so the
    // self-send guard is under test instead of assumed.
    dispatchMessage: (iframe: any, json: string) => {
      announced.push({ iframe, msg: JSON.parse(json) });
      listeners.forEach((l) => l({ data: json, source: iframe?.contentWindow }));
    },
    nearViewport: () => true,
  };
  const controller = ctx.TapewormEmbeds.createController(env);
  return {
    controller,
    /** Synthetic events the controller asked the page to hear. */
    announced,
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

test('vimeo: sync re-broadcasts a timeupdate for the page SDK once the seek settles', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  const wait = b.controller.sync(2);
  assert.equal(b.announced.length, 0, 'nothing announced before the seek settles');
  const target = 2 + 0.5 / 60;
  b.deliver({ event: 'seeked', data: { seconds: target } }, iframe.contentWindow);
  await wait;
  assert.deepEqual(
    b.announced.map((x) => x.msg.event),
    ['play', 'timeupdate'],
    'play leads, so a page gating its scrubber on play state is playing before the time arrives',
  );
  const a = b.announced[1];
  assert.equal(a.iframe, iframe, 'sourced from the embed iframe');
  assert.deepEqual(b.announced[0].msg.data, a.msg.data, 'play carries the frame\'s time, not zero');
  assert.equal(a.msg.data.seconds, Math.round(target * 1000) / 1000);
  assert.equal(a.msg.data.duration, 30);
  assert.equal(a.msg.data.percent, Math.round((target / 30) * 1000) / 1000);
});

test('vimeo: past the end — one pinned timeupdate, never a forged ended, then silence; a backwards jump revives', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);

  const step = async (tSec: number) => {
    const wait = b.controller.sync(tSec);
    b.deliver({ event: 'seeked', data: { seconds: Math.min(tSec + 0.5 / 60, 29.95) } }, iframe.contentWindow);
    await wait;
  };

  await step(100); // way past the 30s duration
  assert.deepEqual(
    b.announced.map((a) => a.msg.event),
    ['timeupdate'],
    'no ended — end-state UI must stay in the page\'s hands; and no play, a stopped player isn\'t playing',
  );
  assert.deepEqual(b.announced[0].msg.data, { seconds: 30, percent: 1, duration: 30 }, 'final timeupdate pins at the duration');

  await step(101); // still past the end: a really-ended player goes quiet
  assert.equal(b.announced.length, 1, 'no repeats past the end');

  await step(2); // jump back before the end
  assert.deepEqual(b.announced.slice(1).map((a) => a.msg.event), ['play', 'timeupdate'], 'the revived stream leads with play');
  assert.equal(b.announced[2].msg.data.seconds, Math.round((2 + 0.5 / 60) * 1000) / 1000);

  await step(100); // and past the end again: the pin re-fires once
  assert.deepEqual(b.announced.slice(3).map((a) => a.msg.event), ['timeupdate']);
  assert.equal(b.announced[3].msg.data.percent, 1);
});

test('an embed that mounts mid-capture plays from its own zero, not the render clock', async () => {
  const b = bootEmbeds();
  await b.controller.sync(5); // capture is 5s in before the embed exists (a click just opened it)
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  sent.length = 0;

  const wait = b.controller.sync(7); // first frame with the embed present
  const seekMsg = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.ok(seekMsg, 'seeks the newborn embed');
  assert.ok(Math.abs(seekMsg.msg.value - 0.5 / 60) < 1e-9, 'starts at its own 0, not at 7s');
  b.deliver({ event: 'seeked', data: { seconds: seekMsg.msg.value } }, iframe.contentWindow);
  await wait;
  assert.equal(b.announced[0].msg.data.seconds, Math.round((0.5 / 60) * 1000) / 1000, 'announced time is embed-local too');

  sent.length = 0;
  const wait2 = b.controller.sync(9); // two render-seconds later → two embed-seconds in
  const seekMsg2 = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.ok(seekMsg2, 'seeks on the later frame too');
  assert.ok(Math.abs(seekMsg2.msg.value - (2 + 0.5 / 60)) < 1e-9, 'advances on the embed\'s own clock');
  b.deliver({ event: 'seeked', data: { seconds: seekMsg2.msg.value } }, iframe.contentWindow);
  await wait2;
});

test('vimeo: readiness via SDK chatter does not stop the duration hunt — knock keeps asking', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  // the page's own SDK traffic readies the session without answering getDuration
  b.deliver({ event: 'ready' }, iframe.contentWindow);
  const r = b.controller.report()[0];
  assert.equal(r.ready, true);
  assert.equal(r.duration, null);

  sent.length = 0;
  b.fire(); // next knock: still hunting for the duration
  assert.ok(sent.some((p) => p.msg.method === 'getDuration'), 'keeps asking after ready');
  assert.ok(!sent.some((p) => p.msg.method === 'addEventListener'), 'subscriptions are not re-posted once ready');

  b.deliver({ method: 'getDuration', value: 120 }, iframe.contentWindow);
  sent.length = 0;
  b.fire();
  assert.ok(!sent.some((p) => p.msg.method === 'getDuration'), 'stops once the duration arrives');
});

test('vimeo: duration harvested from a seeked ack keeps the announced percent honest', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ event: 'ready' }, iframe.contentWindow); // ready, duration unknown

  const wait = b.controller.sync(30);
  const target = 30 + 0.5 / 60;
  // real seeked acks carry {seconds, percent, duration} — the ack itself teaches us the duration
  b.deliver({ event: 'seeked', data: { seconds: target, percent: 0.25, duration: 120 } }, iframe.contentWindow);
  await wait;
  const tu = b.announced.find((a) => a.msg.event === 'timeupdate');
  assert.ok(tu);
  assert.equal(tu.msg.data.duration, 120);
  assert.equal(tu.msg.data.percent, Math.round((target / 120) * 1000) / 1000, 'percent no longer stuck at 0');
});

test('vimeo: an unready embed announces nothing', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe); // handshake never answered
  await b.controller.sync(2);
  assert.equal(b.announced.length, 0);
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

test('vimeo: subscribes to pause — a page with no SDK of its own would never broadcast one', () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  const subs = sent.filter((p) => p.msg.method === 'addEventListener').map((p) => p.msg.value);
  assert.deepEqual(subs.sort(), ['pause', 'play', 'seeked']);
});

test('vimeo: play is announced once, then re-armed by the player\'s real pause', async () => {
  const b = bootEmbeds();
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);

  const step = async (tSec: number) => {
    const wait = b.controller.sync(tSec);
    b.deliver({ event: 'seeked', data: { seconds: tSec + 0.5 / 60 } }, iframe.contentWindow);
    await wait;
  };

  await step(1);
  await step(2);
  await step(3);
  assert.deepEqual(
    b.announced.map((a) => a.msg.event),
    ['play', 'timeupdate', 'timeupdate', 'timeupdate'],
    'stated once — a page play handler firing every frame would spam analytics and any parent listeners',
  );

  // the control's own autoplay defense pauses the embed for real; the page SDK
  // hears it and flips its button back, so the next frame has to restate play
  b.deliver({ event: 'pause' }, iframe.contentWindow);
  await step(4);
  assert.deepEqual(b.announced.slice(4).map((a) => a.msg.event), ['play', 'timeupdate']);
  await step(5);
  assert.deepEqual(b.announced.slice(6).map((a) => a.msg.event), ['timeupdate'], 'and settles back to quiet');
});

test('vimeo: the controller ignores its own announce — no self-inflicted pause', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);

  // the frame that announces play is the one that can echo: the synthetic play
  // returns through the router sourced from the iframe, and acted on it would
  // trip the autoplay defense — commanding the player to pause immediately
  // after we told the page it was playing
  sent.length = 0;
  const wait = b.controller.sync(2);
  b.deliver({ event: 'seeked', data: { seconds: 2 + 0.5 / 60 } }, iframe.contentWindow);
  await wait;
  assert.deepEqual(b.announced.map((a) => a.msg.event), ['play', 'timeupdate'], 'the announce still goes out');
  const pauses = sent.filter((p) => p.msg.method === 'pause');
  assert.equal(pauses.length, 1, 'only the pause the seek itself posts — none from hearing ourselves');
});

test('vimeo: freeze mode announces no play — nothing is pretending to advance', async () => {
  const b = bootEmbeds({ mode: 'freeze' });
  const { iframe } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  await b.controller.sync(2);
  assert.equal(b.announced.length, 0);
});

// A page-commanded pause is visible only as an unmatched method ack: the
// player acks every command, tapeworm's own pauses consume one ack each, and
// what's left over is the page SDK's player.pause(). These tests drive that
// accounting message by message.

test('vimeo: a page-commanded pause freezes the embed, announces one synthetic pause, and resumes where it stopped', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow); // ready → tapeworm's pause #1

  const step = async (tSec: number) => {
    const wait = b.controller.sync(tSec);
    const seekMsg = sent.filter((p) => p.msg.method === 'setCurrentTime').pop();
    if (seekMsg) b.deliver({ event: 'seeked', data: { seconds: seekMsg.msg.value } }, iframe.contentWindow);
    await wait;
  };

  await step(1); // pause #2, alongside the seek
  // the player acks both of tapeworm's own pauses: consumed, still driving
  b.deliver({ method: 'pause' }, iframe.contentWindow);
  b.deliver({ method: 'pause' }, iframe.contentWindow);
  sent.length = 0;
  await step(2); // pause #3
  assert.ok(sent.some((p) => p.msg.method === 'setCurrentTime'), 'own acks are consumed, not mistaken for the page');

  b.deliver({ method: 'pause' }, iframe.contentWindow); // acks pause #3
  b.deliver({ method: 'pause' }, iframe.contentWindow); // unmatched: the page called pause()
  sent.length = 0;
  const before = b.announced.length;
  await b.controller.sync(3);
  assert.ok(!sent.some((p) => p.msg.method === 'setCurrentTime'), 'no seek while page-paused');
  assert.deepEqual(
    b.announced.slice(before).map((a) => a.msg.event),
    ['pause'],
    'one synthetic pause — the really-already-paused player emits no event for the page\'s no-op pause',
  );
  const frozeAt = 2 + 0.5 / 60;
  assert.equal(b.announced[before].msg.data.seconds, Math.round(frozeAt * 1000) / 1000, 'pinned at the time it stopped on');
  await b.controller.sync(4);
  assert.equal(b.announced.length, before + 1, 'then quiet — a paused player announces nothing');

  // the page hits play: tapeworm never posts play, so a play ack is always the page's
  b.deliver({ method: 'play' }, iframe.contentWindow);
  sent.length = 0;
  const wait = b.controller.sync(10); // most of the pause happened off-camera between frames
  const seekMsg = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.ok(seekMsg, 'driving again');
  assert.ok(Math.abs(seekMsg!.msg.value - (frozeAt + 0.5 / 60)) < 1e-9, 'resumes from the paused-at time, not the render clock');
  b.deliver({ event: 'seeked', data: { seconds: seekMsg!.msg.value } }, iframe.contentWindow);
  await wait;
  assert.deepEqual(b.announced.slice(-2).map((a) => a.msg.event), ['play', 'timeupdate'], 'the resume restates play');
});

test('vimeo: a page scrub while paused moves the resume point — even forward past the render clock', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  b.deliver({ method: 'getDuration', value: 30 }, iframe.contentWindow);
  const wait0 = b.controller.sync(1);
  const first = sent.find((p) => p.msg.method === 'setCurrentTime')!;
  b.deliver({ event: 'seeked', data: { seconds: first.msg.value } }, iframe.contentWindow);
  await wait0;

  b.deliver({ method: 'pause' }, iframe.contentWindow); // acks the ready pause
  b.deliver({ method: 'pause' }, iframe.contentWindow); // acks the seek's pause
  b.deliver({ method: 'pause' }, iframe.contentWindow); // the page's own pause()
  // the page's scrubber seeks the paused player — a real seeked the page's flow produced
  b.deliver({ event: 'seeked', data: { seconds: 20 } }, iframe.contentWindow);
  b.deliver({ method: 'play' }, iframe.contentWindow);

  sent.length = 0;
  const wait = b.controller.sync(5);
  const seekMsg = sent.find((p) => p.msg.method === 'setCurrentTime');
  assert.ok(seekMsg, 'driving again');
  assert.ok(Math.abs(seekMsg!.msg.value - (20 + 0.5 / 60)) < 1e-9, 'continues from the scrubbed time');
  b.deliver({ event: 'seeked', data: { seconds: seekMsg!.msg.value } }, iframe.contentWindow);
  await wait;
});

test('vimeo: a page pause landing before the handshake is not misattributed to the ready-flip pause', async () => {
  const b = bootEmbeds();
  const { iframe, sent } = fakeIframe(VIMEO_SRC);
  b.controller.scan(iframe);
  // the page paused while tapeworm was still knocking: its ack is the first message
  b.deliver({ method: 'pause' }, iframe.contentWindow);
  assert.equal(b.controller.report()[0].ready, true, 'any message still readies the session');
  sent.length = 0;
  await b.controller.sync(1);
  assert.ok(!sent.some((p) => p.msg.method === 'setCurrentTime'), 'held at its start until the page plays');
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
  assert.equal(b.announced.length, 0, 'youtube needs no synthetic events — the widget addresses page listeners itself');
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
  assert.equal(b.announced.length, 0, 'frozen time gets no timeupdate');
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
