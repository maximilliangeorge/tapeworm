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
  recording = { t0: performance.now(), last: null, t: [], x: [], y: [], s: [], buttons: [], raf: 0, clickTarget: null };
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
 * (element centre otherwise). Untrusted either way — isTrusted-gated
 * libraries only respond in the render.
 */
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
      relatedTarget: opts.related || null,
    };
    if (type.indexOf('pointer') === 0) {
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

/** Synthetic click on the step's target — down, up, click, at its centre. */
function firePreviewClick(target) {
  let el = null;
  try { el = document.querySelectorAll(target.selector)[target.nth || 0] || null; } catch (e) {}
  if (!el) return;
  fireMouse(el, 'pointerdown');
  fireMouse(el, 'mousedown');
  fireMouse(el, 'pointerup');
  fireMouse(el, 'mouseup');
  fireMouse(el, 'click');
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
  const clicks = []; // { t, target } — fired once as playback crosses them
  let t = 0;
  let y = 0;
  const errors = [];

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
      if (target == null) { errors.push({ index: i, anchor: step.to }); continue; }
      const easeFn = E.resolveEase(step.ease, Math.abs(target - y) / settings.height);
      const duration = step.duration != null
        ? step.duration
        : E.autoDuration(target - y, settings.height, easeFn);
      segs.push({ t0: t, t1: t + duration, from: y, to: target, easeFn, idx: i });
      t += duration;
      y = target;
      const isLast = i === steps.length - 1;
      const hold = step.hold != null ? step.hold : (isLast ? 0.8 : 0.6);
      if (hold > 0) { segs.push({ t0: t, t1: t + hold, from: y, to: y, easeFn: null, idx: i }); t += hold; }
    } else if (step.type === 'record') {
      // The recorded scroll replays, a cursor dot traces the pointer, and the
      // point under it is hover-emulated per tick (hit-tested live — see
      // applyPreviewHover), all via the same gesture core the renderer
      // resolves with. Clicks/drags stay render-only: their effects persist
      // on the page, which a scrubbing preview can't afford. The null pointer
      // event ends any earlier hover step's hover, and stands after the
      // recording too — the render parks the pointer there.
      pointerEvents.push({ t, anchor: null });
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
      if (step.type === 'click') clicks.push({ t, target: step.target });
      const settle = step.settle != null ? step.settle : 0.6;
      segs.push({ t0: t, t1: t + settle, from: y, to: y, easeFn: null, idx: i });
      t += settle;
    }
    // wait: not executable yet — previewed as nothing, same as render
  }
  return { segments: segs, total: t, errors, pointerEvents, clicks };
}

function offsetAt(geo, tSec) {
  const t = Math.max(0, Math.min(tSec, geo.total));
  for (const s of geo.segments) {
    if (t <= s.t1 || s === geo.segments[geo.segments.length - 1]) {
      if (t < s.t0) return s.from;
      if (s.rec) return G.pointerAt(s.rec, t - s.t0).scroll;
      if (!s.easeFn || s.t1 === s.t0) return s.to;
      const u = (t - s.t0) / (s.t1 - s.t0);
      return s.from + (s.to - s.from) * s.easeFn(Math.min(1, u));
    }
  }
  return 0;
}

/** Trace the recorded pointer with the dot while t is inside a record segment. */
function updatePreviewCursor(geo, tSec) {
  if (!els.previewCursor) return;
  const t = Math.max(0, Math.min(tSec, geo.total));
  for (const s of geo.segments) {
    if (s.rec && t >= s.t0 && t <= s.t1) {
      const p = G.pointerAt(s.rec, t - s.t0);
      const st = els.previewCursor.style;
      st.display = 'block';
      st.left = p.x + 'px';
      st.top = p.y + 'px';
      return;
    }
  }
  els.previewCursor.style.display = 'none';
}

function play(steps) {
  if (recording) return null; // the shield would swallow the input being recorded
  stopPreview(true);
  const geo = buildGeometry(steps);
  if (!geo.segments.length) { emit('preview:error', { errors: geo.errors }); return null; }
  preview = { geo, startWall: performance.now(), offsetSec: 0, playing: true, raf: 0, fired: new Set() };
  if (els.shield) els.shield.style.display = 'block';
  const tick = () => {
    if (!preview || !preview.playing) return;
    const t = preview.offsetSec + (performance.now() - preview.startWall) / 1000;
    A.setScroll(offsetAt(preview.geo, t));
    // clicks fire once as playback crosses them — never on scrub, where a
    // back-and-forth would toggle menus open and shut
    preview.geo.clicks.forEach((c, i) => {
      if (c.t <= t && !preview.fired.has(i)) { preview.fired.add(i); firePreviewClick(c.target); }
    });
    applyPreviewHover(preview.geo, t);
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
  if (preview && preview.raf) cancelAnimationFrame(preview.raf);
  preview = null;
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
  // its trailing hold; steps whose anchor failed to resolve produce no span.
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
};
})();
