/**
 * The in-page runtime, injected via Page.addScriptToEvaluateOnNewDocument so it
 * lands *before* the page's own scripts and can override the clock they capture.
 *
 * Everything that depends on time is driven from a frame index instead of the wall
 * clock, which is what makes frames independent of each other (and therefore what
 * makes parallel rendering safe):
 *
 *   scroll     -> scrollTo({behavior:'instant'})
 *   animations -> document.getAnimations(), paused, currentTime set per frame
 *   video      -> paused, currentTime seeked, awaited via requestVideoFrameCallback
 *   JS timers  -> virtual clock (Date.now / performance.now / rAF / setTimeout)
 *
 * Scroll-driven animations are deliberately left alone: they're a pure function of
 * scroll offset, so setting the offset already puts them in the right place.
 */

import { readFileSync } from 'node:fs';
import type { Resolved } from './types.ts';

/**
 * The shared core, concatenated AHEAD of the payload rather than pasted into the
 * template literal — so those files may contain backticks and ${} freely, and the
 * extension can ship the very same files verbatim as content scripts.
 */
const SHARED_FILES = ['easing-core.js', 'anchor-core.js', 'selector.js', 'gesture-core.js'] as const;

export function sharedCoreSource(): string {
  return SHARED_FILES
    .map((f) => readFileSync(new URL(`./shared/${f}`, import.meta.url), 'utf8'))
    .join('\n');
}

export function runtimeSource(cfg: Resolved): string {
  const opts = JSON.stringify({
    fps: cfg.fps,
    clock: cfg.page.clock,
    seekAnimations: cfg.page.seekAnimations,
    video: cfg.page.video,
    dismissConsent: cfg.page.dismissConsent,
    hideOverlays: cfg.page.hideOverlays,
    cursor: cfg.page.cursor,
    css: cfg.page.css,
  });

  return sharedCoreSource() + `\n(() => {
'use strict';
if (window.__sr) return;
const OPT = ${opts};

// anchor resolution and scroll primitives come from the shared core, so the
// authoring tools and the renderer cannot drift apart
const { maxScroll, setScroll, visibleRect, resolveAnchor, discoverSections } = globalThis.TapewormAnchors;

// ---------------------------------------------------------------- natives
const nRaf = window.requestAnimationFrame.bind(window);
const nCaf = window.cancelAnimationFrame.bind(window);
const nSetTimeout = window.setTimeout.bind(window);
const nClearTimeout = window.clearTimeout.bind(window);
const nDate = window.Date;
const nPerfNow = window.performance.now.bind(window.performance);
const DATE_ORIGIN = nDate.now();

// ---------------------------------------------------------------- clock
let mode = 'live';         // 'live' while loading/pre-warming, 'stepped' while capturing
let vnow = 0;              // virtual ms since start
let liveAnchor = nPerfNow();
let rafQueue = [];         // {id, cb}
let timers = [];           // {id, at, cb, interval}
let nextId = 1;

function flush() {
  // timers first, then rAF — matches the order a real frame would run them in
  for (let guard = 0; guard < 64; guard++) {
    const due = timers.filter((t) => t.at <= vnow).sort((a, b) => a.at - b.at);
    if (!due.length) break;
    for (const t of due) {
      if (t.interval == null) timers = timers.filter((x) => x !== t);
      else t.at = vnow + Math.max(1, t.interval);
      try { t.cb(); } catch (e) { /* page's problem, not ours */ }
    }
  }
  const batch = rafQueue;
  rafQueue = [];
  for (const r of batch) { try { r.cb(vnow); } catch (e) {} }
}

function liveLoop() {
  if (mode === 'live') { vnow = nPerfNow() - liveAnchor; flush(); }
  nRaf(liveLoop);
}
nRaf(liveLoop);

if (OPT.clock === 'virtual') {
  window.requestAnimationFrame = function (cb) {
    const id = nextId++;
    rafQueue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafQueue = rafQueue.filter((r) => r.id !== id); };
  window.setTimeout = function (cb, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = nextId++;
    const fn = typeof cb === 'function' ? () => cb.apply(null, args) : () => { try { eval(String(cb)); } catch (e) {} };
    timers.push({ id, at: vnow + (Number(ms) || 0), cb: fn, interval: null });
    return id;
  };
  window.setInterval = function (cb, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.push({ id, at: vnow + every, cb: () => cb.apply(null, args), interval: every });
    return id;
  };
  window.clearTimeout = window.clearInterval = function (id) { timers = timers.filter((t) => t.id !== id); };

  const VDate = function (...args) {
    if (!(this instanceof VDate)) return new nDate(DATE_ORIGIN + vnow).toString();
    return args.length === 0 ? new nDate(DATE_ORIGIN + vnow) : new nDate(...args);
  };
  VDate.prototype = nDate.prototype;
  VDate.now = () => DATE_ORIGIN + vnow;
  VDate.parse = nDate.parse;
  VDate.UTC = nDate.UTC;
  window.Date = VDate;
  try { window.performance.now = () => vnow; } catch (e) {}
}

// ---------------------------------------------------------------- videos
const videos = new Set();
function trackVideo(v) {
  if (videos.has(v) || OPT.video === 'ignore') return;
  videos.add(v);
  try { v.muted = true; v.autoplay = false; v.pause(); } catch (e) {}
}
function scanVideos(root) {
  if (!root || !root.querySelectorAll) return;
  if (root.tagName === 'VIDEO') trackVideo(root);
  root.querySelectorAll('video').forEach(trackVideo);
}

function nearViewport(el) {
  try {
    const r = el.getBoundingClientRect();
    return r.bottom > -200 && r.top < innerHeight + 200 && r.width > 0 && r.height > 0;
  } catch (e) { return false; }
}

function seekVideo(v, tSec) {
  const dur = v.duration;
  if (!isFinite(dur) || dur <= 0) return null;          // live stream / not loaded
  if (!v.seekable || v.seekable.length === 0) return null;
  // half-frame bias: seeking to an exact frame boundary is ambiguous and lands
  // on either side of it depending on the container's timestamp rounding
  let target = tSec + 0.5 / OPT.fps;
  if (v.loop || target > dur) target = target % dur;
  target = Math.min(Math.max(target, 0), Math.max(0, dur - 1e-3));
  try { v.pause(); } catch (e) {}
  v.__srWant = target;
  if (Math.abs(v.currentTime - target) < 1e-4) return null;

  const visible = nearViewport(v);
  const p = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (visible && typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback(() => finish());
    } else {
      v.addEventListener('seeked', finish, { once: true });
    }
    // never let one stubborn element hang the whole render
    nSetTimeout(finish, visible ? 1200 : 250);
  });
  try { v.currentTime = target; } catch (e) { return null; }
  return p;
}

function syncVideos(tSec) {
  if (OPT.video === 'ignore') return Promise.resolve();
  if (OPT.video === 'freeze') { videos.forEach((v) => { try { v.pause(); } catch (e) {} }); return Promise.resolve(); }
  const waits = [];
  videos.forEach((v) => { const p = seekVideo(v, tSec); if (p) waits.push(p); });
  return waits.length ? Promise.all(waits) : Promise.resolve();
}

// ---------------------------------------------------------------- images
/**
 * Images that entered the viewport this frame may still be in flight. Without
 * waiting, a lazy image reveals as a fade-in of an empty box followed by a pop.
 * Cheap when nothing is pending, which is the normal case after a pre-warm.
 */
function pendingImages() {
  const out = [];
  const imgs = document.images || [];
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    if (img.complete) continue;
    if (!img.currentSrc && !img.src) continue;
    let r;
    try { r = img.getBoundingClientRect(); } catch (e) { continue; }
    if (r.bottom < -innerHeight || r.top > innerHeight * 2) continue;   // far off-screen
    out.push(img);
  }
  return out;
}

function waitForImages(budgetMs) {
  const list = pendingImages();
  if (!list.length) return Promise.resolve(0);
  const each = list.map((img) => new Promise((res) => {
    const done = () => { try { img.decode().then(res, res); } catch (e) { res(); } };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', res, { once: true });
  }));
  return Promise.race([
    Promise.all(each),
    new Promise((res) => nSetTimeout(res, budgetMs)),
  ]).then(() => list.length);
}

// ---------------------------------------------------------------- animations
/**
 * When each animation was first seen, in virtual ms. Without this, an animation
 * that starts mid-render (a scroll reveal, say) gets currentTime = absolute render
 * time, which is far past its duration — so it snaps to completed in a single frame
 * instead of animating. Anything already running at frame 0 gets birth 0, which is
 * what you want for a decorative infinite loop.
 */
let animBirth = new WeakMap();

/**
 * Where each animation stood when the page finished preparing, captured BEFORE any
 * frame is rendered. Reading it live at beginCapture time would be too late: rendering
 * even one probe frame seeks animations, so the original position is already gone.
 */
let animOrigin = new WeakMap();

function seekAnimations(ms) {
  if (!OPT.seekAnimations || !document.getAnimations) return;
  let anims;
  try { anims = document.getAnimations(); } catch (e) { return; }
  for (const a of anims) {
    try {
      // A non-document timeline means a ScrollTimeline/ViewTimeline: progress-based,
      // already correct because we set the scroll offset. Touching it would break it.
      if (a.timeline && typeof DocumentTimeline !== 'undefined' && !(a.timeline instanceof DocumentTimeline)) continue;
      if (!animBirth.has(a)) animBirth.set(a, ms);
      if (a.playState !== 'paused') a.pause();
      a.currentTime = Math.max(0, ms - animBirth.get(a));
    } catch (e) {}
  }
}

// ---------------------------------------------------------------- hygiene
const HYGIENE = [
  'html,body{scroll-behavior:auto !important;overscroll-behavior:none !important}',
  '*{overflow-anchor:none !important}',
  '*{caret-color:transparent !important}',
  '*:focus,*:focus-visible{outline:none !important}',
  '::selection{background:transparent !important}',
  'html{-webkit-tap-highlight-color:transparent !important}',
  '*{content-visibility:visible !important}',
  '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important}',
].join('');

function injectCSS(text, id) {
  const s = document.createElement('style');
  s.id = id;
  s.textContent = text;
  (document.head || document.documentElement).appendChild(s);
}

// ---------------------------------------------------------------- consent + overlays
const ACCEPT = /^(accept|accept all|allow all|agree|i agree|ok|got it|continue|understood|alles akzeptieren|akzeptieren|tout accepter|godta|aksepter|acceptera alla)$/i;
const REJECT = /^(reject all|reject|decline|necessary only|only necessary|essential only|use necessary cookies only|refuse|avvis alle|neka alla)$/i;

function dismissConsent() {
  if (!OPT.dismissConsent) return false;
  const clickable = Array.from(document.querySelectorAll('button,a[role=button],[role=button],input[type=button],input[type=submit]'));
  const score = (el) => {
    const txt = (el.innerText || el.value || '').trim();
    if (!txt || txt.length > 40) return 0;
    if (!visibleRect(el)) return 0;
    // prefer rejecting: fewer cookies, and "reject" rarely opens a second dialog
    if (REJECT.test(txt)) return 2;
    if (ACCEPT.test(txt)) return 1;
    return 0;
  };
  const best = clickable.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
  if (best) { try { best.el.click(); } catch (e) {} }

  // whatever the dialog did to the body, undo it
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('position', 'static', 'important');
    el.style.setProperty('height', 'auto', 'important');
  }
  return !!best;
}

function isOverlay(el) {
  const st = getComputedStyle(el);
  if (st.position !== 'fixed' && st.position !== 'sticky') return false;
  const r = visibleRect(el);
  if (!r) return false;
  const coverage = (r.width * r.height) / (innerWidth * innerHeight);
  const z = parseInt(st.zIndex, 10) || 0;
  // a top nav is fixed too — keep anything short and anchored near the top
  const isTopBar = r.top <= 4 && r.height < innerHeight * 0.25;
  const isBottomBar = r.bottom >= innerHeight - 4 && r.height < innerHeight * 0.12;
  if (isTopBar || isBottomBar) return false;
  return coverage > 0.25 || (z >= 1000 && coverage > 0.05);
}

function hideOverlays() {
  if (!OPT.hideOverlays) return 0;
  let n = 0;
  for (const el of Array.from(document.body ? document.body.children : [])) {
    try { if (isOverlay(el)) { el.style.setProperty('display', 'none', 'important'); n++; } } catch (e) {}
  }
  return n;
}

// ---------------------------------------------------------------- drawn cursor
// Screenshots never contain the real pointer, so a recorded gesture is invisible
// unless a sprite is drawn into the page. Kept out of the page's way three
// times over: pointer-events none (no hit-testing), the __tw- class prefix
// (the selector generator refuses those), and a documentElement parent
// (hideOverlays only scans body children, and discoverSections roots elsewhere).
let cursorEl = null;
let cursorImgs = null;   // auto mode: sprite name -> its (pre-created) <img>
let cursorShown = '';    // auto mode: which sprite is currently displayed

function ensureCursor() {
  if (cursorEl) return cursorEl;
  const cur = OPT.cursor; // false, { auto: {name: {url, tipX, tipY, size}} }, or one { image, tipX, tipY, size }
  cursorEl = document.createElement('div');
  cursorEl.className = '__tw-cursor';
  cursorEl.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483647;' +
    'pointer-events:none;transform:translate(-9999px,-9999px);will-change:transform;' +
    (cur.auto ? '' : 'transform-origin:' + cur.tipX + 'px ' + cur.tipY + 'px;');
  if (cur.auto) {
    // Every sprite exists (hidden) from the start, so switching mid-gesture is
    // a display toggle between already-decoded images, never a fresh decode.
    cursorImgs = {};
    for (const name in cur.auto) {
      const img = document.createElement('img');
      img.src = cur.auto[name].url;
      img.style.cssText = 'display:none;width:' + cur.auto[name].size + 'px;height:auto';
      cursorImgs[name] = img;
      cursorEl.appendChild(img);
    }
  } else {
    cursorEl.innerHTML = cur.image
      ? '<img src="' + cur.image.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '" ' +
        'style="display:block;width:' + cur.size + 'px;height:auto">'
      : '<svg width="' + cur.size + '" height="' + cur.size + '" viewBox="0 0 24 24">' +
        '<path d="M5.5 3.2 L18.8 11.7 L12.4 12.9 L9.4 19.4 Z" ' +
        'fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }
  document.documentElement.appendChild(cursorEl);
  return cursorEl;
}

// CSS cursor keyword -> macOS sprite. Values with no counterpart in the set
// (text/ibeam, most resize directions) fall back to the arrow.
const CURSOR_BY_CSS = {
  default: 'cursor', auto: 'cursor',
  pointer: 'pointinghand',
  grab: 'openhand', grabbing: 'closedhand',
  move: 'move', 'all-scroll': 'move',
  copy: 'copy', alias: 'copy',
  help: 'help',
  'not-allowed': 'notallowed', 'no-drop': 'notallowed',
  'zoom-in': 'zoomin', 'zoom-out': 'zoomout',
  'nesw-resize': 'resizenortheastsouthwest',
  crosshair: 'screenshotselection',
};

/**
 * Which macOS sprite belongs at (x, y): the CSS cursor in effect on the
 * topmost element under the point. A pure function of pointer position and
 * document state, so frames stay independent. The sprite itself is
 * pointer-events:none and never hit-tests.
 */
function autoCursorName(x, y, down) {
  let css = 'default';
  try {
    const el = document.elementFromPoint(x, y);
    if (el) css = getComputedStyle(el).cursor || 'default';
  } catch (e) {}
  // computed value may be a list — "url(sprite.png) 4 4, pointer" — where the
  // mandatory trailing keyword is what the custom image degrades to
  const name = CURSOR_BY_CSS[css.split(',').pop().trim()] || 'cursor';
  return down && name === 'openhand' ? 'closedhand' : name;
}

/** c = {x, y, down} places the sprite (tip on the point); null hides it. */
function drawCursor(c) {
  if (!OPT.cursor) return;
  if (c == null) {
    if (cursorEl) cursorEl.style.transform = 'translate(-9999px,-9999px)';
    return;
  }
  const el = ensureCursor();
  let tipX, tipY;
  if (cursorImgs) {
    const name = autoCursorName(c.x, c.y, c.down);
    if (name !== cursorShown) {
      if (cursorShown) cursorImgs[cursorShown].style.display = 'none';
      cursorImgs[name].style.display = 'block';
      cursorShown = name;
    }
    const sprite = OPT.cursor.auto[name];
    tipX = sprite.tipX;
    tipY = sprite.tipY;
    el.style.transformOrigin = tipX + 'px ' + tipY + 'px'; // press shrink pivots on this sprite's hotspot
  } else {
    tipX = OPT.cursor.tipX;
    tipY = OPT.cursor.tipY;
  }
  el.style.transform =
    'translate(' + (c.x - tipX) + 'px,' + (c.y - tipY) + 'px)' +
    (c.down ? ' scale(0.88)' : '');
}

// ---------------------------------------------------------------- lazy content
function eagerize(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('img[loading="lazy"],iframe[loading="lazy"]').forEach((el) => { el.loading = 'eager'; });
  root.querySelectorAll('img[decoding="async"]').forEach((el) => { el.decoding = 'sync'; });
  root.querySelectorAll('[data-src]:not([src]),[data-srcset]:not([srcset])').forEach((el) => {
    if (el.dataset.src && !el.src) el.src = el.dataset.src;
    if (el.dataset.srcset && !el.srcset) el.srcset = el.dataset.srcset;
  });
}

// ---------------------------------------------------------------- smooth-scroll hijackers
function neutraliseHijackers() {
  const notes = [];
  try {
    if (window.__srLenis) { window.__srLenis.stop(); notes.push('lenis'); }
    else if (window.lenis && window.lenis.stop) { window.lenis.stop(); notes.push('lenis'); }
  } catch (e) {}
  try {
    const S = window.ScrollSmoother;
    if (S && S.get && S.get()) { S.get().smooth(0); S.get().paused(true); notes.push('scrollsmoother'); }
  } catch (e) {}
  try {
    if (window.ScrollTrigger && window.ScrollTrigger.normalizeScroll) {
      window.ScrollTrigger.normalizeScroll(false);
      notes.push('scrolltrigger');
    }
  } catch (e) {}
  return notes;
}

// Stash a Lenis instance the moment it's constructed — sites rarely expose one.
try {
  let _L;
  Object.defineProperty(window, 'Lenis', {
    configurable: true,
    get() { return _L; },
    set(v) {
      _L = typeof v === 'function' ? new Proxy(v, {
        construct(target, args, nt) { const i = Reflect.construct(target, args, nt); window.__srLenis = i; return i; },
      }) : v;
    },
  });
} catch (e) {}

// ---------------------------------------------------------------- boot
function boot() {
  injectCSS(HYGIENE, '__sr_hygiene');
  if (OPT.css) injectCSS(OPT.css, '__sr_user_css');
  scanVideos(document);
  eagerize(document);
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      for (const n of rec.addedNodes) { scanVideos(n); eagerize(n); }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
if (document.documentElement) boot();
else document.addEventListener('readystatechange', boot, { once: true });

// ---------------------------------------------------------------- public API
window.__sr = {
  version: 1,
  setMode(m) {
    mode = m;
    if (m === 'live') liveAnchor = nPerfNow() - vnow;
  },
  /** Render one frame. Returns once the page is visually settled for it. */
  /**
   * Reset per-capture state. Call once before the frame loop.
   *
   * restartExisting=false (the default) stamps animations that are ALREADY running
   * with a negative birth equal to their current position, so they carry on from where
   * they are instead of rewinding. Without this, an intro animation you deliberately
   * waited out would replay from the beginning on frame 0 — the whole point of waiting
   * for it, undone.
   */
  beginCapture(restartExisting) {
    animBirth = new WeakMap();
    mode = 'stepped';
    vnow = 0;
    // Replacement cursor images (a custom sprite, or the whole auto set) are
    // created (hidden, off-screen) now rather than on their first drawn frame,
    // so the fetch/decode happens before filming — a sprite must not pop in
    // mid-gesture.
    if (OPT.cursor && (OPT.cursor.image || OPT.cursor.auto)) ensureCursor();
    if (!restartExisting && document.getAnimations) {
      try {
        for (const a of document.getAnimations()) {
          if (a.timeline && typeof DocumentTimeline !== 'undefined' && !(a.timeline instanceof DocumentTimeline)) continue;
          const t = animOrigin.has(a) ? animOrigin.get(a) : (typeof a.currentTime === 'number' ? a.currentTime : 0);
          animBirth.set(a, -t);
        }
      } catch (e) {}
    }
  },

  /** Record where every animation stands right now. Called once, after the page settles. */
  snapshotAnimations() {
    animOrigin = new WeakMap();
    if (!document.getAnimations) return 0;
    let n = 0;
    try {
      for (const a of document.getAnimations()) {
        animOrigin.set(a, typeof a.currentTime === 'number' ? a.currentTime : 0);
        n++;
      }
    } catch (e) {}
    return n;
  },

  /**
   * How many finite animations are still running. Infinite ones are excluded: a
   * decorative loop never stops, so waiting on it would just burn the timeout.
   */
  busyAnimations() {
    if (!document.getAnimations) return 0;
    let n = 0;
    try {
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        let iters = 1;
        try { iters = a.effect.getTiming().iterations; } catch (e) {}
        if (iters === Infinity) continue;
        n++;
      }
    } catch (e) {}
    return n;
  },
  /**
   * Render one frame. Returns once the page is visually settled for it.
   *
   * y=null is a FREE frame: the scroll is left wherever the page has it. Used
   * while a client-side router transition plays — the router owns the scroll
   * (old view still at the click offset, jump-to-top when the new view mounts),
   * and imposing an offset would fight it on camera.
   *
   * cursor: {x, y, down} draws the sprite there, null hides it, undefined
   * (old callers) leaves it alone. Applied before the paint settle so the
   * sprite is in the screenshot.
   */
  async frame(y, tSec, imageBudgetMs, cursor) {
    mode = 'stepped';
    vnow = tSec * 1000;
    const actual = y == null ? window.scrollY : setScroll(y);
    flush();                    // timers + rAF at the virtual timestamp — this is
                                // where IntersectionObserver-driven reveals get added
    seekAnimations(vnow);       // ...so seek after the flush, not before
    const videoWait = syncVideos(tSec);
    const imgWait = waitForImages(imageBudgetMs == null ? 1500 : imageBudgetMs);
    await videoWait;
    const loaded = await imgWait;
    seekAnimations(vnow);       // late arrivals get their birth stamped here
    if (cursor !== undefined) drawCursor(cursor);
    await new Promise((r) => nRaf(() => nRaf(r)));   // let layout + paint settle
    return { scrollY: window.scrollY, requested: y, actual, max: maxScroll(), imagesAwaited: loaded };
  },
  /** Manual cursor control, same sprite frame() drives. */
  cursor(x, y, down) {
    drawCursor(x == null ? null : { x, y, down: !!down });
  },
  resolveAnchor,
  discoverSections,
  /**
   * Where to aim real input for an interaction target, in viewport CSS px.
   * Resolved at dispatch time, after the frame's scroll is applied — the same
   * element can sit anywhere depending on what earlier interactions did.
   */
  actionPoint(a) {
    const list = document.querySelectorAll(a.selector);
    const el = list[a.nth || 0];
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      x: Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
      y: Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight,
    };
  },
  dismissConsent,
  hideOverlays,
  neutraliseHijackers,
  eagerize: () => eagerize(document),
  maxScroll,
  setScroll,
  videoCount: () => videos.size,
  /**
   * Per-video health check. The common failure is a server that ignores HTTP Range
   * requests: currentTime assignment silently no-ops and every frame shows the same
   * picture, with no error anywhere.
   */
  videoReport() {
    return Array.from(videos).map((v) => {
      const want = v.__srWant;
      const src = (v.currentSrc || v.src || '(no src)');
      return {
        src: src.length > 70 ? '…' + src.slice(-68) : src,
        duration: isFinite(v.duration) ? v.duration : null,
        seekableRanges: v.seekable ? v.seekable.length : 0,
        readyState: v.readyState,
        currentTime: v.currentTime,
        wanted: want == null ? null : want,
        ok: want == null ? true : Math.abs(v.currentTime - want) < 0.05,
      };
    });
  },
  metrics() {
    return {
      scrollY: window.scrollY,
      max: maxScroll(),
      docHeight: document.documentElement.scrollHeight,
      videos: videos.size,
      animations: document.getAnimations ? document.getAnimations().length : 0,
      fontsReady: document.fonts ? document.fonts.status === 'loaded' : true,
    };
  },
};
})();`;
}
