import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * The shared core files are plain scripts that install globals — the same files run
 * in Node (via src/easing.ts), in the injected page runtime, and as extension
 * content scripts. Here they are booted in a vm with a stub DOM.
 */
function bootShared(dom: { queries?: Record<string, unknown[]>; bodyText?: string } = {}) {
  const queries = dom.queries ?? {};
  const window: any = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    scrollTo: ({ top }: { top: number }) => { window.scrollY = top; },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => '\\' + c) },
    document: {
      documentElement: { scrollHeight: 5000 },
      body: { innerText: dom.bodyText ?? '' },
      querySelectorAll: (sel: string) => queries[sel] ?? [],
    },
  };
  window.window = window;
  vm.createContext(window);
  for (const f of ['easing-core.js', 'anchor-core.js', 'selector.js']) {
    vm.runInContext(readFileSync(new URL(`../src/shared/${f}`, import.meta.url), 'utf8'), window);
  }
  return window;
}

function el(over: Record<string, unknown> = {}) {
  return {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    className: '',
    getAttribute: () => null,
    innerText: '',
    parentElement: null,
    previousElementSibling: null,
    ...over,
  };
}

test('each shared file installs exactly its one global, and nothing needs a build step', () => {
  const w = bootShared();
  assert.equal(typeof w.TapewormEasing.cubicBezier, 'function');
  assert.equal(typeof w.TapewormAnchors.resolveAnchor, 'function');
  assert.equal(typeof w.TapewormSelector.bestSelector, 'function');
});

// The regression table from the Phase 0 verification: extraction must not have
// changed the numbers the renderer computes durations from.
test('peakSlope table is unchanged after extraction', () => {
  const { TapewormEasing: E } = bootShared();
  const at = (name: string) => Math.round(E.peakSlope(E.resolveEase(name)) * 10_000) / 10_000;
  assert.equal(at('inOutCubic'), 2.857);
  assert.equal(at('inOutQuint'), 5.8779);
  assert.equal(at('outCubic'), 3.024);
});

test('Node imports the very same implementation the page runs', async () => {
  const easing = await import('../src/easing.ts');
  const w = bootShared();
  for (const t of [0.1, 0.33, 0.5, 0.77, 0.9]) {
    assert.equal(easing.resolveEase('inOutQuint')(t), w.TapewormEasing.resolveEase('inOutQuint')(t));
    assert.equal(easing.resolveEase('natural', 3.2)(t), w.TapewormEasing.resolveEase('natural', 3.2)(t));
  }
  assert.equal(easing.MAX_PEAK_VH_PER_SEC, w.TapewormEasing.MAX_PEAK_VH_PER_SEC);
});

test('an authored id wins', () => {
  const features = el({ id: 'features', tagName: 'SECTION', innerText: 'Features' });
  const w = bootShared({ queries: { '#features': [features] } });
  const r = w.TapewormSelector.bestSelector(features);
  assert.equal(r.selector, '#features');
  assert.equal(r.quality, 'id');
  assert.equal(r.unique, true);
  assert.equal(r.fallbackText, 'Features');
});

test('hashed ids and classes are refused: falls through to structural', () => {
  const body = el({ tagName: 'BODY' });
  const target = el({
    id: 'r1a2b3c4d5e6',
    className: 'css-1x2y3z sc-aBcDeF',
    parentElement: body,
  });
  const w = bootShared({ queries: { div: [el(), target, el()] } });
  Object.assign(w.document, { body });
  const r = w.TapewormSelector.bestSelector(target);
  assert.equal(r.quality, 'structural');
  assert.equal(r.unique, false);
  assert.equal(r.nth, 1, 'disambiguated by nth among the matches');
});

test('Tailwind arbitrary values and CSS-module hashes are filtered; stable classes survive', () => {
  // taken from the class soup real builds produce (djernesbell.com's actual markup)
  const a = el({ className: 'text-size-[clamp(64px,4.5vw+1rem,128px)] lg:whitespace-normal flex-column' });
  const b = el({ className: 'Header_nav__aBc12 nav-primary' });
  const w = bootShared({ queries: { 'div.flex-column': [a], 'div.nav-primary': [b] } });
  assert.equal(w.TapewormSelector.bestSelector(a).selector, 'div.flex-column');
  assert.equal(w.TapewormSelector.bestSelector(a).quality, 'class');
  assert.equal(w.TapewormSelector.bestSelector(b).selector, 'div.nav-primary');
});

test("tapeworm's own marker classes are never used in selectors", () => {
  // picking an element while the preview's hover emulation is active must not
  // capture the __tw-hover marker — it only exists during emulation
  const item = el({ tagName: 'SPAN', className: '__tw-hover menu-item' });
  const w = bootShared({ queries: { 'span.menu-item': [item], 'span.__tw-hover': [item] } });
  const r = w.TapewormSelector.bestSelector(item);
  assert.equal(r.selector, 'span.menu-item');
});

test('data attributes beat classes', () => {
  const target = el({
    className: 'hero',
    getAttribute: (n: string) => (n === 'data-testid' ? 'hero-section' : null),
  });
  const w = bootShared({ queries: { '[data-testid="hero-section"]': [target] } });
  const r = w.TapewormSelector.bestSelector(target);
  assert.equal(r.selector, '[data-testid="hero-section"]');
  assert.equal(r.quality, 'data');
});

test('checkSelector validates hand-edits live', () => {
  const target = el();
  const w = bootShared({ queries: { '.a': [el(), target] } });
  const miss = w.TapewormSelector.checkSelector('.missing');
  assert.equal(miss.valid, true);
  assert.equal(miss.count, 0);
  const hit = w.TapewormSelector.checkSelector('.a', target);
  assert.equal(hit.count, 2);
  assert.equal(hit.matchesTarget, true);
  assert.equal(hit.nth, 1);
});

test('describeMiss says whether the content is gone or just re-marked-up', () => {
  const w = bootShared({ bodyText: 'Welcome\nPricing that scales\nFooter' });
  const remarked = w.TapewormAnchors.describeMiss({ selector: '#pricing', fallbackText: 'Pricing that scales' });
  assert.match(remarked, /matched nothing: #pricing/);
  assert.match(remarked, /still on the page.*selector needs updating/);

  const gone = w.TapewormAnchors.describeMiss({ selector: '#pricing', fallbackText: 'Enterprise plan' });
  assert.match(gone, /content itself was removed/);

  const bare = w.TapewormAnchors.describeMiss({ selector: '#pricing', nth: 2 });
  assert.equal(bare, 'selector matched nothing: #pricing [nth=2]');
});

test('resolveAnchor throws the describeMiss message, so the CLI shows the diagnosis', () => {
  const w = bootShared({ bodyText: 'Pricing' });
  assert.throws(
    () => w.TapewormAnchors.resolveAnchor({ selector: '#pricing', fallbackText: 'Pricing' }),
    /still on the page/,
  );
});
