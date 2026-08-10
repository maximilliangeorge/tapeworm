/**
 * Provider embed control: Vimeo/YouTube iframes driven through their
 * postMessage player APIs, from the top frame.
 *
 * The inner <video> of a cross-origin embed is unreachable (cross-origin DOM,
 * and the iframe is an OOPIF the runtime is never injected into), so the only
 * handle on it is the message channel each provider's player exposes. That
 * makes this path best-effort where the native video path is exact: seeks
 * snap to keyframes, acks are the provider's word rather than a painted
 * frame, and an embed that never answers the handshake simply free-runs —
 * reported, never fatal.
 *
 * NOT a shared-core file: sync-shared would ship it to the extension, and the
 * YouTube src rewrite (enablejsapi=1 reloads the iframe) must never fire in a
 * user's everyday browser. Loaded ahead of the runtime payload the same way
 * the shared core is, so backticks are safe here. No imports, no Node APIs —
 * installs one global.
 *
 * Everything here runs in the parent page, where the runtime virtualises the
 * clock — so all waiting uses the natives handed in via env (nSetTimeout &c),
 * and never Date/performance. The iframe's own scripts run on the real clock
 * (that's why its player answers at all).
 */
(() => {
'use strict';

/**
 * Ack tolerance in seconds, for both resolving a pending seek and the health
 * report's `ok`. Native video uses 0.05s; provider seeks snap to keyframes
 * (GOP on streamed renditions is ~0.25s) and YouTube's reported currentTime
 * is quantized, so 0.3 accepts a correct-but-snapped seek while still
 * catching a genuinely stuck player, which is seconds off.
 */
const TOLERANCE = 0.3;
const KNOCK_INTERVAL = 500;
const KNOCK_TRIES = 20;

/** Wait bounds for one seek — seekVideo's exact values, for the same reason:
 *  never let one stubborn player hang the whole render. */
function seekTimeoutMs(env, iframe) {
  return env.nearViewport(iframe) ? 1200 : 250;
}

/** Shared per-session pending-seek plumbing: one outstanding seek at a time,
 *  resolved by an ack within TOLERANCE or by the native-timeout escape. */
function pendingSlot(env) {
  let pending = null; // { target, resolve, timer }
  return {
    settle() {
      if (!pending) return;
      const p = pending;
      pending = null;
      env.nClearTimeout(p.timer);
      p.resolve();
    },
    arm(iframe, target) {
      this.settle(); // a superseded seek must never leak into the next frame
      return new Promise((resolve) => {
        const timer = env.nSetTimeout(() => { pending = null; resolve(); }, seekTimeoutMs(env, iframe));
        pending = { target, resolve, timer };
      });
    },
    ackTime(sec) {
      if (pending && Math.abs(sec - pending.target) <= TOLERANCE) this.settle();
    },
  };
}

/** Half-frame bias like seekVideo, clamp with no loop-wrap: provider embeds
 *  don't loop by default, so past-the-end holds the last frame. */
function seekTarget(tSec, fps, duration) {
  const max = duration != null && duration > 0 ? Math.max(0, duration - 0.05) : Infinity;
  return Math.min(Math.max(tSec + 0.5 / fps, 0), max);
}

// ---------------------------------------------------------------- vimeo
// player.vimeo.com speaks JSON strings: outbound {method, value}, inbound
// method acks {method, value} and subscribed events {event, data}. The API is
// live on every embed by default — no src rewrite needed.
const VIMEO = {
  name: 'vimeo',
  matches: (src) => /^https?:\/\/player\.vimeo\.com\/video\//.test(src),
  prepareSrc: null,
  createSession(iframe, post, env) {
    const slot = pendingSlot(env);
    const s = { provider: 'vimeo', ready: false, duration: null, currentTime: 0, want: null };
    let tries = 0;
    const knock = () => {
      if (s.ready || tries++ >= KNOCK_TRIES) return;
      post({ method: 'addEventListener', value: 'seeked' });
      post({ method: 'addEventListener', value: 'play' });
      post({ method: 'getDuration' });
      env.nSetTimeout(knock, KNOCK_INTERVAL);
    };
    knock();
    s.pause = () => post({ method: 'pause' });
    s.onMessage = (data) => {
      if (!s.ready) {
        // any answer from this window means the player API is live
        s.ready = true;
        post({ method: 'pause' });
        post({ method: 'setVolume', value: 0 });
      }
      if (data.method === 'getDuration' && typeof data.value === 'number') s.duration = data.value;
      if (data.event === 'play') post({ method: 'pause' }); // autoplay defense: the iframe runs on the real clock
      const sec = data.event === 'seeked' && data.data && typeof data.data.seconds === 'number'
        ? data.data.seconds
        : data.method === 'setCurrentTime' && typeof data.value === 'number' ? data.value : null;
      if (sec != null) {
        s.currentTime = sec;
        slot.ackTime(sec);
      }
    };
    s.seek = (tSec) => {
      if (!s.ready) return null;
      const target = seekTarget(tSec, env.fps, s.duration);
      s.want = target;
      const p = slot.arm(iframe, target);
      post({ method: 'pause' });
      post({ method: 'setCurrentTime', value: target });
      return p;
    };
    /**
     * Per-frame `timeupdate` for the page's own Vimeo SDK. A paused player
     * only ever reports `seeked`, so page UI driven by
     * `player.on('timeupdate')` — a custom scrubber, a chapter highlight —
     * freezes at 0 while the control keeps the embed paused. Re-broadcast the
     * frame's time as the message the player would post during real playback
     * (same shape, same origin, sourced from the iframe's window, so the
     * SDK's provenance checks pass). Values rounded to the millisecond, as
     * the player rounds its own.
     *
     * Past the video's end (seekTarget clamps there), real playback would
     * have stopped: pin one final timeupdate at the duration, fire `ended`
     * once, then go quiet the way a really-ended player does. Page
     * end-of-video UI (replay buttons, end cards) still triggers, while the
     * iframe itself never ends — so Vimeo's own end screen stays out of the
     * render.
     *
     * Deliberately NOT synthesized, so a future adapter author doesn't
     * "complete" this into a bug:
     * - play/playing/pause: the player genuinely is paused. Forging `play`
     *   buys a cosmetic fix (play buttons showing the playing icon on
     *   camera) at the cost of real side effects — analytics beacons,
     *   pause-other-players logic, pause-on-scroll handlers that would fight
     *   this controller. If a page gates its timeupdate handling on play
     *   state, make it an opt-in, not a default.
     * - cuepoint: cue points are registered by the page SDK directly with
     *   the player and fire only when playback *crosses* them, which paused
     *   seeks never do. Feasible (getCuePoints, then emit as frame times
     *   sweep past) but machinery for a rare pattern — build it when a page
     *   actually needs it.
     * - everything else (seeked/seeking, progress, bufferstart/bufferend,
     *   volumechange, durationchange, chapterchange, cuechange, …): the
     *   paused player still emits these for real around our pause/mute/
     *   seeks, and subscriptions are the page's own — nothing to fake.
     */
    const payload = (seconds) => ({
      seconds: Math.round(seconds * 1000) / 1000,
      percent: s.duration > 0 ? Math.round(Math.min(seconds / s.duration, 1) * 1000) / 1000 : 0,
      duration: s.duration || 0,
    });
    s.announce = (tSec) => {
      if (!s.ready || !env.dispatchMessage) return;
      const emit = (event, data) => env.dispatchMessage(iframe, JSON.stringify({ event, data }));
      const past = s.duration > 0 && tSec + 0.5 / env.fps > s.duration - 0.05; // seekTarget's clamp condition
      if (!past) {
        s.endedAnnounced = false; // a backwards jump revives the stream, like a real re-seek
        emit('timeupdate', payload(s.want != null ? s.want : seekTarget(tSec, env.fps, s.duration)));
        return;
      }
      if (s.endedAnnounced) return;
      s.endedAnnounced = true;
      emit('timeupdate', payload(s.duration));
      emit('ended', payload(s.duration));
    };
    return s;
  },
};

// ---------------------------------------------------------------- youtube
// No announce() here: a page's own YT.Player holds its own `listening`
// registration with the widget, which addresses every registered listener an
// infoDelivery on each seek — the page SDK's cached currentTime already
// tracks the control's seeks without help.
// The widget API only listens when the embed src carries enablejsapi=1, so
// discovery may rewrite the src (reload is harmless at boot/prewarm, which is
// when discovery runs). Outbound {event:'listening'} then {event:'command'};
// inbound is a stream of {event:'infoDelivery', info:{...}}. There is NO seek
// ack — a pending seek resolves when a delivery reports a close-enough time.
let ytNextId = 1;
const YOUTUBE = {
  name: 'youtube',
  matches: (src) => /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//.test(src),
  prepareSrc(src) {
    if (/[?&]enablejsapi=1(?:&|$|#)/.test(src)) return null;
    try {
      const u = new URL(src);
      u.searchParams.set('enablejsapi', '1');
      // youtube validates the origin param against the sender; only http(s)
      // pages have one worth claiming
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        u.searchParams.set('origin', location.origin);
      }
      return u.toString();
    } catch (e) { return null; }
  },
  createSession(iframe, post, env) {
    const slot = pendingSlot(env);
    const id = ytNextId++;
    const s = { provider: 'youtube', ready: false, duration: null, currentTime: 0, want: null };
    const command = (func, args) => post({ event: 'command', func, args: args || [], id, channel: 'widget' });
    let tries = 0;
    const knock = () => {
      if (s.ready || tries++ >= KNOCK_TRIES) return;
      post({ event: 'listening', id, channel: 'widget' });
      env.nSetTimeout(knock, KNOCK_INTERVAL);
    };
    knock();
    s.pause = () => command('pauseVideo');
    s.onMessage = (data) => {
      if (data.id != null && data.id !== id) return;
      if (!s.ready && (data.event === 'onReady' || data.event === 'infoDelivery')) {
        s.ready = true;
        command('pauseVideo');
        command('mute');
      }
      if (data.event === 'infoDelivery' && data.info) {
        if (typeof data.info.duration === 'number') s.duration = data.info.duration;
        if (data.info.playerState === 1) command('pauseVideo'); // autoplay defense
        if (typeof data.info.currentTime === 'number') {
          s.currentTime = data.info.currentTime;
          slot.ackTime(data.info.currentTime);
        }
      }
    };
    s.seek = (tSec) => {
      if (!s.ready) return null;
      const target = seekTarget(tSec, env.fps, s.duration);
      s.want = target;
      const p = slot.arm(iframe, target);
      command('seekTo', [target, true]);
      command('pauseVideo');
      return p;
    };
    return s;
  },
};

const PROVIDERS = [VIMEO, YOUTUBE];

// ---------------------------------------------------------------- controller
function createController(env) {
  const sessions = new Map(); // iframe -> session
  const unknown = new Set();  // cross-origin, media-sized, no adapter — report-only
  let listening = false;

  function route(ev) {
    let data = ev.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    if (!data || typeof data !== 'object') return;
    sessions.forEach((s, iframe) => {
      try { if (ev.source && ev.source === iframe.contentWindow) s.onMessage(data); } catch (e) {}
    });
  }

  function makePost(iframe) {
    let origin = '*';
    try { origin = new URL(iframe.src).origin; } catch (e) {}
    return (msg) => {
      try {
        const w = iframe.contentWindow;
        if (w) w.postMessage(JSON.stringify(msg), origin);
      } catch (e) {}
    };
  }

  /** Big enough to plausibly be a video, foreign enough to be beyond reach. */
  function mediaLikeStranger(iframe, src) {
    if (!/^https?:\/\//.test(src)) return false;
    try {
      if (typeof location !== 'undefined' && new URL(src).origin === location.origin) return false;
    } catch (e) {}
    try {
      const r = iframe.getBoundingClientRect();
      return r.width >= 200 && r.height >= 100;
    } catch (e) { return false; }
  }

  function track(iframe) {
    if (sessions.has(iframe) || unknown.has(iframe)) return;
    const src = String(iframe.src || '');
    const provider = PROVIDERS.find((p) => p.matches(src));
    if (!provider) {
      if (mediaLikeStranger(iframe, src)) unknown.add(iframe);
      return;
    }
    if (provider.prepareSrc) {
      const rewritten = provider.prepareSrc(src);
      if (rewritten) { try { iframe.src = rewritten; } catch (e) {} }
    }
    sessions.set(iframe, provider.createSession(iframe, makePost(iframe), env));
    if (!listening) {
      listening = true;
      env.addMessageListener('message', route);
    }
  }

  function scan(root) {
    // mirror trackVideo's guard: in ignore mode, no tracking and no side
    // effects — an untouched src is part of "don't touch them"
    if (env.mode === 'ignore') return;
    if (!root || !root.querySelectorAll) return;
    if (root.tagName === 'IFRAME') track(root);
    root.querySelectorAll('iframe').forEach(track);
  }

  function sync(tSec) {
    if (env.mode !== 'sync') {
      if (env.mode === 'freeze') sessions.forEach((s) => { if (s.ready) s.pause(); });
      return Promise.resolve();
    }
    const waits = [];
    sessions.forEach((s) => { const p = s.seek(tSec); if (p) waits.push(p); });
    const settled = waits.length ? Promise.all(waits) : Promise.resolve();
    // announce after the seeks settle and before the caller paints, so a page
    // SDK reacting to the synthetic event has its DOM update in the frame
    return settled.then(() => {
      sessions.forEach((s) => { if (s.announce) s.announce(tSec); });
    });
  }

  /**
   * Shard-start gate: wait (bounded) for handshakes, then prime one seek so
   * the first captured frame doesn't land on a cold buffer. Instant when the
   * page has no provider embeds.
   */
  function ready(maxMs, tFirstSec) {
    const all = Array.from(sessions.values());
    const allReady = () => all.every((x) => x.ready);
    if (!all.length) return Promise.resolve({ embeds: 0, ready: true });
    return new Promise((resolve) => {
      let waited = 0;
      const poll = () => {
        if (allReady() || waited >= maxMs) return resolve(null);
        waited += 100;
        env.nSetTimeout(poll, 100);
      };
      poll();
    })
      .then(() => (env.mode === 'sync' && tFirstSec != null ? sync(tFirstSec) : null))
      .then(() => ({ embeds: all.length, ready: allReady() }));
  }

  function trunc(src) {
    return src.length > 70 ? '…' + src.slice(-68) : src;
  }

  function report() {
    const rows = [];
    sessions.forEach((s, iframe) => {
      rows.push({
        provider: s.provider,
        src: trunc(String(iframe.src || '(no src)')),
        controllable: true,
        ready: s.ready,
        duration: s.duration,
        currentTime: s.currentTime,
        wanted: s.want == null ? null : s.want,
        ok: !s.ready ? false : s.want == null ? true : Math.abs(s.currentTime - s.want) < TOLERANCE,
      });
    });
    unknown.forEach((iframe) => {
      rows.push({
        provider: null,
        src: trunc(String(iframe.src || '(no src)')),
        controllable: false,
        ready: false,
        duration: null,
        currentTime: null,
        wanted: null,
        ok: false,
      });
    });
    return rows;
  }

  return { scan, sync, ready, count: () => sessions.size, report };
}

globalThis.TapewormEmbeds = { createController };
})();
