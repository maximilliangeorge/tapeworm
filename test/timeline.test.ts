import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, peakStep, type Track } from '../src/timeline.ts';
import { resolveConfig } from '../src/config.ts';
import type { Session } from '../src/cdp.ts';
import type { Resolved, TimelineEntry } from '../src/types.ts';

/**
 * buildTrack only calls session.eval with __sr.resolveAnchor / __sr.discoverSections
 * expressions, so a page can be faked as an anchor table + a max scroll.
 */
function fakeSession(opts: { max?: number; anchors?: Record<string, number>; sections?: number[] } = {}): Session {
  const max = opts.max ?? 4000;
  return {
    async eval(expr: string) {
      let m = expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s);
      if (m) {
        const a = JSON.parse(m[1]);
        if (a === 'top') return 0;
        if (a === 'bottom') return max;
        if (typeof a === 'number') return Math.min(Math.max(a, 0), max);
        const y = opts.anchors?.[a.selector];
        if (y === undefined) return undefined; // what a bad selector produces
        return Math.min(y + (a.offset || 0), max);
      }
      m = expr.match(/^window\.__sr\.discoverSections\((\d+)\)$/);
      if (m) return opts.sections ?? [];
      throw new Error(`unexpected eval: ${expr}`);
    },
  } as unknown as Session;
}

function cfgWith(timeline: TimelineEntry[], over: Partial<Resolved> = {}): Resolved {
  const base = resolveConfig({ url: 'https://example.com', timeline: timeline.length ? timeline : undefined, auto: timeline.length ? undefined : true });
  return { ...base, fps: 10, ...over };
}

test('holds and travel produce the exact frame count, linear ramp lands exactly', async () => {
  const cfg = cfgWith([
    { at: 'top', hold: 1 },
    { to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 },
  ]);
  const { offsets } = await buildTrack(fakeSession({ max: 4000 }), cfg);
  assert.equal(offsets.length, 10 + 20 + 5); // 1s hold + 2s travel + 0.5s hold @10fps
  assert.deepEqual(offsets.slice(0, 10), Array(10).fill(0));
  assert.equal(offsets[10 + 9], 4000 * (10 / 20)); // halfway through the ramp
  assert.equal(offsets[29], 4000);                 // ramp ends exactly on target
  assert.deepEqual(offsets.slice(30), Array(5).fill(4000));
});

test('offsets are snapped to the 1/dpr device-pixel grid', async () => {
  const cfg = cfgWith([
    { at: 'top', hold: 0.2 },
    { to: { selector: '.hero' }, duration: 1, hold: 0.2 },
  ]);
  assert.equal(cfg.dpr, 2);
  const { offsets } = await buildTrack(fakeSession({ anchors: { '.hero': 1000.3 } }), cfg);
  for (const y of offsets) {
    assert.equal(Math.round(y * cfg.dpr), y * cfg.dpr, `${y} is off the half-pixel grid`);
  }
  assert.equal(offsets[offsets.length - 1], 1000.5); // 1000.3 snapped to the grid
});

test('eased travel is monotonic frame to frame', async () => {
  const cfg = cfgWith([{ at: 'top', hold: 0.1 }, { to: 3000, duration: 1.5, ease: 'inOutQuint', hold: 0.1 }]);
  const { offsets } = await buildTrack(fakeSession(), cfg);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] >= offsets[i - 1], `scroll reverses at frame ${i}`);
  }
});

test('a later segment without "to" fails at config time; an unresolvable anchor at build time', async () => {
  assert.throws(() => cfgWith([{ at: 'top' }, { hold: 1 }]), /needs a "to"/);
  await assert.rejects(
    buildTrack(fakeSession(), cfgWith([{ at: 'top' }, { to: { selector: '.missing' } }])),
    /could not resolve anchor/,
  );
});

test('hold steps are first-class: frames at the current position, narrated in the plan', async () => {
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 0.5 },
    { type: 'move', to: 1000, duration: 1, ease: 'linear' },
    { type: 'hold', seconds: 2 },
  ]);
  const { offsets, plan } = await buildTrack(fakeSession(), cfg);
  // 0.5s start hold + 1s move + 0.6s default hold (move is not last) + 2s hold step @10fps
  assert.equal(offsets.length, 5 + 10 + 6 + 20);
  assert.deepEqual(offsets.slice(-20), Array(20).fill(1000));
  assert.match(plan[2], /hold 2\.00s \(y=1000\)/);
});

test('legacy segments and typed steps mix freely and produce identical tracks', async () => {
  const legacy = cfgWith([
    { at: 'top', hold: 1 },
    { to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 },
  ]);
  const typed = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'move', to: 'bottom', duration: 2, ease: 'linear', hold: 0.5 },
  ]);
  const a = await buildTrack(fakeSession({ max: 4000 }), legacy);
  const b = await buildTrack(fakeSession({ max: 4000 }), typed);
  assert.deepEqual(a.offsets, b.offsets);
  assert.deepEqual(a.plan, b.plan);
});

test('a plain scroll timeline has no actions and stays shardable', async () => {
  const { actions, sequential } = await buildTrack(
    fakeSession({ max: 4000 }),
    cfgWith([{ at: 'top', hold: 0.2 }, { to: 'bottom', duration: 1 }]),
  );
  assert.deepEqual(actions, []);
  assert.equal(sequential, false);
});

test('click steps pin an action to the exact frame, dwell for settle, and force sequential', async () => {
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'click', target: { selector: '.cta' }, settle: 2 },
    { type: 'move', to: 'bottom', duration: 1, ease: 'linear', hold: 0.5 },
  ]);
  const { offsets, actions, sequential, plan } = await buildTrack(fakeSession({ max: 4000 }), cfg);
  assert.equal(sequential, true);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].frame, 10, 'fires right after the 1s start hold @10fps');
  assert.equal(actions[0].step.type, 'click');
  // 10 start + 20 settle + 10 move + 5 hold
  assert.equal(offsets.length, 45);
  assert.deepEqual(offsets.slice(10, 30), Array(20).fill(0), 'settle dwells at the current position');
  assert.match(plan[1], /click \.cta, settle 2\.00s/);
});

test('a navigating click: later anchors resolve on the NEW page, settle dwells at scroll 0', async () => {
  // .destination only exists after the click "navigates" — resolving it upfront
  // (the old behaviour) is exactly the bug this guards against.
  let onNewPage = false;
  const session = {
    async eval(expr: string) {
      const m = expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s);
      if (!m) throw new Error(`unexpected eval: ${expr}`);
      const a = JSON.parse(m[1]);
      if (a === 'top') return 0;
      if (typeof a === 'object' && a.selector === '.destination') return onNewPage ? 1200 : undefined;
      return undefined;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'click', target: { selector: 'a.nav' }, settle: 1 },
    { type: 'move', to: { selector: '.destination' }, duration: 1, ease: 'linear', hold: 0.5 },
  ]);
  const performed: string[] = [];
  const track = await buildTrack(session, cfg, {
    perform: async (step) => {
      performed.push(step.type);
      onNewPage = true;
      return { navigated: true };
    },
  });
  assert.deepEqual(performed, ['click'], 'the click was actually performed during the build');
  // 10 hold + 10 settle + 10 move + 5 hold @10fps
  assert.equal(track.offsets.length, 35);
  assert.deepEqual(track.offsets.slice(10, 20), Array(10).fill(0), 'settle dwells at the new page top');
  assert.equal(track.offsets[29], 1200, 'the move lands on the new-page anchor');
  assert.match(track.plan[1], /click a\.nav → navigates/);
});

test('auto mode: discovered sections become the timeline, empty discovery falls back to a full sweep', async () => {
  const found = await buildTrack(fakeSession({ max: 4000, sections: [0, 1500, 3000] }), cfgWith([]));
  assert.equal(found.offsets[0], 0);
  assert.equal(found.offsets[found.offsets.length - 1], 3000);
  assert.ok(found.plan.length === 3, 'one plan line per stop');

  const swept = await buildTrack(fakeSession({ max: 4000, sections: [] }), cfgWith([]));
  assert.equal(swept.offsets[swept.offsets.length - 1], 4000, 'fallback sweeps to the bottom');
});

test('plan narrates each move with target, distance, and duration', async () => {
  const cfg = cfgWith([{ at: 'top', hold: 1 }, { to: 'bottom', duration: 2, ease: 'linear' }]);
  const { plan } = await buildTrack(fakeSession({ max: 4000 }), cfg);
  assert.equal(plan.length, 2);
  assert.match(plan[0], /hold 1\.00s at top/);
  assert.match(plan[1], /scroll to bottom \(y=4000, 4000px = 5\.0vh\) over 2\.00s linear/);
});

test('peakStep reports the largest per-frame move in device pixels', () => {
  const track: Track = { offsets: [0, 10, 25, 25], actions: [], sequential: false, plan: [] };
  assert.equal(peakStep(track, 2), 30); // 15 css px * dpr 2
});
