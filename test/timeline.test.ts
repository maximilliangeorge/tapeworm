import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, cursorAlphas, peakStep, type Track } from '../src/timeline.ts';
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
  assert.equal(actions[0].at, 0, 'fires from where the timeline stood');
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

test('a navigating click records the scroll it fires FROM, not the frame it lands on', async () => {
  // The capture pass replays the click from action.at. Reading offsets[frame]
  // instead would aim at scroll 0 on the destination — a click on whatever
  // element happens to sit there, which renders as a plausible wrong video.
  let onNewPage = false;
  const session = {
    async eval(expr: string) {
      const a = JSON.parse(expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s)![1]);
      if (a === 'top') return 0;
      if (a.selector === '.link') return 800;
      if (a.selector === '.destination') return onNewPage ? 1200 : undefined;
      return undefined;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'move', to: { selector: '.link' }, duration: 1, ease: 'linear', hold: 0 },
    { type: 'click', target: { selector: '.link' }, settle: 1 },
    { type: 'move', to: { selector: '.destination' }, duration: 1, ease: 'linear', hold: 0 },
  ]);
  const { actions, offsets } = await buildTrack(session, cfg, {
    perform: async () => { onNewPage = true; return { navigated: true }; },
  });
  assert.equal(actions[0].at, 800, 'the click fires from the pre-click scroll offset');
  assert.equal(offsets[actions[0].frame], 0, 'while that very frame already shows the destination at its top');
  // 800px between two frames would read as violent strobing if it were motion —
  // it is a cut between two pages, so it must not be measured as one.
  assert.ok(peakStep({ offsets, actions } as Track, 2) < 800, 'the page cut is not counted as motion');
});

test('a client-side route change: settle frames are FREE and stretch to the measured transition', async () => {
  // The capture pass films the router's transition across these frames. They
  // must be NaN (the router owns the scroll while it swaps views) and, with no
  // explicit settle, must cover the transition the build pass measured.
  let onNewPage = false;
  const session = {
    async eval(expr: string) {
      const a = JSON.parse(expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s)![1]);
      if (a === 'top') return 0;
      if (a.selector === '.destination') return onNewPage ? 1200 : undefined;
      return undefined;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'click', target: { selector: 'a.nav' } },
    { type: 'move', to: { selector: '.destination' }, duration: 1, ease: 'linear', hold: 0.5 },
  ]);
  const track = await buildTrack(session, cfg, {
    // 2750ms measured = 2.0s of transition once the 750ms quiet tail comes off
    perform: async () => { onNewPage = true; return { navigated: true, sameDocument: true, waitedMs: 2750 }; },
  });
  // 10 start + 20 settle (2.0s auto-sized @10fps) + 10 move + 5 hold
  assert.equal(track.offsets.length, 45);
  for (let i = 10; i < 30; i++) {
    assert.ok(Number.isNaN(track.offsets[i]), `frame ${i} should be free while the transition plays`);
  }
  assert.equal(track.offsets[30], 120, 'control returns after the settle (first move frame, 0 → 1200 linear)');
  assert.equal(track.offsets[39], 1200, 'the move still lands on the new-view anchor');
  assert.match(track.plan[1], /→ navigates \(client-side route\), settle 2\.00s/);
  assert.ok(!Number.isNaN(peakStep(track, 2)), 'free frames are not measured as motion');
});

test('an explicit settle shorter than the route transition earns a plan warning, and is honoured', async () => {
  const session = {
    async eval(expr: string) {
      const a = JSON.parse(expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s)![1]);
      return a === 'top' ? 0 : 500;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { type: 'click', target: { selector: 'a.nav' }, settle: 0.5 },
    { type: 'move', to: { selector: '.x' }, duration: 1, ease: 'linear', hold: 0 },
  ]);
  const track = await buildTrack(session, cfg, {
    perform: async () => ({ navigated: true, sameDocument: true, waitedMs: 2750 }),
  });
  assert.equal(track.offsets.length, 10 + 5 + 10, 'the author\'s settle wins');
  assert.match(track.plan[2], /⚠.*transition ran ~2\.0s.*settle is 0\.50s/);
});

test('after an interaction, an anchor that arrives late is waited for rather than failed', async () => {
  // A router mounting the destination view, a modal opening: the element is on
  // its way, just not there on the first ask.
  let tries = 0;
  const session = {
    async eval(expr: string) {
      const m = expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s);
      if (!m) throw new Error(`unexpected eval: ${expr}`);
      const a = JSON.parse(m[1]);
      if (a === 'top') return 0;
      // the page's own error, which is what should surface if it never turns up
      if (++tries < 3) throw new Error('selector matched nothing: .late');
      return 900;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 0.2 },
    { type: 'click', target: { selector: 'a.nav' }, settle: 0.2 },
    { type: 'move', to: { selector: '.late' }, duration: 0.2, ease: 'linear', hold: 0 },
  ]);
  const track = await buildTrack(session, cfg, { perform: async () => ({ navigated: true }) });
  assert.equal(tries, 3, 'kept asking until the element existed');
  assert.equal(track.offsets[track.offsets.length - 1], 900);
});

test('the wait is only granted after an interaction, and it still reports the page\'s reason', async () => {
  const cfg = (steps: TimelineEntry[]) => cfgWith(steps);
  const session = {
    async eval(expr: string) {
      const a = JSON.parse(expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s)![1]);
      if (a === 'top') return 0;
      throw new Error('selector matched nothing: .gone — and the text "x" is gone too');
    },
  } as unknown as Session;

  // No interaction: a miss is a bad selector, and it fails at once.
  const started = Date.now();
  await assert.rejects(
    buildTrack(session, cfg([{ at: 'top' }, { to: { selector: '.gone' } }])),
    /selector matched nothing: \.gone/,
  );
  assert.ok(Date.now() - started < 1000, 'a static page fails immediately, without the retry wait');
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
  const track: Track = { offsets: [0, 10, 25, 25], pointer: [null, null, null, null], actions: [], sequential: false, plan: [] };
  assert.equal(peakStep(track, 2), 30); // 15 css px * dpr 2
});

// A 1s recording at the default viewport: pointer sweeps while the page
// scrolls 0 → 100, one click in the middle.
const REC = {
  type: 'record' as const,
  samples: { t: [0, 500, 1000], x: [100, 200, 300], y: [50, 150, 250], s: [0, 40, 100] },
  buttons: [{ t: 400, action: 'down' as const }, { t: 600, action: 'up' as const }],
  viewport: { width: 1280, height: 800, dpr: 2 },
};

test('a record step: recorded scroll becomes the offsets, snapped; the pointer lane is parallel', async () => {
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    { ...REC, hold: 0.5 },
    { type: 'move', to: 'bottom', duration: 1, ease: 'linear', hold: 0 },
  ]);
  const track = await buildTrack(fakeSession({ max: 4000 }), cfg);
  // 10 start + 10 recording (1s @10fps) + 5 hold + 10 move
  assert.equal(track.offsets.length, 35);
  assert.equal(track.pointer.length, track.offsets.length, 'pointer is parallel to offsets');
  // frame n of the recording shows t=(n+1)/fps; scroll lerps 0→40→100
  assert.deepEqual(track.offsets.slice(10, 20), [8, 16, 24, 32, 40, 52, 64, 76, 88, 100]);
  for (const y of track.offsets) {
    assert.equal(Math.round(y * cfg.dpr), y * cfg.dpr, `${y} is off the device-pixel grid`);
  }
  // the pointer exists exactly on the recording's frames
  for (let i = 0; i < 35; i++) {
    if (i >= 10 && i < 20) assert.ok(track.pointer[i], `frame ${i} has a recorded pointer`);
    else assert.equal(track.pointer[i], null, `frame ${i} has no pointer (hold frames included)`);
  }
  assert.equal(track.pointer[10]!.x, 120, 'pointer x interpolated at t=0.1s');
  // the move continues from where the recording left the scroll
  assert.equal(track.offsets[34], 4000);
  assert.equal(track.offsets[25], 100 + (4000 - 100) * (1 / 10), 'move starts from the recording end');
});

test('a record step: button edges land on their frames, in order; sequential without actions', async () => {
  const cfg = cfgWith([{ type: 'start', at: 'top', hold: 1 }, REC]);
  const track = await buildTrack(fakeSession(), cfg);
  assert.deepEqual(track.actions, []);
  assert.equal(track.sequential, true, 'a recording is path-dependent input');
  // down at 400ms → recording frame 3 → global frame 13; up at 600ms → 15
  assert.deepEqual(track.pointer[13]!.edges, [{ kind: 'down', x: 180, y: 130 }]);
  assert.equal(track.pointer[13]!.down, true, 'the frame dispatching the press shows it pressed');
  assert.deepEqual(track.pointer[15]!.edges, [{ kind: 'up', x: 220, y: 170 }]);
  assert.equal(track.pointer[16]!.edges, undefined);
  assert.match(track.plan[1], /replay recording \(1\.00s, 3 samples, 1 click\)/);
});

test('a recording with clicks is replayed at build time: the gesture callback gets the resolved frames', async () => {
  const cfg = cfgWith([{ type: 'start', at: 'top', hold: 1 }, REC]);
  const got: Array<{ y: number; ptr: any }> = [];
  const track = await buildTrack(fakeSession(), cfg, {
    performGesture: async (step, rec) => {
      assert.equal(step.type, 'record');
      got.push(...rec);
      return { navigations: 0 };
    },
  });
  assert.equal(got.length, 10, 'one entry per recording frame (1s @10fps)');
  // the callback sees exactly what the capture pass will dispatch: the snapped
  // offsets and the pointer lane, edges attached to their frames
  assert.deepEqual(got.map((r) => r.y), track.offsets.slice(10, 20));
  assert.deepEqual(got[3].ptr.edges, [{ kind: 'down', x: 180, y: 130 }]);
  assert.deepEqual(got[5].ptr.edges, [{ kind: 'up', x: 220, y: 170 }]);
  assert.ok(!track.plan[1].includes('navigates'), 'no navigation marker when no click navigated');
});

test('a clickless recording is pure data — the gesture callback is never invoked', async () => {
  const noClicks = { ...REC, buttons: undefined };
  const cfg = cfgWith([{ type: 'start', at: 'top', hold: 1 }, noClicks]);
  let called = 0;
  await buildTrack(fakeSession(), cfg, {
    performGesture: async () => { called++; return { navigations: 0 }; },
  });
  assert.equal(called, 0, 'pointer movement alone cannot navigate, so nothing to perform');
});

test('a recorded click that soft-navigates: later anchors resolve on the NEW view, plan says so', async () => {
  // .destination only exists once the recorded click has routed there — which
  // is exactly why the gesture must be replayed during the build.
  let onNewPage = false;
  const session = {
    async eval(expr: string) {
      const a = JSON.parse(expr.match(/^window\.__sr\.resolveAnchor\((.*)\)$/s)![1]);
      if (a === 'top') return 0;
      if (a.selector === '.destination') return onNewPage ? 1200 : undefined;
      return undefined;
    },
  } as unknown as Session;
  const cfg = cfgWith([
    { type: 'start', at: 'top', hold: 1 },
    REC,
    { type: 'move', to: { selector: '.destination' }, duration: 1, ease: 'linear', hold: 0 },
  ]);
  const track = await buildTrack(session, cfg, {
    performGesture: async () => { onNewPage = true; return { navigations: 1 }; },
  });
  assert.equal(track.offsets[track.offsets.length - 1], 1200, 'the move lands on the new-view anchor');
  assert.match(track.plan[1], /replay recording .* → a click navigates \(client-side route\)/);
});

test('a recording that starts away from where the timeline stands earns a jump-cut warning', async () => {
  const away = {
    ...REC,
    buttons: undefined,
    samples: { ...REC.samples, s: [3200, 3240, 3300] },
  };
  const cfg = cfgWith([{ type: 'start', at: 'top', hold: 0.5 }, away]);
  const { plan } = await buildTrack(fakeSession(), cfg);
  assert.match(plan[2], /⚠ the recording starts at scroll 3200 but the timeline stands at 0/);

  const nearby = { ...REC, buttons: undefined };
  const quiet = await buildTrack(fakeSession(), cfgWith([{ type: 'start', at: 'top', hold: 0.5 }, nearby]));
  assert.ok(!quiet.plan.some((l) => l.includes('⚠')), 'no warning when the recording starts where the timeline is');
});

// ---------------------------------------------------------------------------
// cursorAlphas: the opt-in fade the drawn cursor gets where it appears and
// disappears. Pure per-frame data, mirroring the capture loop's own
// show/hide rule (visible through a hold that parks the offset, hidden the
// moment the scroll moves off it).

/** A hand-built track: `null` = no pointer that frame; a number is the offset. */
function fadeTrack(spec: Array<{ y: number; ptr?: boolean }>): Track {
  return {
    offsets: spec.map((f) => f.y),
    pointer: spec.map((f) => (f.ptr ? { x: 10, y: 10, down: false } : null)),
    actions: [],
    sequential: true,
    plan: [],
  };
}

test('cursorAlphas ramps in at appearance and out into the disappearance, holding 1 between', () => {
  // 3 hidden frames, 10 recorded frames at offset 100, 4 hold frames (offset
  // parked), then the scroll moves — where the sprite currently vanishes.
  const spec = [
    ...Array.from({ length: 3 }, () => ({ y: 0 })),
    ...Array.from({ length: 10 }, () => ({ y: 100, ptr: true })),
    ...Array.from({ length: 4 }, () => ({ y: 100 })),
    ...Array.from({ length: 3 }, () => ({ y: 200 })),
  ];
  const a = cursorAlphas(fadeTrack(spec), 10, 0.3); // 3 fade frames
  assert.deepEqual(a.slice(0, 3), [0, 0, 0], 'hidden before the recording');
  assert.deepEqual(a.slice(3, 6), [1 / 4, 2 / 4, 3 / 4], 'even ramp up from 0');
  assert.deepEqual(a.slice(6, 14), Array(8).fill(1), 'fully opaque in the middle (hold included)');
  assert.deepEqual(a.slice(14, 17), [3 / 4, 2 / 4, 1 / 4], 'even ramp down into the vanish frame');
  assert.deepEqual(a.slice(17), [0, 0, 0], 'hidden once the scroll moves off the parked offset');
});

test('cursorAlphas: no fade-out when the video ends with the cursor still up', () => {
  const spec = [
    ...Array.from({ length: 2 }, () => ({ y: 0 })),
    ...Array.from({ length: 8 }, () => ({ y: 50, ptr: true })),
  ];
  const a = cursorAlphas(fadeTrack(spec), 10, 0.2); // 2 fade frames
  assert.deepEqual(a.slice(2, 4), [1 / 3, 2 / 3], 'still fades in');
  assert.deepEqual(a.slice(4), Array(6).fill(1), 'stays opaque to the last frame');
});

test('cursorAlphas: a short visible run shrinks the ramps so they never cross, and fade 0 means no fade', () => {
  const short = [
    { y: 0 },
    ...Array.from({ length: 4 }, () => ({ y: 30, ptr: true })),
    { y: 90 },
  ];
  const a = cursorAlphas(fadeTrack(short), 10, 1); // asks for 10 frames, run is 4 → 2 each
  assert.deepEqual(a, [0, 1 / 3, 2 / 3, 2 / 3, 1 / 3, 0]);

  const none = cursorAlphas(fadeTrack(short), 10, 0);
  assert.deepEqual(none, [0, 1, 1, 1, 1, 0], 'fade 0: visibility only, all-or-nothing');
});

test('cursorAlphas: a free frame (NaN — a route transition owns the scroll) ends visibility like a scroll-away', () => {
  const spec = [
    ...Array.from({ length: 6 }, () => ({ y: 10, ptr: true })),
    { y: NaN },
    { y: NaN },
  ];
  const a = cursorAlphas(fadeTrack(spec), 10, 0.2);
  assert.deepEqual(a.slice(4, 8), [2 / 3, 1 / 3, 0, 0], 'fades out into the free frames');
});
