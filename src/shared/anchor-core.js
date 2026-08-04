/**
 * Anchor resolution and scroll primitives.
 *
 * SHARED CORE — the renderer's injected runtime (src/runtime.ts) and the authoring
 * extension both use THIS file, which is the whole defence against the picker and
 * the renderer disagreeing about where an anchor lands. No imports, no exports, no
 * Node APIs — it installs one global and touches only the DOM, at call time.
 */
(() => {
'use strict';

function maxScroll() {
  const d = document.documentElement;
  return Math.max(0, (d.scrollHeight || 0) - innerHeight);
}

function setScroll(y) {
  const clamped = Math.min(Math.max(y, 0), maxScroll());
  window.scrollTo({ top: clamped, left: 0, behavior: 'instant' });
  return window.scrollY;
}

function visibleRect(el) {
  try {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return null;
    return r.width > 0 && r.height > 0 ? r : null;
  } catch (e) { return null; }
}

/**
 * "Selector matched nothing" with the why: fallbackText is never used to FIND the
 * element, only to say whether the content is gone or just re-marked-up.
 */
function describeMiss(a) {
  let msg = 'selector matched nothing: ' + a.selector + (a.nth ? ' [nth=' + a.nth + ']' : '');
  if (a.fallbackText) {
    let onPage = false;
    try {
      const hay = ((document.body && document.body.innerText) || '').toLowerCase();
      onPage = hay.indexOf(String(a.fallbackText).trim().toLowerCase()) !== -1;
    } catch (e) {}
    msg += onPage
      ? ' — but the text "' + a.fallbackText + '" is still on the page, so the content moved to different markup and the selector needs updating'
      : ' — and the text "' + a.fallbackText + '" is gone too, so the content itself was removed';
  }
  return msg;
}

function resolveAnchor(a) {
  if (a === 'top') return 0;
  if (a === 'bottom') return maxScroll();
  if (typeof a === 'number') return Math.min(Math.max(a, 0), maxScroll());
  const list = document.querySelectorAll(a.selector);
  const el = list[a.nth || 0];
  if (!el) throw new Error(describeMiss(a));
  const r = el.getBoundingClientRect();
  const top = r.top + window.scrollY;
  let y;
  if (a.align === 'center') y = top - (innerHeight - r.height) / 2;
  else if (a.align === 'bottom') y = top + r.height - innerHeight;
  else y = top;
  return Math.min(Math.max(y + (a.offset || 0), 0), maxScroll());
}

/** Guess section boundaries for --auto: big blocks, in order, well separated. */
function discoverSections(max) {
  const roots = document.querySelectorAll('main > *, body > *, section, [data-section]');
  const seen = [];
  for (const el of roots) {
    const r = visibleRect(el);
    if (!r) continue;
    const h = r.height;
    if (h < innerHeight * 0.4) continue;
    const top = Math.round(r.top + window.scrollY);
    if (top > maxScroll()) continue;
    if (seen.some((s) => Math.abs(s - top) < innerHeight * 0.6)) continue;
    seen.push(top);
  }
  seen.sort((a, b) => a - b);
  if (seen[0] !== 0) seen.unshift(0);
  const end = maxScroll();
  if (end - seen[seen.length - 1] > innerHeight * 0.4) seen.push(end);
  if (seen.length <= max) return seen;
  // thin evenly rather than truncating, so we still reach the footer
  const step = (seen.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => seen[Math.round(i * step)]);
}

globalThis.TapewormAnchors = {
  maxScroll,
  setScroll,
  visibleRect,
  describeMiss,
  resolveAnchor,
  discoverSections,
};
})();
