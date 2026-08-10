/**
 * The authoring overlay: camera frame, element picker, real-time preview.
 *
 * Host-agnostic on purpose — this file never touches chrome.* APIs. The
 * extension connects it through content/bridge.js; `tapeworm author` injects
 * this same file over CDP and drives it directly. One overlay, two hosts, so
 * the two can't drift apart.
 *
 * Everything lives in a closed Shadow DOM on a max-z fixed host, so page CSS
 * can't reach in and our CSS can't leak out.
 *
 * Depends on the shared core globals: TapewormAnchors, TapewormEasing,
 * TapewormSelector, TapewormGesture (inject those files first).
 */
(() => {
'use strict';
if (globalThis.TapewormOverlay) return;

const A = globalThis.TapewormAnchors;
const E = globalThis.TapewormEasing;
const S = globalThis.TapewormSelector;
const G = globalThis.TapewormGesture;

let emit = () => {};
let host = null;
let shadow = null;
let els = {};
let settings = { width: 1280, height: 800, dpr: 2, fps: 60 };
let picking = false;
let pickMode = 'move'; // 'move' | 'click' | 'hover' — what the next pick records
let pickTarget = null;
let preview = null; // { segments, total, startWall, offsetSec, playing, raf }
let recording = null; // { t0, last:{x,y}|null, t:[], x:[], y:[], s:[], buttons:[], raf }
let lastGate = null;

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .vp-badge {
    position: fixed; right: 10px; top: 10px; z-index: 2; pointer-events: none;
    font-size: 11px; line-height: 1; padding: 5px 8px; border-radius: 4px;
    background: rgba(29, 122, 62, 0.92); color: #fff;
  }
  .vp-badge.warn { background: rgba(196, 60, 60, 0.94); max-width: 340px; line-height: 1.4; }
  .highlight {
    position: fixed; pointer-events: none; z-index: 3; display: none;
    background: rgba(64, 156, 255, 0.18); border: 1.5px solid rgba(64, 156, 255, 0.95);
    border-radius: 2px;
  }
  .tip {
    position: fixed; pointer-events: none; z-index: 4; display: none;
    background: #16181d; color: #e8eaf0; font-size: 12px; line-height: 1.45;
    padding: 6px 9px; border-radius: 4px; max-width: 480px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.35);
  }
  .tip .sel { font-family: ui-monospace, Menlo, monospace; }
  .tip .q { margin-left: 6px; padding: 1px 5px; border-radius: 3px; font-size: 10px; text-transform: uppercase; }
  .q-id, .q-data { background: #1d4a2a; color: #7fe3a1; }
  .q-class { background: #4a3d1d; color: #e3cb7f; }
  .q-structural { background: #4a1d1d; color: #e37f7f; }
  .shield {
    position: fixed; inset: 0; z-index: 6; display: none;
    pointer-events: auto;
  }
  .banner {
    position: fixed; z-index: 5; left: 50%; transform: translateX(-50%); top: 16px;
    display: none; background: #16181d; color: #e8eaf0; font-size: 13px;
    padding: 10px 14px; border-radius: 6px; max-width: 560px; text-align: center;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
  .rec-banner {
    position: fixed; z-index: 5; left: 50%; transform: translateX(-50%); top: 16px;
    display: none; background: #3a1518; color: #ffd9dc; font-size: 13px;
    padding: 10px 14px; border-radius: 6px; text-align: center;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
  .rec-banner::before {
    content: ''; display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: #ff4d57; margin-right: 8px; vertical-align: -1px;
  }
  .preview-cursor {
    position: fixed; z-index: 5; display: none; pointer-events: none;
    width: 14px; height: 14px; border-radius: 50%;
    background: rgba(22, 24, 29, 0.85); border: 2px solid #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4); transform: translate(-50%, -50%);
  }
  .preview-cursor.down { background: rgba(64, 156, 255, 0.95); }
`;

function mount(onEmit) {
  if (host) { emit = onEmit || emit; return; }
  emit = onEmit || emit;
  host = document.createElement('tapeworm-overlay');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  els.badge = div('vp-badge');
  els.highlight = div('highlight');
  els.tip = div('tip');
  // While a preview plays, the page scrolls under the user's REAL cursor and
  // Chrome natively re-hovers whatever passes beneath it — which isn't in the
  // timeline and won't be in the render. This transparent shield catches the
  // pointer during playback so only the timeline's own hovers apply.
  els.shield = div('shield');
  els.banner = div('banner');
  els.banner.textContent =
    'This page gates scrolling behind an intro. Scroll down manually to unlock it, then add keyframes. ' +
    '(The renderer unlocks it automatically at capture time.)';
  // The recording indicator is its own element, NOT els.banner: checkGate()
  // rewrites the gate banner's display on every scroll, and recording scrolls.
  els.recBanner = div('rec-banner');
  els.recBanner.textContent = 'Recording — press ESC to stop';
  els.previewCursor = div('preview-cursor');
  shadow.append(els.badge, els.highlight, els.tip, els.shield, els.banner, els.recBanner, els.previewCursor);
  document.documentElement.appendChild(host);

  addEventListener('resize', onResize, { passive: true });
  addEventListener('scroll', onScrollOrGate, { passive: true });
  layoutViewport();
  checkGate();

  function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
}

function destroy() {
  stopPicker();
  stopRecording();
  stopPreview(); // no keepHover: also un-hovers, stripping every __tw-hover class
  if (hoverRulesEl) { hoverRulesEl.remove(); hoverRulesEl = null; }
  removeEventListener('resize', onResize);
  removeEventListener('scroll', onScrollOrGate);
  if (host) host.remove();
  host = null; shadow = null; els = {};
  lastGate = null; // a later mount() must re-announce page:info
}

// ---------------------------------------------------------------- viewport match
/**
 * The render always captures the FULL viewport at the configured size, and the
 * page reflows at that size's breakpoint — so authoring must happen in a
 * viewport that IS that size, not a crop of a bigger one. `tapeworm author`
 * emulates it exactly; the extension fits the browser window to it. This badge
 * only reports the truth: green when the viewport matches the render target,
 * red (with why it matters) when it doesn't.
 */
function viewportMatched() {
  return Math.abs(innerWidth - settings.width) <= 1 && Math.abs(innerHeight - settings.height) <= 1;
}

function layoutViewport() {
  if (!els.badge) return;
  if (viewportMatched()) {
    els.badge.className = 'vp-badge';
    els.badge.textContent = 'recording viewport ' + settings.width + '×' + settings.height + ' ✓';
  } else {
    els.badge.className = 'vp-badge warn';
    els.badge.textContent =
      'window is ' + innerWidth + '×' + innerHeight + ', render viewport is ' +
      settings.width + '×' + settings.height + ' — the layout may sit at a different ' +
      'breakpoint. Use "Fit window" in the panel.';
  }
}

function onResize() {
  layoutViewport();
  emit('page:info', pageInfo());
}

function setSettings(next) {
  settings = Object.assign({}, settings, next || {});
  layoutViewport();
  return settings;
}

// ---------------------------------------------------------------- page info + scroll gate
function pageInfo() {
  return {
    url: location.href,
    title: document.title,
    maxScroll: A.maxScroll(),
    scrollY: window.scrollY,
    scrollGated: A.maxScroll() < 8,
    window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    target: { width: settings.width, height: settings.height },
    viewportMatched: viewportMatched(),
  };
}

function checkGate() {
  const gated = A.maxScroll() < 8;
  if (els.banner) els.banner.style.display = gated ? 'block' : 'none';
  if (gated !== lastGate) {
    lastGate = gated;
    emit('page:info', pageInfo());
  }
}

// ---------------------------------------------------------------- fetched assets
/**
 * A passive record of everything this document fetches — the list you consult
 * when writing `page.substitute` rules for the renderer. Resource Timing, not
 * chrome.webRequest: it needs no extra permissions (and this file stays
 * chrome-free), and it sees cross-origin CDN requests that an activeTab-scoped
 * listener never could. Starts at injection and never disconnects — closing
 * the panel unmounts the overlay, but shouldn't wipe the record. Entries from
 * before injection arrive via the buffered replay, capped by the page's own
 * timing buffer; everything a Warm up triggers is caught live. Top frame only:
 * iframes keep their own performance timelines.
 */
const fetchedAssets = new Map(); // url sans #fragment -> { type, bytes, requests }
try {
  new PerformanceObserver((entries) => {
    for (const e of entries.getEntries()) {
      const url = e.name.split('#')[0];
      if (!/^https?:/.test(url)) continue; // data:, blob:, extension internals
      let a = fetchedAssets.get(url);
      if (!a) { a = { type: e.initiatorType, bytes: 0, requests: 0 }; fetchedAssets.set(url, a); }
      a.requests++; // a <video> seeking issues many Range requests for one URL
      // transferSize is 0 for cache hits (encodedBodySize still real) and for
      // cross-origin responses without Timing-Allow-Origin (both 0 — unknowable).
      a.bytes += e.transferSize || e.encodedBodySize || 0;
    }
  }).observe({ type: 'resource', buffered: true });
} catch (e) { /* no Resource Timing — the export is just empty */ }

function assets() {
  const list = Array.from(fetchedAssets, ([url, a]) => ({
    url,
    type: a.type,
    bytes: a.bytes > 0 ? a.bytes : null, // null: cross-origin without Timing-Allow-Origin
    requests: a.requests,
  }));
  // Biggest first — the asset worth substituting is almost always near the top.
  list.sort((x, y) => (y.bytes || 0) - (x.bytes || 0));
  return { url: location.href, assets: list };
}

function onScrollOrGate() { checkGate(); }

// ---------------------------------------------------------------- picker
function startPicker(mode) {
  pickMode = mode === 'click' || mode === 'hover' ? mode : 'move';
  if (picking) return;
  picking = true;
  addEventListener('mousemove', onPickMove, true);
  addEventListener('click', onPickClick, true);
  addEventListener('keydown', onPickKey, true);
  // the cursor leaving the viewport (or the window losing focus) means there
  // is no hovered element — don't leave the last tooltip stranded
  document.documentElement.addEventListener('mouseleave', hidePickerHover, true);
  addEventListener('blur', hidePickerHover);
}

function stopPicker() {
  if (!picking) return;
  picking = false;
  removeEventListener('mousemove', onPickMove, true);
  removeEventListener('click', onPickClick, true);
  removeEventListener('keydown', onPickKey, true);
  document.documentElement.removeEventListener('mouseleave', hidePickerHover, true);
  removeEventListener('blur', hidePickerHover);
  hidePickerHover();
}

function hidePickerHover() {
  pickTarget = null;
  if (els.highlight) els.highlight.style.display = 'none';
  if (els.tip) els.tip.style.display = 'none';
}

function pickableAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === host || el === document.documentElement || el === document.body) return null;
  return el;
}

function onPickMove(ev) {
  const el = pickableAt(ev.clientX, ev.clientY);
  pickTarget = el;
  if (!el) {
    els.highlight.style.display = 'none';
    els.tip.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  const h = els.highlight.style;
  h.display = 'block';
  h.left = r.left + 'px'; h.top = r.top + 'px';
  h.width = r.width + 'px'; h.height = r.height + 'px';

  let best;
  try { best = S.bestSelector(el); } catch (e) { best = null; }
  if (best) {
    els.tip.innerHTML = '';
    const sel = document.createElement('span');
    sel.className = 'sel';
    sel.textContent = best.selector + (best.nth ? ' [' + best.nth + ']' : '');
    const q = document.createElement('span');
    q.className = 'q q-' + best.quality;
    q.textContent = best.quality === 'structural' ? 'structural — fragile' : best.quality;
    els.tip.append(sel, q);
    const t = els.tip.style;
    t.display = 'block';
    t.left = Math.min(ev.clientX + 14, innerWidth - 300) + 'px';
    t.top = Math.min(ev.clientY + 18, innerHeight - 48) + 'px';
  }
}

function onPickClick(ev) {
  if (!picking) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const el = pickTarget || pickableAt(ev.clientX, ev.clientY);
  if (!el) return;
  let best;
  try { best = S.bestSelector(el); } catch (e) { return; }
  const anchor = { selector: best.selector };
  if (best.nth) anchor.nth = best.nth;
  if (best.fallbackText) anchor.fallbackText = best.fallbackText;
  emit('picker:picked', {
    mode: pickMode,
    anchor,
    quality: best.quality,
    unique: best.unique,
    resolvedY: safeResolve(anchor),
    // the page's URL at the moment of the pick — the panel's cached copy can
    // be stale (SPA route changes never re-announce page:info)
    url: location.href,
  });
}

function onPickKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    stopPicker();
    emit('picker:stopped', {});
  }
}

function safeResolve(anchor) {
  try { return A.resolveAnchor(anchor); } catch (e) { return null; }
}

// ---------------------------------------------------------------- recording
/**
 * Record mode: the user's REAL interactions — pointer movement, clicks/drags,
 * scrolling — sampled once per display frame until ESC. The raw samples become
 * one `record` step; the renderer replays them through Chrome's input
 * pipeline, so what was hovered here is hovered there. The shield stays OFF:
 * unlike preview playback, the real pointer must reach the page.
 *
 * rAF-driven sampling rather than raw pointermove: uniform at-most-display-
 * rate cadence (the decimation), and it captures scroll-only motion where the
 * pointer never moves. Everything is integer-rounded — sub-pixel precision is
 * below what input dispatch or the drawn cursor can express.
 */
const RECORD_MAX_MS = 120000; // storage hygiene: ~0.5 MB worst case, quota is 10 MB

function startRecording() {
  if (recording) return { error: 'already-recording' };
  if (preview && preview.playing) return { error: 'preview-playing' };
  stopPicker(); // ESC must mean exactly one thing at a time
  // the URL is captured at the START of the take: an SPA route change while
  // recording moves location.href, but the replay begins where this page was
  recording = { t0: performance.now(), url: location.href, last: null, t: [], x: [], y: [], s: [], buttons: [], raf: 0, clickTarget: null };
  addEventListener('pointermove', onRecPointer, { capture: true, passive: true });
  addEventListener('pointerdown', onRecDown, { capture: true, passive: true });
  addEventListener('pointerup', onRecUp, { capture: true, passive: true });
  addEventListener('keydown', onRecKey, true);
  addEventListener('pagehide', onRecPageHide);
  if (els.recBanner) els.recBanner.style.display = 'block';
  const sample = () => {
    if (!recording) return;
    const now = performance.now() - recording.t0;
    if (recording.last) {
      recording.t.push(Math.round(now));
      recording.x.push(recording.last.x);
      recording.y.push(recording.last.y);
      recording.s.push(Math.round(window.scrollY));
    }
    if (now >= RECORD_MAX_MS) { finishRecording(); return; }
    recording.raf = requestAnimationFrame(sample);
  };
  recording.raf = requestAnimationFrame(sample);
  return { recording: true };
}

function onRecPointer(ev) {
  if (recording) recording.last = { x: Math.round(ev.clientX), y: Math.round(ev.clientY) };
}

function onRecDown(ev) {
  if (!recording || ev.button !== 0) return;
  onRecPointer(ev);
  recording.buttons.push({ t: Math.round(performance.now() - recording.t0), action: 'down' });
  // If this click turns out to navigate, the take is split HERE and the click
  // becomes its own step — which needs a selector. Capture it now, while the
  // element (and the document) still exists; only the last one can matter.
  recording.clickTarget = null;
  try {
    const el = pickableAt(ev.clientX, ev.clientY);
    const best = el ? S.bestSelector(el) : null;
    if (best) {
      const anchor = { selector: best.selector };
      if (best.nth) anchor.nth = best.nth;
      if (best.fallbackText) anchor.fallbackText = best.fallbackText;
      recording.clickTarget = { anchor, quality: best.quality };
    }
  } catch (e) {}
}

function onRecUp(ev) {
  if (!recording || ev.button !== 0) return;
  recording.buttons.push({ t: Math.round(performance.now() - recording.t0), action: 'up' });
}

function onRecKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    finishRecording();
  }
}

function teardownRecording() {
  removeEventListener('pointermove', onRecPointer, true);
  removeEventListener('pointerdown', onRecDown, true);
  removeEventListener('pointerup', onRecUp, true);
  removeEventListener('keydown', onRecKey, true);
  removeEventListener('pagehide', onRecPageHide);
  if (recording && recording.raf) cancelAnimationFrame(recording.raf);
  if (els.recBanner) els.recBanner.style.display = 'none';
}

/**
 * The captured take as a record:done payload, rebased so the first sample is
 * t=0 (the lead time before the pointer was first seen is dead air nobody
 * wants in the video). `cutoffMs` — in raw recording time — cuts the take
 * short: samples after it and button edges at or after it are dropped, which
 * is how a split ends a take just before the click that navigated. null when
 * fewer than 2 samples survive.
 */
function buildTake(rec, cutoffMs) {
  let n = rec.t.length;
  if (cutoffMs != null) { while (n > 0 && rec.t[n - 1] > cutoffMs) n--; }
  if (n < 2) return null;
  const base = rec.t[0];
  const t = rec.t.slice(0, n).map((v) => v - base);
  const lastT = t[t.length - 1];
  const buttons = rec.buttons
    .filter((b) => cutoffMs == null || b.t < cutoffMs)
    .map((b) => ({ t: Math.min(Math.max(b.t - base, 0), lastT), action: b.action }))
    // a press armed before the first sample has no position to land on; a
    // recording also can't start mid-drag, so drop a leading orphaned 'up'
    .filter((b, i) => !(i === 0 && b.action === 'up'));
  return {
    samples: { t, x: rec.x.slice(0, n), y: rec.y.slice(0, n), s: rec.s.slice(0, n) },
    buttons: buttons.length ? buttons : undefined,
    // the ACTUAL viewport, not settings: the render refuses a mismatch, and
    // an honest stamp is what makes that check mean something
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    durationMs: lastT,
    url: rec.url,
  };
}

function finishRecording() {
  if (!recording) return;
  const rec = recording;
  recording = null;
  teardownRecording();
  const take = buildTake(rec);
  if (take) emit('record:done', take);
  else emit('record:cancelled', {});
}

/**
 * The document is being torn down mid-recording: a recorded click navigated
 * (or the user reloaded / typed a URL). The samples from here on can never be
 * captured, and the ones after the last click show a page on its way out. So
 * the take is SPLIT at that click — everything before it stays a record step,
 * the click itself becomes a click step (a real navigation at render time,
 * exactly like an authored one), and the panel resumes recording on the
 * destination. When no recorded click can be blamed, the take is simply
 * finished as-is. Emitted synchronously — this is the page's last breath, an
 * async hop would lose the take.
 */
function onRecPageHide() {
  if (!recording) return;
  const rec = recording;
  recording = null;
  teardownRecording();
  const downs = rec.buttons.filter((b) => b.action === 'down');
  const lastDown = downs[downs.length - 1];
  if (!lastDown || !rec.clickTarget) {
    const take = buildTake(rec);
    if (take) emit('record:done', take);
    else emit('record:cancelled', {});
    return;
  }
  emit('record:split', {
    take: buildTake(rec, lastDown.t), // null when the click came almost immediately
    click: rec.clickTarget,
    url: rec.url, // the take may be null — the split still knows its page
  });
}

/** Panel-side disarm: same as ESC — keep what was captured rather than lose it. */
function stopRecording() {
  finishRecording();
}

// ---------------------------------------------------------------- hover emulation (preview only)
/**
 * The render performs hovers with REAL input (trusted, :hover just works).
 * A content script can't do that, so the preview approximates: synthetic
 * mouse events for JS-driven hover behaviour, plus a one-time clone of every
 * CSS :hover rule with a marker class — DevTools' "force element state"
 * trick — for the styling. Close enough to judge timing and framing by;
 * the render remains the truth.
 */
let hoverRulesEl = null;
let hoverEl = null;

function ensureHoverRules() {
  if (hoverRulesEl) return;
  const chunks = [];
  for (const sheet of Array.from(document.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin sheet
    for (const r of Array.from(rules || [])) {
      let text;
      try { text = r.cssText; } catch (e) { continue; }
      if (text && text.indexOf(':hover') !== -1) {
        chunks.push(text.split(':hover').join('.__tw-hover'));
      }
    }
  }
  hoverRulesEl = document.createElement('style');
  hoverRulesEl.id = '__tw_hover_rules';
  hoverRulesEl.textContent = chunks.join('\n');
  document.documentElement.appendChild(hoverRulesEl);
}

/**
 * Dispatch one synthetic event the way a real pointer would raise it:
 * pointer* types go out as PointerEvents (what modern listeners subscribe
 * to), over/out carry relatedTarget, enter/leave don't bubble, and the
 * coordinates are the actual pointer position when the caller knows it
 * (element centre otherwise). While a recorded press is held, every event
 * carries buttons=1 (`pressedButtons`) — drag libraries read the held state
 * off moves. Untrusted either way — isTrusted-gated libraries only respond
 * in the render.
 */
let pressedButtons = 0; // 1 while the gesture machine is replaying a held press

function fireMouse(el, type, opts) {
  opts = opts || {};
  try {
    let x = opts.x, y = opts.y;
    if (x == null || y == null) {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    const init = {
      bubbles: opts.bubbles !== false,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: opts.buttons != null ? opts.buttons : pressedButtons,
      // a11y-minded widgets tell pointer clicks from keyboard ones by detail
      detail: type === 'mousedown' || type === 'mouseup' || type === 'click' ? 1 : 0,
      relatedTarget: opts.related || null,
    };
    if (type.indexOf('pointer') === 0 || type === 'lostpointercapture') {
      init.pointerId = 1;
      init.pointerType = 'mouse';
      init.isPrimary = true;
      const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    } else {
      el.dispatchEvent(new MouseEvent(type, init));
    }
  } catch (e) {}
}

/** The element and its ancestors, innermost first. */
function chainOf(el) {
  const c = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) c.push(n);
  return c;
}

/** Make `anchor`'s element the hovered one (null = nothing hovered). */
function setPreviewHover(anchor) {
  let el = null;
  if (anchor) {
    try { el = document.querySelectorAll(anchor.selector)[anchor.nth || 0] || null; } catch (e) {}
  }
  setPreviewHoverEl(el);
}

/**
 * Same, from an element in hand — recordings hit-test rather than select.
 * Raises the full transition a real pointer move produces: pointerout/mouseout
 * on the old target, pointerleave/mouseleave up its chain to the common
 * ancestor, pointerover/mouseover on the new target, pointerenter/mouseenter
 * down into it (outermost first), then a move at the pointer position.
 */
function setPreviewHoverEl(el, x, y) {
  if (el === hoverEl) return;
  const prev = hoverEl;
  const prevChain = prev ? chainOf(prev) : [];
  const nextChain = el ? chainOf(el) : [];
  const nextSet = new Set(nextChain);
  const prevSet = new Set(prevChain);
  hoverEl = el;
  if (prev) {
    fireMouse(prev, 'pointerout', { related: el, x, y });
    fireMouse(prev, 'mouseout', { related: el, x, y });
    for (const n of prevChain) {
      if (nextSet.has(n)) break; // everything below the common ancestor was left
      fireMouse(n, 'pointerleave', { bubbles: false, related: el, x, y });
      fireMouse(n, 'mouseleave', { bubbles: false, related: el, x, y });
    }
    for (const n of prevChain) if (n.classList) n.classList.remove('__tw-hover');
  }
  if (el) {
    ensureHoverRules();
    fireMouse(el, 'pointerover', { related: prev, x, y });
    fireMouse(el, 'mouseover', { related: prev, x, y });
    const entered = nextChain.filter((n) => !prevSet.has(n)).reverse();
    for (const n of entered) {
      fireMouse(n, 'pointerenter', { bubbles: false, related: prev, x, y });
      fireMouse(n, 'mouseenter', { bubbles: false, related: prev, x, y });
    }
    fireMouse(el, 'pointermove', { x, y });
    fireMouse(el, 'mousemove', { x, y });
    // :hover applies to every ancestor of the hovered element too
    for (const n of nextChain) if (n.classList) n.classList.add('__tw-hover');
  }
}

/**
 * Synthetic click for a click STEP — down, up, click at the target anchor's
 * centre. Recorded presses go through the gesture machine below instead,
 * which spreads the edges over their real recorded times.
 */
function firePreviewClick(c) {
  let el = null;
  try { el = document.querySelectorAll(c.target.selector)[c.target.nth || 0] || null; } catch (e) {}
  if (!el) return;
  fireMouse(el, 'pointerdown', { buttons: 1 });
  fireMouse(el, 'mousedown', { buttons: 1 });
  fireMouse(el, 'pointerup', { buttons: 0 });
  fireMouse(el, 'mouseup', { buttons: 0 });
  fireMouse(el, 'click', { buttons: 0 });
}

// ---------------------------------------------------------------- recorded gesture replay (preview only)
/**
 * The render replays recorded presses as trusted CDP input; the preview
 * approximates them with synthetic events — enough to watch a drag land where
 * it landed live. A press becomes one gesture ({ tDown, tUp } against its
 * recording), driven tick by tick during playback (never on scrub):
 *
 *   - within DRAG_SLOP_PX of the press it's a click: pointerup/mouseup/click
 *     at the recorded spot, same routing behaviour as a click step;
 *   - past the slop with a `draggable="true"` source it's native HTML5 drag
 *     and drop: dragstart on the source, per-tick dragenter/dragover on
 *     whatever is under the pointer (a shared DataTransfer carries setData
 *     from dragstart to drop), drop where dragover was accepted, dragend
 *     always — mouse/hover emulation pauses meanwhile, as in a real drag;
 *   - past the slop otherwise it's a pointer-listener drag (dnd-kit,
 *     interact.js, sliders): the per-tick moves flow with buttons=1 through
 *     the normal hover machinery, or straight at the capturing element when
 *     the page grabbed the pointer — pointerId 1 IS the real mouse, so a
 *     library's setPointerCapture(1) in its pointerdown handler actually
 *     takes, and the machine honours it like the browser would.
 *
 * isTrusted-gated libraries still only respond in the render.
 */
const DRAG_SLOP_PX = 8;

/**
 * One native drag-and-drop event, on the sequence's shared DataTransfer so
 * dragstart's setData is readable at drop, like the real protocol (minus
 * protected mode — the preview has no reason to hide the payload). Returns
 * true when the page called preventDefault — how dragstart vetoes the drag
 * and dragover accepts a drop target.
 */
function fireDrag(el, type, dt, x, y) {
  try {
    const init = {
      bubbles: true,
      cancelable: type !== 'dragleave' && type !== 'dragend',
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      buttons: type === 'drop' || type === 'dragend' ? 0 : 1,
    };
    let ev;
    if (typeof DragEvent === 'function') {
      init.dataTransfer = dt;
      ev = new DragEvent(type, init);
    } else {
      ev = new MouseEvent(type, init);
      try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e) {}
    }
    return !el.dispatchEvent(ev);
  } catch (e) { return false; }
}

/** Land the press: hover the element under it, pointerdown/mousedown, note capture. */
function pressGesture(g) {
  const p = G.pointerAt(g.rec, g.tDown - g.recT0);
  const el = hitTest(p.x, p.y);
  const d = {
    g, source: el, x0: p.x, y0: p.y, x: p.x, y: p.y,
    dragging: false, native: null, dt: null, over: null, canDrop: false, capture: null,
  };
  if (!el) return d;
  setPreviewHoverEl(el, p.x, p.y); // a real press lands on an already-hovered element
  pressedButtons = 1;
  fireMouse(el, 'pointerdown', { x: p.x, y: p.y });
  fireMouse(el, 'mousedown', { x: p.x, y: p.y });
  for (const n of chainOf(el)) {
    try { if (n.hasPointerCapture && n.hasPointerCapture(1)) { d.capture = n; break; } } catch (e) {}
  }
  return d;
}

function moveGesture(d, p) {
  d.x = p.x; d.y = p.y;
  if (!d.source) return;
  if (!d.dragging && Math.hypot(p.x - d.x0, p.y - d.y0) > DRAG_SLOP_PX) {
    d.dragging = true;
    let src = null;
    try { src = d.source.closest ? d.source.closest('[draggable="true"]') : null; } catch (e) {}
    if (src) {
      try { d.dt = typeof DataTransfer === 'function' ? new DataTransfer() : null; } catch (e) {}
      try { if (d.dt) d.dt.effectAllowed = 'all'; } catch (e) {}
      if (!fireDrag(src, 'dragstart', d.dt, p.x, p.y)) {
        d.native = src;
        // starting a native drag cancels the pointer stream, as the browser does
        fireMouse(d.source, 'pointercancel', { x: p.x, y: p.y, buttons: 0 });
      }
      // dragstart preventDefault'ed: the page vetoed the native drag — stay pointer
    }
  }
  if (d.native) {
    fireDrag(d.native, 'drag', d.dt, p.x, p.y);
    const over = hitTest(p.x, p.y);
    if (over !== d.over) {
      if (over) fireDrag(over, 'dragenter', d.dt, p.x, p.y);
      if (d.over) fireDrag(d.over, 'dragleave', d.dt, p.x, p.y);
      d.over = over;
      d.canDrop = false;
    }
    if (over) d.canDrop = fireDrag(over, 'dragover', d.dt, p.x, p.y);
  } else if (d.capture) {
    fireMouse(d.capture, 'pointermove', { x: p.x, y: p.y });
    fireMouse(d.capture, 'mousemove', { x: p.x, y: p.y });
  }
  // no capture, not native: applyPreviewHover's per-tick move already tracks
  // the pointer, with buttons riding pressedButtons
}

function releaseGesture(d, p) {
  pressedButtons = 0;
  if (d.native) {
    if (d.over && d.canDrop) fireDrag(d.over, 'drop', d.dt, p.x, p.y);
    else if (d.over) fireDrag(d.over, 'dragleave', d.dt, p.x, p.y);
    fireDrag(d.native, 'dragend', d.dt, p.x, p.y);
    return;
  }
  const el = d.capture || hitTest(p.x, p.y);
  if (el) {
    fireMouse(el, 'pointerup', { x: p.x, y: p.y, buttons: 0 });
    fireMouse(el, 'mouseup', { x: p.x, y: p.y, buttons: 0 });
  }
  if (d.capture) {
    try { d.capture.releasePointerCapture(1); } catch (e) {}
    fireMouse(d.capture, 'lostpointercapture', { x: p.x, y: p.y, buttons: 0 });
  }
  // never left the slop: a click, aimed where the press landed — real clicks
  // target the mousedown element
  if (!d.dragging && d.source) fireMouse(d.source, 'click', { x: d.x0, y: d.y0, buttons: 0 });
}

/**
 * A preview stopped mid-press must not leave the page thinking the button is
 * still held — cancel the way the browser cancels an interrupted pointer.
 */
function abortGesture(d) {
  pressedButtons = 0;
  if (d.native) {
    if (d.over) fireDrag(d.over, 'dragleave', d.dt, d.x, d.y);
    fireDrag(d.native, 'dragend', d.dt, d.x, d.y);
    return;
  }
  const el = d.capture || d.source;
  if (!el) return;
  fireMouse(el, 'pointercancel', { x: d.x, y: d.y, buttons: 0 });
  fireMouse(el, 'pointerup', { x: d.x, y: d.y, buttons: 0 });
  fireMouse(el, 'mouseup', { x: d.x, y: d.y, buttons: 0 });
  if (d.capture) {
    try { d.capture.releasePointerCapture(1); } catch (e) {}
    fireMouse(d.capture, 'lostpointercapture', { x: d.x, y: d.y, buttons: 0 });
  }
}

/** Drive recorded presses as playback crosses them. `pv.gest` = { idx, active }. */
function applyPreviewGestures(pv, t) {
  const st = pv.gest;
  const gs = pv.geo.gestures;
  for (;;) {
    if (st.active) {
      const d = st.active;
      if (t < d.g.tUp) { moveGesture(d, G.pointerAt(d.g.rec, t - d.g.recT0)); return; }
      const up = G.pointerAt(d.g.rec, d.g.tUp - d.g.recT0);
      moveGesture(d, up); // land the pointer (and the drop target's dragover) first
      releaseGesture(d, up);
      st.active = null;
      continue; // the next press may be due in this same tick
    }
    const g = gs[st.idx];
    if (!g || t < g.tDown) return;
    st.idx++;
    st.active = pressGesture(g);
  }
}

/** What should be hovered at time t: the last hover before t, ended by any later interaction. */
function hoverAnchorAt(geo, t) {
  let current = null;
  for (const ev of geo.pointerEvents) {
    if (ev.t > t) break;
    current = ev.anchor;
  }
  return current;
}

/**
 * Where the recorded pointer is at this point in playback — undefined when t
 * is outside every record segment (the hover-step machinery owns hover
 * there), {x, y} inside one.
 */
function recPointerAt(geo, tSec) {
  const t = Math.max(0, Math.min(tSec, geo.total));
  for (const s of geo.segments) {
    if (s.rec && t >= s.t0 && t <= s.t1) return G.pointerAt(s.rec, t - s.t0);
  }
  return undefined;
}

/** elementFromPoint that sees through the playback shield and our own host. */
function hitTest(x, y) {
  const shieldPE = els.shield ? els.shield.style.pointerEvents : '';
  if (els.shield) els.shield.style.pointerEvents = 'none';
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch (e) {}
  if (els.shield) els.shield.style.pointerEvents = shieldPE;
  if (!el || el === host || el === document.documentElement || el === document.body) return null;
  return el;
}

/** During a record segment the recorded pointer owns hover; otherwise the hover steps do. */
function applyPreviewHover(geo, t) {
  const p = recPointerAt(geo, t);
  if (p === undefined) {
    setPreviewHover(hoverAnchorAt(geo, t));
    return;
  }
  const el = hitTest(p.x, p.y);
  if (el === hoverEl) {
    // moves are continuous while the pointer rides an element, not just on
    // the tick the hovered element changes — tooltips and menus track them
    if (el) {
      fireMouse(el, 'pointermove', { x: p.x, y: p.y });
      fireMouse(el, 'mousemove', { x: p.x, y: p.y });
    }
  } else {
    setPreviewHoverEl(el, p.x, p.y); // fires its own move at the pointer
  }
}

// ---------------------------------------------------------------- preview
/**
 * Resolve the timeline to piecewise segments ONCE at play/seek time, using the
 * same anchors, easing curves, auto-duration and hold defaults as the renderer's
 * timeline.ts — then drive TapewormAnchors.setScroll in real time.
 */
function buildGeometry(steps) {
  const segs = [];   // { t0, t1, from, to, easeFn, idx } — holds are from===to; idx = source step
  const pointerEvents = []; // { t, anchor|null } — hover starts / hover-ending interactions
  const clicks = []; // { t, target } — click steps, fired once as playback crosses them
  const gestures = []; // { tDown, tUp, rec, recT0 } — recorded presses, for the gesture machine
  let t = 0;
  let y = 0;
  const errors = [];
  let sawInteraction = false; // a click (step or recorded) upstream may navigate before later anchors are needed

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'start') {
      const r = safeResolve(step.at);
      if (r == null) { errors.push({ index: i, anchor: step.at }); continue; }
      y = r;
      const hold = step.hold != null ? step.hold : 0.8;
      segs.push({ t0: t, t1: t + hold, from: y, to: y, easeFn: null, idx: i });
      t += hold;
    } else if (step.type === 'hold') {
      segs.push({ t0: t, t1: t + step.seconds, from: y, to: y, easeFn: null, idx: i });
      t += step.seconds;
    } else if (step.type === 'move') {
      const target = safeResolve(step.to);
      if (target == null && !sawInteraction) { errors.push({ index: i, anchor: step.to }); continue; }
      let duration;
      if (target == null) {
        // Unresolvable HERE — but an earlier click may navigate before
        // playback arrives, and the render's rule is that anchors after an
        // interaction resolve wherever the timeline stands by then. So the
        // step keeps a placeholder span (a viewport-height move's worth when
        // the duration is auto) instead of being dropped; playback resolves
        // it on arrival and re-stretches the timeline to the real distance
        // (resolveDeferred). A scrubbed seek can't navigate, so there the
        // span plays as a hold at the current position.
        duration = step.duration != null
          ? step.duration
          : E.autoDuration(settings.height, settings.height, E.resolveEase(step.ease, 1));
        segs.push({ t0: t, t1: t + duration, from: y, to: null, easeFn: null, idx: i, defer: step });
      } else {
        const easeFn = E.resolveEase(step.ease, Math.abs(target - y) / settings.height);
        duration = step.duration != null
          ? step.duration
          : E.autoDuration(target - y, settings.height, easeFn);
        segs.push({ t0: t, t1: t + duration, from: y, to: target, easeFn, idx: i });
        y = target;
      }
      t += duration;
      const isLast = i === steps.length - 1;
      const hold = step.hold != null ? step.hold : (isLast ? 0.8 : 0.6);
      if (hold > 0) { segs.push({ t0: t, t1: t + hold, from: y, to: y, easeFn: null, idx: i }); t += hold; }
    } else if (step.type === 'record') {
      // The recorded scroll replays, a cursor dot traces the pointer, and the
      // point under it is hover-emulated per tick (hit-tested live — see
      // applyPreviewHover), all via the same gesture core the renderer
      // resolves with. Each recorded press becomes a gesture the machine
      // replays in playback (never on scrub), hit-tested at the recorded
      // pointer position (a recording captures where, not what): a stationary
      // down→up lands as a click — so one that routes client-side routes in
      // the preview too — and travel becomes a synthetic drag, pointer-
      // listener or native HTML5 (see the gesture machine above). The null
      // pointer event ends any earlier hover step's hover, and stands after
      // the recording too — the render parks the pointer there.
      pointerEvents.push({ t, anchor: null });
      const edges = step.buttons || [];
      if (edges.length) sawInteraction = true;
      for (let b = 0; b < edges.length; b++) {
        if (edges[b].action !== 'down') continue;
        const up = edges[b + 1] && edges[b + 1].action === 'up' ? edges[b + 1] : null;
        // a press never released rides to the recording's end (ESC mid-drag)
        gestures.push({
          tDown: t + edges[b].t / 1000,
          tUp: t + (up ? up.t / 1000 : G.durationSec(step)),
          rec: step,
          recT0: t,
        });
        if (up) b++;
      }
      const dur = G.durationSec(step);
      segs.push({ t0: t, t1: t + dur, from: y, to: null, easeFn: null, idx: i, rec: step });
      t += dur;
      y = step.samples.s[step.samples.s.length - 1];
      const hold = step.hold != null ? step.hold : 0;
      if (hold > 0) { segs.push({ t0: t, t1: t + hold, from: y, to: y, easeFn: null, idx: i }); t += hold; }
    } else if (step.type === 'click' || step.type === 'hover') {
      // Both are emulated in the preview with synthetic (untrusted) events —
      // hovers continuously via setPreviewHover, clicks once as playback
      // crosses them. A click's effects persist on the page (a preview can't
      // un-open a menu); reloading the page is the reset. Settle time passes
      // either way so timestamps agree with the render.
      pointerEvents.push({ t, anchor: step.type === 'hover' ? step.target : null });
      if (step.type === 'click') { clicks.push({ t, target: step.target }); sawInteraction = true; }
      const settle = step.settle != null ? step.settle : 0.6;
      segs.push({ t0: t, t1: t + settle, from: y, to: y, easeFn: null, idx: i });
      t += settle;
    }
    // wait: not executable yet — previewed as nothing, same as render
  }
  return { segments: segs, total: t, errors, pointerEvents, clicks, gestures };
}

function offsetAt(geo, tSec) {
  const t = Math.max(0, Math.min(tSec, geo.total));
  for (const s of geo.segments) {
    if (t <= s.t1 || s === geo.segments[geo.segments.length - 1]) {
      if (t < s.t0) return s.from;
      if (s.rec) return G.pointerAt(s.rec, t - s.t0).scroll;
      // a still-deferred move (unresolved anchor) holds the current position
      if (!s.easeFn || s.t1 === s.t0) return s.to == null ? s.from : s.to;
      const u = (t - s.t0) / (s.t1 - s.t0);
      return s.from + (s.to - s.from) * s.easeFn(Math.min(1, u));
    }
  }
  return 0;
}

/**
 * Give deferred move segments their real geometry the moment playback reaches
 * them — by then the interaction upstream has navigated and the destination
 * is the page in hand, which is exactly when the render resolves them too.
 * The move starts from the LIVE scroll (wherever the navigation left the
 * page), an auto duration is recomputed from the real distance, and every
 * later segment shifts by the difference — the next preview:time carries the
 * corrected total, so the panel's ruler follows. Positions chained off the
 * stale pre-navigation offset are re-chained from the resolved target, up to
 * the next segment that owns its own values (a recording, or another
 * deferred move). An anchor that still doesn't resolve is retried every tick
 * while its span plays — the destination may still be mounting, the same
 * patience the render's post-interaction anchor wait shows — and if it never
 * does, the span plays out as a hold.
 */
function resolveDeferred(geo, t) {
  for (let k = 0; k < geo.segments.length; k++) {
    const s = geo.segments[k];
    if (!s.defer || t < s.t0) continue;
    const target = safeResolve(s.defer.to);
    if (target == null) continue; // retry next tick while the span plays
    const from = window.scrollY;
    const easeFn = E.resolveEase(s.defer.ease, Math.abs(target - from) / settings.height);
    const dur = s.defer.duration != null
      ? s.defer.duration
      : E.autoDuration(target - from, settings.height, easeFn);
    const delta = s.t0 + dur - s.t1;
    s.from = from;
    s.to = target;
    s.easeFn = easeFn;
    s.t1 = s.t0 + dur;
    s.defer = null;
    let yNow = target;
    let chain = true;
    for (let m = k + 1; m < geo.segments.length; m++) {
      const g = geo.segments[m];
      g.t0 += delta;
      g.t1 += delta;
      if (!chain) continue;
      if (g.rec || g.defer) { chain = false; continue; }
      if (g.from === g.to) { g.from = g.to = yNow; }
      else { g.from = yNow; yNow = g.to; }
    }
    // timed events belonging to later steps shift with their segments —
    // recorded presses included, or they'd fire at stale times
    const after = s.t1 - delta; // the span's pre-resolution end
    for (const c of geo.clicks) if (c.t >= after - 1e-9) c.t += delta;
    for (const pe of geo.pointerEvents) if (pe.t >= after - 1e-9) pe.t += delta;
    for (const ge of geo.gestures) {
      if (ge.tDown >= after - 1e-9) { ge.tDown += delta; ge.tUp += delta; ge.recT0 += delta; }
    }
    geo.total += delta;
  }
}

/** Trace the recorded pointer with the dot while t is inside a record segment. */
function updatePreviewCursor(geo, tSec) {
  if (!els.previewCursor) return;
  const t = Math.max(0, Math.min(tSec, geo.total));
  for (const s of geo.segments) {
    if (s.rec && t >= s.t0 && t <= s.t1) {
      const p = G.pointerAt(s.rec, t - s.t0);
      els.previewCursor.className = 'preview-cursor' + (p.down ? ' down' : '');
      const st = els.previewCursor.style;
      st.display = 'block';
      st.left = p.x + 'px';
      st.top = p.y + 'px';
      return;
    }
  }
  els.previewCursor.style.display = 'none';
}

/**
 * Play the timeline, optionally resuming at `fromSec` — how the panel picks a
 * preview back up on the destination after a click step loaded a new
 * document. On a resume, clicks at or before the offset are marked already
 * fired (the navigating one included — re-firing it would navigate again),
 * and any non-record segment already in progress plays out at scroll 0: the
 * fresh document sits at its top, and the render, too, films a navigating
 * click's settle at the destination's top. A record segment is resumed at its
 * own values instead — they were recorded on this very destination.
 */
function play(steps, fromSec) {
  if (recording) return null; // the shield would swallow the input being recorded
  stopPreview(true);
  const geo = buildGeometry(steps);
  if (!geo.segments.length) { emit('preview:error', { errors: geo.errors }); return null; }
  const from = fromSec > 0 ? Math.min(fromSec, geo.total) : 0;
  const fired = new Set();
  let gestIdx = 0;
  let holdZeroUntil = 0;
  if (from > 0) {
    geo.clicks.forEach((c, i) => { if (c.t <= from) fired.add(i); });
    // presses already begun are unresumable mid-hold — skip them whole
    while (geo.gestures[gestIdx] && geo.gestures[gestIdx].tDown < from) gestIdx++;
    for (const s of geo.segments) {
      // a deferred move resumes by resolving on the destination instead
      if (!s.rec && !s.defer && from > s.t0 && from <= s.t1) { holdZeroUntil = s.t1; break; }
    }
  }
  preview = {
    geo, startWall: performance.now(), offsetSec: from, playing: true, raf: 0, fired,
    gest: { idx: gestIdx, active: null },
  };
  if (els.shield) els.shield.style.display = 'block';
  const tick = () => {
    if (!preview || !preview.playing) return;
    const t = preview.offsetSec + (performance.now() - preview.startWall) / 1000;
    resolveDeferred(preview.geo, t);
    A.setScroll(t < holdZeroUntil ? 0 : offsetAt(preview.geo, t));
    // clicks fire once as playback crosses them — never on scrub, where a
    // back-and-forth would toggle menus open and shut
    preview.geo.clicks.forEach((c, i) => {
      if (c.t <= t && !preview.fired.has(i)) { preview.fired.add(i); firePreviewClick(c); }
    });
    applyPreviewGestures(preview, t);
    // a native drag suppresses mouse/hover events, as the real protocol does;
    // a captured pointer gets its moves from the machine, aimed at the capture
    const drag = preview.gest.active;
    if (!drag || (!drag.native && !drag.capture)) applyPreviewHover(preview.geo, t);
    updatePreviewCursor(preview.geo, t);
    emit('preview:time', { t, total: preview.geo.total });
    if (t >= preview.geo.total) {
      preview.playing = false;
      if (els.shield) els.shield.style.display = 'none';
      emit('preview:ended', { total: preview.geo.total });
      return;
    }
    preview.raf = requestAnimationFrame(tick);
  };
  preview.raf = requestAnimationFrame(tick);
  return { total: geo.total, errors: geo.errors };
}

function seek(steps, tSec) {
  stopPreview(true); // keep any live hover — setPreviewHover below no-ops if unchanged
  const geo = buildGeometry(steps);
  if (!geo.segments.length) { emit('preview:error', { errors: geo.errors }); return null; }
  A.setScroll(offsetAt(geo, tSec));
  applyPreviewHover(geo, tSec);
  updatePreviewCursor(geo, tSec);
  return { total: geo.total, t: Math.max(0, Math.min(tSec, geo.total)) };
}

function stopPreview(keepHover) {
  if (preview) {
    if (preview.raf) cancelAnimationFrame(preview.raf);
    if (preview.gest && preview.gest.active) abortGesture(preview.gest.active);
  }
  preview = null;
  pressedButtons = 0;
  if (els.shield) els.shield.style.display = 'none';
  if (els.previewCursor) els.previewCursor.style.display = 'none';
  if (!keepHover) setPreviewHover(null);
}

/**
 * The extension's stand-in for the renderer's prewarm: step through the whole
 * page so lazy content loads and scroll reveals fire, then return to the top.
 * Without this, anchors resolve against a page state (un-fired reveal
 * transforms, unloaded images) that the render — which always prewarms or
 * unlocks — will never see. Same stepping as page.ts prewarm: 0.8 viewports,
 * stop when the document height holds still.
 */
async function prepare() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Math.round(settings.height * 0.8);
  let y = 0;
  let lastHeight = -1;
  let stable = 0;
  for (let steps = 0; steps < 400; steps++) {
    A.setScroll(y);
    await sleep(140);
    const h = document.documentElement.scrollHeight;
    if (h === lastHeight) stable++; else stable = 0;
    lastHeight = h;
    const max = A.maxScroll();
    emit('prepare:progress', { y, max });
    if (y >= max) {
      if (stable >= 3) break;
    } else {
      y = Math.min(y + step, max);
    }
  }
  A.setScroll(0);
  const info = pageInfo();
  emit('prepare:done', info);
  return info;
}

function jump(anchor) {
  const y = safeResolve(anchor);
  if (y != null) A.setScroll(y);
  return y;
}

function duration(steps) {
  const geo = buildGeometry(steps);
  // One span per contributing step: its full slice of the timeline, implicit
  // holds included — what the panel's duration ruler draws. A move step "owns"
  // its trailing hold. A move whose anchor failed to resolve produces no span
  // — unless an interaction precedes it, where it keeps its placeholder span
  // (the anchor may live on the page the interaction navigates to).
  const byStep = new Map();
  for (const s of geo.segments) {
    const got = byStep.get(s.idx);
    if (got) { got.t0 = Math.min(got.t0, s.t0); got.t1 = Math.max(got.t1, s.t1); }
    else byStep.set(s.idx, { index: s.idx, type: steps[s.idx].type, t0: s.t0, t1: s.t1 });
  }
  return { total: geo.total, errors: geo.errors, spans: Array.from(byStep.values()) };
}

globalThis.TapewormOverlay = {
  mount,
  destroy,
  setSettings,
  pageInfo,
  startPicker,
  stopPicker,
  startRecording,
  stopRecording,
  play,
  seek,
  stopPreview,
  jump,
  duration,
  prepare,
  assets,
};
})();
