import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, peakStep, type Track } from '../src/timeline.ts';
import { resolveConfig } from '../src/config.ts';
import type { Session } from '../src/cdp.ts';
import type { Resolved, Segment } from '../src/types.ts';

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

function cfgWith(timeline: Segment[], over: Partial<Resolved> = {}): Resolved {
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

test('a later segment without "to", or an unresolvable anchor, throws', async () => {
  await assert.rejects(
    buildTrack(fakeSession(), cfgWith([{ at: 'top' }, { hold: 1 }])),
    /needs a "to"/,
  );
  await assert.rejects(
    buildTrack(fakeSession(), cfgWith([{ at: 'top' }, { to: { selector: '.missing' } }])),
    /could not resolve anchor/,
  );
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
  const track: Track = { offsets: [0, 10, 25, 25], plan: [] };
  assert.equal(peakStep(track, 2), 30); // 15 css px * dpr 2
});
