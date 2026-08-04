/**
 * Selector generation for the visual picker — where visual pickers usually rot.
 *
 * SHARED CORE — shipped verbatim as an extension content script and available to
 * the injected runtime. No imports, no exports, no Node APIs; installs one global.
 *
 * Ranking, in order:
 *   1. #id, but only if it looks authored — build-generated ids (hashes, React
 *      useId, radix-*, styled-components) change every deploy and are worse than
 *      no selector at all.
 *   2. data attributes people put there ON PURPOSE (testids, section markers).
 *   3. tag + the smallest combination of stable classes that stays unique.
 *   4. a short structural path with :nth-of-type — works today, breaks on a
 *      redesign, which is why quality 'structural' should be surfaced as a warning.
 */
(() => {
'use strict';

const DATA_ATTRS = ['data-testid', 'data-test', 'data-section', 'data-scroll', 'data-id'];

const GENERATED_PREFIX = /^(radix-|headlessui-|react-|ember\d|mui-|:r|sc-|chakra-)/i;

function cssEscape(s) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&');
}

/**
 * Does a token look like build output rather than something a human typed?
 * Tuned against real markup: css-1x2y3z, sc-aBcDeF, Header_nav__aBc12, r1a2b3c4d5e6
 * are all hashes; flex-column, nav-primary, col-md-6, h1 are all authored.
 */
function looksHashed(token) {
  if (GENERATED_PREFIX.test(token)) return true;
  // any dash/underscore-separated segment mixing letters and digits, long enough
  // that it isn't a size step like "md-6" or "h1"
  for (const seg of token.split(/[-_]+/)) {
    if (seg.length >= 4 && /\d/.test(seg) && /[a-zA-Z]/.test(seg)) return true;
    // letters-only random case soup: aBcDeF has many lower->upper flips, navBar has one
    let flips = 0;
    for (let i = 1; i < seg.length; i++) {
      if (/[a-z]/.test(seg[i - 1]) && /[A-Z]/.test(seg[i])) flips++;
    }
    if (flips >= 3) return true;
  }
  return false;
}

/** Valid as a bare class in a selector, and not a state/utility artefact. */
function awkwardClass(cls) {
  if (!/^[A-Za-z_][\w-]*$/.test(cls)) return true;   // Tailwind arbitrary values, variants with ":" or "[", digits-first
  if (cls.length > 32) return true;
  if (/^(is-|has-|js-)/.test(cls)) return true;      // state classes toggle at runtime
  if (/^__tw-/.test(cls)) return true;               // tapeworm's own markers (hover emulation etc.) — never real page state
  return false;
}

function authoredId(id) {
  if (!id || /^\d/.test(id)) return false;
  if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
  return !looksHashed(id);
}

function stableClasses(el) {
  const list = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
  return list.filter((c) => c && !awkwardClass(c) && !looksHashed(c));
}

function countMatches(sel) {
  try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
}

function indexAmong(sel, el) {
  try {
    const list = document.querySelectorAll(sel);
    for (let i = 0; i < list.length; i++) if (list[i] === el) return i;
  } catch (e) {}
  return -1;
}

/** First line of the element's text, for fallbackText — diagnosis, never lookup. */
function textHint(el) {
  let t = '';
  try { t = (el.innerText || el.textContent || '').trim(); } catch (e) {}
  t = t.split('\n')[0].replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 57).trimEnd() + '…';
  return t || undefined;
}

/** Shortest structural path that pins the element down, anchored at the nearest authored id (or body). */
function structuralPath(el) {
  const bits = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    if (authoredId(node.id) && countMatches('#' + cssEscape(node.id)) === 1) {
      bits.unshift('#' + cssEscape(node.id));
      break;
    }
    let nth = 1;
    let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) nth++; sib = sib.previousElementSibling; }
    bits.unshift(nth > 1 ? tag + ':nth-of-type(' + nth + ')' : tag);
    const sel = bits.join(' > ');
    if (countMatches(sel) === 1) return sel;
    node = node.parentElement;
    if (bits.length >= 5) break;
  }
  return bits.join(' > ');
}

function finish(selector, quality, el) {
  const n = countMatches(selector);
  const idx = n > 1 ? indexAmong(selector, el) : 0;
  return {
    selector,
    nth: idx > 0 ? idx : undefined,
    unique: n === 1,
    quality,
    fallbackText: textHint(el),
  };
}

/** The best available selector for an element, with an honest quality grade. */
function bestSelector(el) {
  if (!el || el.nodeType !== 1) throw new Error('bestSelector needs an element');

  if (authoredId(el.id)) {
    const sel = '#' + cssEscape(el.id);
    if (countMatches(sel) === 1) return finish(sel, 'id', el);
  }

  for (const attr of DATA_ATTRS) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (!v) continue;
    const sel = '[' + attr + '="' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
    if (countMatches(sel) >= 1) return finish(sel, 'data', el);
  }

  const tag = el.tagName.toLowerCase();
  const classes = stableClasses(el);
  if (classes.length) {
    // fewest classes that stay unique: singles first, then pairs, then everything
    const sels = [];
    for (const c of classes) sels.push(tag + '.' + cssEscape(c));
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        sels.push(tag + '.' + cssEscape(classes[i]) + '.' + cssEscape(classes[j]));
      }
    }
    sels.push(tag + classes.map((c) => '.' + cssEscape(c)).join(''));
    for (const sel of sels) {
      if (countMatches(sel) === 1) return finish(sel, 'class', el);
    }
    // none unique — take the first single and disambiguate with nth
    return finish(sels[0], 'class', el);
  }

  return finish(structuralPath(el), 'structural', el);
}

/** Validate a hand-edited selector live: does it parse, match, and still hit the element? */
function checkSelector(selector, el) {
  let list;
  try { list = document.querySelectorAll(selector); } catch (e) {
    return { valid: false, count: 0, error: 'not a valid selector' };
  }
  const out = { valid: true, count: list.length };
  if (el) {
    out.nth = -1;
    for (let i = 0; i < list.length; i++) if (list[i] === el) { out.nth = i; break; }
    out.matchesTarget = out.nth >= 0;
  }
  return out;
}

globalThis.TapewormSelector = {
  bestSelector,
  checkSelector,
  looksHashed,
  authoredId,
};
})();
