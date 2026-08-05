/**
 * Turn a timeline of steps into one scroll offset per frame.
 *
 * Anchors resolve to pixels *in the page, at capture time* rather than at author
 * time, so a config survives a late-loading image, a font swap, a dismissed cookie
 * banner, or a different viewport size.
 *
 * The timeline is always the normalised `Step[]` form — `resolveConfig` converts
 * legacy segments before anything gets here.
 */

import type { Session } from './cdp.ts';
import type { Anchor, Resolved, Step } from './types.ts';
import { autoDuration, DEFAULT_EASE, resolveEase } from './easing.ts';
import { durationSec, resample } from './gesture.ts';
import { sleep, SOFT_NAV_QUIET_MS } from './page.ts';

/** Seconds the timeline dwells after an interaction, letting what it triggered animate. */
export const DEFAULT_SETTLE = 0.6;

export type Track = {
  /**
   * Scroll offset for each frame, already snapped to the device-pixel grid.
   * NaN marks a FREE frame — the page owns the scroll there, because a
   * client-side route transition is playing and the router moves the scroll
   * itself (old view still at the click offset, jump-to-top at mount).
   */
  offsets: number[];
  /**
   * Interaction steps (click/hover/wait) pinned to the frame where they fire,
   * and to the scroll offset they fire AT. That offset is where the timeline
   * stood just before the interaction, which is not `offsets[frame]`: a click
   * that navigates puts the settle frames — frame included — at the top of the
   * destination, so replaying it from the frame's own offset would aim at
   * whatever happens to sit there. Empty until interactions are executable;
   * when populated, frames stop being independent and the track must render
   * sequentially.
   */
  actions: Array<{ frame: number; at: number; step: Step }>;
  /**
   * Recorded pointer state per frame, parallel to `offsets` (always the same
   * length — the frame count has ONE source of truth). null = no recorded
   * pointer this frame. `edges` are the button transitions the capture pass
   * dispatches on this frame, in order. Not `actions`: an action is one
   * selector-aimed event at one frame; a recording is continuous per-frame
   * data with coordinates already resolved.
   */
  pointer: Array<null | { x: number; y: number; down: boolean; edges?: Array<{ kind: 'down' | 'up'; x: number; y: number }> }>;
  /** True when interactions or a recording make frames path-dependent — the hook that forces jobs=1, like prewarm cache/none. */
  sequential: boolean;
  /** Human-readable description of what happens when. */
  plan: string[];
};

/**
 * How long to keep asking for an anchor once an interaction has been performed.
 * Before that the page is static and a miss is a bad selector, worth reporting
 * immediately; after it the page may still be mid-transition — a router mounting
 * a view, a modal opening, a tab revealing its panel — and the element is on its
 * way. The wait costs nothing when the anchor is already there.
 */
const POST_ACTION_ANCHOR_WAIT = 5_000;

async function resolve(session: Session, a: Anchor, waitMs = 0): Promise<number> {
  const deadline = Date.now() + waitMs;
  let failure: Error = new Error(`could not resolve anchor ${JSON.stringify(a)}`);
  for (;;) {
    try {
      const v = await session.eval<number>(`window.__sr.resolveAnchor(${JSON.stringify(a)})`);
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    } catch (e) {
      failure = e as Error; // the page reports WHY it missed — keep its message
    }
    if (Date.now() >= deadline) throw failure;
    await sleep(250);
  }
}

function describe(a: Anchor): string {
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return `${a}px`;
  const bits = [a.selector];
  if (a.align && a.align !== 'top') bits.push(a.align);
  if (a.offset) bits.push(`${a.offset > 0 ? '+' : ''}${a.offset}px`);
  return bits.join(' ');
}

export async function autoTimeline(session: Session, maxSections: number): Promise<Step[]> {
  const stops = await session.eval<number[]>(`window.__sr.discoverSections(${maxSections})`);
  if (!stops || stops.length < 2) {
    // Nothing section-like found — fall back to a single sweep to the bottom.
    return [
      { type: 'start', at: 'top', hold: 1.0 },
      { type: 'move', to: 'bottom', hold: 1.4 },
    ];
  }
  const steps: Step[] = [{ type: 'start', at: stops[0], hold: 1.0 }];
  for (let i = 1; i < stops.length; i++) {
    steps.push({
      type: 'move',
      to: stops[i],
      hold: i === stops.length - 1 ? 1.4 : 0.7,
    });
  }
  return steps;
}

export type BuildOptions = {
  /**
   * Actually perform a click/hover while the track is being built. Without
   * this, anchors that only exist on the page a click navigates TO cannot
   * resolve — the walk has to take the click to see the other side. The
   * callback reports whether the page changed (scroll resets to 0 there, and
   * everything after resolves against the new page); for a client-side route
   * change it also reports `sameDocument` and how long the transition took,
   * which sizes the settle so the transition fits on camera.
   */
  perform?: (
    step: Step & { type: 'click' | 'hover' },
    y: number,
  ) => Promise<{ navigated: boolean; sameDocument?: boolean; waitedMs?: number }>;
};

export async function buildTrack(session: Session, cfg: Resolved, opts: BuildOptions = {}): Promise<Track> {
  let steps = cfg.timeline;
  if (cfg.auto || steps.length === 0) {
    const max = cfg.auto ? cfg.auto.maxSections : 6;
    steps = await autoTimeline(session, max);
  }
  if (steps.length === 0) throw new Error('timeline is empty');

  const offsets: number[] = [];
  const pointer: Track['pointer'] = [];
  const actions: Track['actions'] = [];
  const plan: string[] = [];
  const quantum = 1 / cfg.dpr; // Chrome stores scroll offsets on the device-pixel grid
  const snap = (y: number) => Math.round(y / quantum) * quantum;
  // The one way a frame is appended, so offsets and pointer cannot disagree
  // about the frame count.
  const push = (o: number, ptr: Track['pointer'][number] = null) => {
    offsets.push(o);
    pointer.push(ptr);
  };

  let interacted = false; // once true, anchors get time to appear (see resolve)

  const first = steps[0];
  if (first.type !== 'start') throw new Error('timeline must begin with a "start" step');
  let y = await resolve(session, first.at);
  const firstHold = first.hold ?? 0.8;
  const firstFrames = Math.round(firstHold * cfg.fps);
  for (let i = 0; i < firstFrames; i++) push(snap(y));
  plan.push(`0.00s  hold ${firstHold.toFixed(2)}s at ${describe(first.at)} (y=${Math.round(y)})`);

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const startT = offsets.length / cfg.fps;

    if (step.type === 'hold') {
      const holdFrames = Math.round(step.seconds * cfg.fps);
      for (let f = 0; f < holdFrames; f++) push(snap(y));
      plan.push(`${startT.toFixed(2)}s  hold ${step.seconds.toFixed(2)}s (y=${Math.round(y)})`);
      continue;
    }

    if (step.type === 'click' || step.type === 'hover') {
      // The interaction fires just before this frame is captured (render.ts owns
      // the actual CDP input); the settle frames dwell here while whatever it
      // triggered animates — the birth-time machinery in runtime.ts picks any
      // new animation up at the right frame automatically.
      actions.push({ frame: offsets.length, at: snap(y), step });
      // Performing it NOW is what lets later anchors resolve on whatever page
      // the click leads to. A navigation puts the new document at scroll 0.
      const performed = opts.perform ? await opts.perform(step, y) : { navigated: false };
      if (opts.perform) interacted = true;
      if (performed.navigated) y = 0;

      // A client-side route change plays its transition ON CAMERA during the
      // capture pass, across these settle frames. Two consequences: an unset
      // settle stretches to the transition just measured (the quiet-detection
      // tail is silence, not transition, so it comes off), and the frames are
      // FREE — the router owns the scroll while it swaps views, and imposing
      // an offset would yank the outgoing view around mid-transition.
      const soft = performed.navigated && performed.sameDocument === true;
      const measuredSec = soft && performed.waitedMs
        ? Math.max(0, performed.waitedMs - SOFT_NAV_QUIET_MS) / 1000
        : 0;
      const settle = step.settle
        ?? (soft ? Math.min(4, Math.max(DEFAULT_SETTLE, Math.ceil(measuredSec * 10) / 10)) : DEFAULT_SETTLE);
      const settleFrames = Math.max(1, Math.round(settle * cfg.fps));
      for (let f = 0; f < settleFrames; f++) push(soft ? NaN : snap(y));
      plan.push(
        `${startT.toFixed(2)}s  ${step.type} ${describe(step.target)}` +
          (performed.navigated ? (soft ? ' → navigates (client-side route)' : ' → navigates') : '') +
          `, settle ${settle.toFixed(2)}s`,
      );
      if (soft && step.settle != null && step.settle < measuredSec) {
        plan.push(
          `       ⚠ the route transition ran ~${measuredSec.toFixed(1)}s while planning but settle is ` +
            `${step.settle.toFixed(2)}s — the timeline may take the scroll back mid-transition; raise settle to film it fully`,
        );
      }
      continue;
    }

    if (step.type === 'record') {
      // The recording is data, not something to perform: resolve its samples
      // onto the frame grid and let the capture pass dispatch the input. The
      // build pass therefore doesn't touch the page here, so `interacted`
      // stays as-is — anchors after this step resolve against the page as the
      // plan walk left it, and any state a recorded click creates only exists
      // during capture (which is also why recordings force jobs=1).
      const { frames, edges } = resample(step, cfg.fps);
      const base = offsets.length;
      for (const f of frames) push(snap(f.scroll), { x: f.x, y: f.y, down: f.down });
      for (const e of edges) {
        const p = pointer[base + e.frame];
        if (p) (p.edges ??= []).push({ kind: e.kind, x: e.x, y: e.y });
      }
      const startScroll = step.samples.s[0];
      const stoodAt = y;
      y = snap(frames[frames.length - 1].scroll);
      const hold = step.hold ?? 0;
      for (let f = 0; f < Math.round(hold * cfg.fps); f++) push(y);
      const clicks = edges.filter((e) => e.kind === 'down').length;
      plan.push(
        `${startT.toFixed(2)}s  replay recording (${durationSec(step).toFixed(2)}s, ${step.samples.t.length} samples` +
          (clicks ? `, ${clicks} click${clicks === 1 ? '' : 's'}` : '') +
          `)` +
          (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
      );
      if (Math.abs(startScroll - stoodAt) > 8) {
        plan.push(
          `       ⚠ the recording starts at scroll ${Math.round(startScroll)} but the timeline stands at ` +
            `${Math.round(stoodAt)} — the video will cut there; move to the recording's start first`,
        );
      }
      continue;
    }

    if (step.type !== 'move') {
      // 'wait' is rejected at config time; anything else reaching here is a bug
      throw new Error(`timeline[${i}]: "${step.type}" steps are not executable yet`);
    }

    const target = await resolve(session, step.to, interacted ? POST_ACTION_ANCHOR_WAIT : 0);
    const from = y;
    const distance = target - from;
    const ease = resolveEase(step.ease, Math.abs(distance) / cfg.height);
    const duration = step.duration ?? autoDuration(distance, cfg.height, ease);
    const frames = Math.max(1, Math.round(duration * cfg.fps));

    for (let f = 1; f <= frames; f++) push(snap(from + distance * ease(f / frames)));
    y = target;

    const isLast = i === steps.length - 1;
    const hold = step.hold ?? (isLast ? 0.8 : 0.6);
    const holdFrames = Math.round(hold * cfg.fps);
    for (let f = 0; f < holdFrames; f++) push(snap(y));

    const vh = Math.abs(distance) / cfg.height;
    plan.push(
      `${startT.toFixed(2)}s  ${distance >= 0 ? 'scroll to' : 'back to'} ${describe(step.to)} ` +
        `(y=${Math.round(target)}, ${Math.abs(Math.round(distance))}px = ${vh.toFixed(1)}vh) ` +
        `over ${duration.toFixed(2)}s ${typeof step.ease === 'string' ? step.ease : DEFAULT_EASE}` +
        (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
    );
  }

  if (offsets.length !== pointer.length) {
    throw new Error(`internal: offsets (${offsets.length}) and pointer (${pointer.length}) frame counts diverged`);
  }
  return { offsets, pointer, actions, sequential: actions.length > 0 || pointer.some((p) => p !== null), plan };
}

/**
 * Peak per-frame displacement, in device pixels. Above roughly 30 device px the
 * motion starts reading as strobing rather than movement — worth warning about
 * because it's invisible until you watch the render.
 */
export function peakStep(track: Track, dpr: number): number {
  // A navigating interaction jumps from where it fired to the top of the
  // destination. That's a cut between two pages, not motion, so measuring it as
  // per-frame displacement would report strobing on every such timeline. Free
  // frames (NaN, a route transition playing) aren't ours to measure either.
  const cuts = new Set(
    track.actions.filter((a) => track.offsets[a.frame] !== a.at).map((a) => a.frame),
  );
  let peak = 0;
  for (let i = 1; i < track.offsets.length; i++) {
    if (cuts.has(i)) continue;
    const d = Math.abs(track.offsets[i] - track.offsets[i - 1]) * dpr;
    if (Number.isNaN(d)) continue;
    peak = Math.max(peak, d);
  }
  return peak;
}
