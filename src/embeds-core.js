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

/**
 * A synthetic announce is a real MessageEvent carrying the iframe as its
 * source (that's what makes a page SDK accept it), which is exactly what this
 * file's own router matches on — so without a guard the controller hears its
 * own fabrications and acts on them: a synthetic `play` would trip the
 * autoplay defense and command a redundant pause on an already-paused player.
 * Tagging the payload would work too, but it would also be visible to the
 * page; the announce has to stay byte-identical to a real broadcast. Dispatch
 * is synchronous, so a flag around it is enough — listeners run inline.
 */
let announcing = false;

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
//
// The method acks are also how the page's own intent becomes visible here.
// The player acks every method it's sent (that's what resolves the page
// SDK's player.pause() promise — even on an already-paused player), acks
// carry no sender, and postMessage is FIFO per window pair. So the session
// counts the pause commands this controller posts and consumes one ack for
// each; an unmatched pause ack means THE PAGE asked, and that ask is honored:
// the embed holds the frame it stopped on until the page says play. The
// resulting frames depend on *when* the pause landed, not just the frame
// index — path-dependence sync embeds already accept by forcing jobs=1.
const VIMEO = {
  name: 'vimeo',
  matches: (src) => /^https?:\/\/player\.vimeo\.com\/video\//.test(src),
  prepareSrc: null,
  createSession(iframe, post, env) {
    const slot = pendingSlot(env);
    const s = {
      provider: 'vimeo', ready: false, duration: null, currentTime: 0, want: null, birth: null, playAnnounced: false,
      // page-pause state: pauseAt is the media time the page stopped on,
      // skew is how much of the timeline was spent paused (media = local − skew)
      pagePaused: false, pauseAt: null, skew: 0, resumePending: false, pauseAnnounced: false,
    };
    let ownPauses = 0;
    const pauseCmd = () => { ownPauses++; post({ method: 'pause' }); };
    let tries = 0;
    // Ready and duration are separate goals: readiness flips on ANY message
    // out of the player window — which on a page using the Vimeo SDK is
    // usually the SDK's own chatter, not our getDuration ack (posted while
    // the player was still booting, into no listener). Duration is what the
    // announce's percent — a page scrubber's whole input — divides by, so
    // keep asking until it actually arrives.
    const knock = () => {
      if ((s.ready && s.duration != null) || tries++ >= KNOCK_TRIES) return;
      if (!s.ready) {
        post({ method: 'addEventListener', value: 'seeked' });
        post({ method: 'addEventListener', value: 'play' });
        // not for us to act on — it re-arms the synthetic `play` below. Subscribe
        // rather than rely on the page's own SDK having asked for it: on a page
        // that doesn't, the player would never broadcast one and the announce
        // would stay stale after a real pause.
        post({ method: 'addEventListener', value: 'pause' });
      }
      post({ method: 'getDuration' });
      env.nSetTimeout(knock, KNOCK_INTERVAL);
    };
    knock();
    s.pause = () => pauseCmd();
    s.onMessage = (data) => {
      // Ack accounting (see the adapter comment above). Checked before the
      // ready flip so a page pause that lands as the very first message isn't
      // misattributed to the pause the flip is about to post. A lost ack
      // degrades gracefully: the counter stays high and a later page pause
      // goes unnoticed — best-effort, never a false freeze.
      if (data.method === 'pause') {
        if (ownPauses > 0) ownPauses--;
        else if (!s.pagePaused) {
          s.pagePaused = true;
          s.pauseAt = s.want != null ? s.want : s.currentTime;
          s.pauseAnnounced = false;
          slot.settle(); // a video that just stopped shouldn't hold the frame open for its seek ack
        }
      }
      // This controller never posts play, so a play ack is always the page's.
      // Real playback does start in the iframe for a moment — the autoplay
      // defense below re-pauses it when the play event lands — and the
      // controller resumes driving by seeks from where the page left off.
      if (data.method === 'play' && s.pagePaused) {
        s.pagePaused = false;
        s.resumePending = true;
      }
      if (!s.ready) {
        // any answer from this window means the player API is live
        s.ready = true;
        pauseCmd();
        post({ method: 'setVolume', value: 0 });
      }
      if (data.method === 'getDuration' && typeof data.value === 'number') s.duration = data.value;
      // duration also rides along on every event the player broadcasts
      // (seeked, timeupdate, durationchange…) — harvest it wherever it
      // appears, so a lost getDuration ack can't starve the scrubber
      if (data.data && typeof data.data.duration === 'number' && data.data.duration > 0) {
        s.duration = data.data.duration;
      }
      if (data.event === 'play') pauseCmd(); // autoplay defense: the iframe runs on the real clock
      // that pause lands as a real `pause` the page hears too, undoing our
      // synthetic `play` — re-arm so the next announce restates it
      if (data.event === 'pause') s.playAnnounced = false;
      const sec = data.event === 'seeked' && data.data && typeof data.data.seconds === 'number'
        ? data.data.seconds
        : data.method === 'setCurrentTime' && typeof data.value === 'number' ? data.value : null;
      if (sec != null) {
        s.currentTime = sec;
        // the page scrubbed while paused (its own pause+setCurrentTime flow):
        // the resume point moves with it — FIFO means our own seek acks all
        // landed before the page pause was detected, so this seek is the page's
        if (s.pagePaused) s.pauseAt = sec;
        slot.ackTime(sec);
      }
    };
    s.seek = (tSec) => {
      if (!s.ready) return null;
      if (s.pagePaused) return null; // the page said stop: hold the frame it stopped on
      if (s.resumePending) {
        // the timeline spent between pause and play is subtracted from the
        // embed's clock from here on, so playback continues from pauseAt —
        // a scrub while paused may make the skew negative (a forward jump)
        s.resumePending = false;
        s.skew = tSec - (s.pauseAt || 0);
        s.pauseAt = null;
      }
      const target = seekTarget(tSec - s.skew, env.fps, s.duration);
      s.want = target;
      const p = slot.arm(iframe, target);
      pauseCmd();
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
     * have stopped: pin one final timeupdate at the duration, then go quiet
     * the way a really-ended player does. A backwards jump revives the
     * stream, like a real re-seek.
     *
     * `play` is synthesized too, once, ahead of the first timeupdate. The
     * player genuinely is paused, so this is a lie — but the alternative is a
     * worse one: the control's own autoplay defense pauses the embed, the page
     * SDK hears that real `pause`, and every frame of the output shows a play
     * button sitting on the wrong icon while the video visibly advances behind
     * it. A wrong control on every frame is a wrong recording. The cost is
     * real and accepted: a page's play handler runs during the render, so
     * analytics beacons fire and pause-other-players logic runs. A page that
     * can't take that wants mode 'freeze' or 'ignore'. A page that *pauses*
     * in response — pause-on-scroll, pause-when-hidden — is not fought,
     * though: its pause command is detected through the ack accounting in
     * onMessage and honored, freezing the embed until the page plays again.
     *
     * Deliberately NOT synthesized, so a future adapter author doesn't
     * "complete" this into a bug:
     * - pause, except the page-commanded case below: the page hears the
     *   player's real pauses, and an unprompted synthetic one would only undo
     *   the `play` above.
     * - ended: state-shaped, and empirically hazardous — pages close or hide
     *   their player UI when the video finishes, so a forged `ended` blanks
     *   the embed for the rest of the render (this happened on a real site;
     *   an early version here forged it and the player vanished). The pinned
     *   final timeupdate at percent 1 carries the same information without
     *   commanding anyone's UI. Past the end no `play` is announced either —
     *   a stopped player isn't playing.
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
      const emit = (event, data) => {
        announcing = true;
        try { env.dispatchMessage(iframe, JSON.stringify({ event, data })); }
        finally { announcing = false; }
      };
      if (s.pagePaused) {
        // The pause the page asked for really landed — on an already-paused
        // player, which transitions nothing and so broadcasts nothing. State
        // the transition once, or the UI the page paused *for* never flips.
        if (!s.pauseAnnounced) {
          s.pauseAnnounced = true;
          s.playAnnounced = false; // the eventual resume restates play
          emit('pause', payload(s.pauseAt || 0));
        }
        return; // a paused player is quiet: no timeupdates until the page plays
      }
      const media = tSec - s.skew;
      const past = s.duration > 0 && media + 0.5 / env.fps > s.duration - 0.05; // seekTarget's clamp condition
      if (!past) {
        s.endAnnounced = false;
        const at = payload(s.want != null ? s.want : seekTarget(media, env.fps, s.duration));
        // `play` before `timeupdate`: a page that gates its scrubber on play
        // state has to be playing before the time it renders arrives
        if (!s.playAnnounced) {
          s.playAnnounced = true;
          emit('play', at);
        }
        emit('timeupdate', at);
        return;
      }
      if (s.endAnnounced) return;
      s.endAnnounced = true;
      emit('timeupdate', payload(s.duration));
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
// Page-commanded pauses (honored on Vimeo via method-ack accounting) cannot
// be detected here: the widget has no per-command acks, only broadcast
// infoDelivery, and a page pauseVideo on the already-paused player changes no
// playerState — it's invisible from the top frame.
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
    const s = { provider: 'youtube', ready: false, duration: null, currentTime: 0, want: null, birth: null };
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
    if (announcing) return; // our own announce, echoed back by the dispatcher
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

  let everSynced = false;

  function sync(tSec) {
    if (env.mode !== 'sync') {
      if (env.mode === 'freeze') sessions.forEach((s) => { if (s.ready) s.pause(); });
      return Promise.resolve();
    }
    // Birth time, the embed analogue of an animation's: an embed that mounts
    // mid-capture (a click-opened overlay player) plays from its own zero.
    // Seeking it to the render's global clock would start it mid-video — or
    // past its end entirely for a spot shorter than the render, freezing it
    // on its last frame before it ever showed one. Sessions present at the
    // first sync were there from the start, so global time IS their time.
    sessions.forEach((s) => { if (s.birth == null) s.birth = everSynced ? tSec : 0; });
    everSynced = true;
    const waits = [];
    const locals = new Map();
    sessions.forEach((s) => {
      const local = Math.max(0, tSec - s.birth);
      locals.set(s, local);
      const p = s.seek(local);
      if (p) waits.push(p);
    });
    const settled = waits.length ? Promise.all(waits) : Promise.resolve();
    // announce after the seeks settle and before the caller paints, so a page
    // SDK reacting to the synthetic event has its DOM update in the frame
    return settled.then(() => {
      sessions.forEach((s) => { if (s.announce) s.announce(locals.get(s)); });
    });
  }

  /**
   * Assign birth times without seeking — what a walked-but-not-captured frame
   * needs. The batched walk calls this instead of sync(), so an embed that
   * mounts mid-walk still anchors its clock to the frame it appeared on
   * rather than to the first frame that actually renders.
   */
  function stamp(tSec) {
    if (env.mode !== 'sync') return;
    sessions.forEach((s) => { if (s.birth == null) s.birth = everSynced ? tSec : 0; });
    everSynced = true;
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

  return { scan, sync, stamp, ready, count: () => sessions.size, report };
}

globalThis.TapewormEmbeds = { createController };
})();
