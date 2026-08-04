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

/** Seconds the timeline dwells after an interaction, letting what it triggered animate. */
export const DEFAULT_SETTLE = 0.6;

export type Track = {
  /** Scroll offset for each frame, already snapped to the device-pixel grid. */
  offsets: number[];
  /**
   * Interaction steps (click/hover/wait) pinned to the frame where they fire.
   * Empty until interactions are executable; when populated, frames stop being
   * independent and the track must render sequentially.
   */
  actions: Array<{ frame: number; step: Step }>;
  /** actions.length > 0 — the hook that forces jobs=1, like prewarm cache/none. */
  sequential: boolean;
  /** Human-readable description of what happens when. */
  plan: string[];
};

async function resolve(session: Session, a: Anchor): Promise<number> {
  const v = await session.eval<number>(`window.__sr.resolveAnchor(${JSON.stringify(a)})`);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`could not resolve anchor ${JSON.stringify(a)}`);
  }
  return v;
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
   * callback reports whether the document changed (scroll resets to 0 there,
   * and everything after resolves against the new page).
   */
  perform?: (step: Step & { type: 'click' | 'hover' }, y: number) => Promise<{ navigated: boolean }>;
};

export async function buildTrack(session: Session, cfg: Resolved, opts: BuildOptions = {}): Promise<Track> {
  let steps = cfg.timeline;
  if (cfg.auto || steps.length === 0) {
    const max = cfg.auto ? cfg.auto.maxSections : 6;
    steps = await autoTimeline(session, max);
  }
  if (steps.length === 0) throw new Error('timeline is empty');

  const offsets: number[] = [];
  const actions: Track['actions'] = [];
  const plan: string[] = [];
  const quantum = 1 / cfg.dpr; // Chrome stores scroll offsets on the device-pixel grid
  const snap = (y: number) => Math.round(y / quantum) * quantum;

  const first = steps[0];
  if (first.type !== 'start') throw new Error('timeline must begin with a "start" step');
  let y = await resolve(session, first.at);
  const firstHold = first.hold ?? 0.8;
  const firstFrames = Math.round(firstHold * cfg.fps);
  for (let i = 0; i < firstFrames; i++) offsets.push(snap(y));
  plan.push(`0.00s  hold ${firstHold.toFixed(2)}s at ${describe(first.at)} (y=${Math.round(y)})`);

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const startT = offsets.length / cfg.fps;

    if (step.type === 'hold') {
      const holdFrames = Math.round(step.seconds * cfg.fps);
      for (let f = 0; f < holdFrames; f++) offsets.push(snap(y));
      plan.push(`${startT.toFixed(2)}s  hold ${step.seconds.toFixed(2)}s (y=${Math.round(y)})`);
      continue;
    }

    if (step.type === 'click' || step.type === 'hover') {
      // The interaction fires just before this frame is captured (render.ts owns
      // the actual CDP input); the settle frames dwell here while whatever it
      // triggered animates — the birth-time machinery in runtime.ts picks any
      // new animation up at the right frame automatically.
      actions.push({ frame: offsets.length, step });
      // Performing it NOW is what lets later anchors resolve on whatever page
      // the click leads to. A navigation puts the new document at scroll 0.
      const performed = opts.perform ? await opts.perform(step, y) : { navigated: false };
      if (performed.navigated) y = 0;
      const settle = step.settle ?? DEFAULT_SETTLE;
      const settleFrames = Math.max(1, Math.round(settle * cfg.fps));
      for (let f = 0; f < settleFrames; f++) offsets.push(snap(y));
      plan.push(
        `${startT.toFixed(2)}s  ${step.type} ${describe(step.target)}` +
          (performed.navigated ? ' → navigates' : '') +
          `, settle ${settle.toFixed(2)}s`,
      );
      continue;
    }

    if (step.type !== 'move') {
      // 'wait' is rejected at config time; anything else reaching here is a bug
      throw new Error(`timeline[${i}]: "${step.type}" steps are not executable yet`);
    }

    const target = await resolve(session, step.to);
    const from = y;
    const distance = target - from;
    const ease = resolveEase(step.ease, Math.abs(distance) / cfg.height);
    const duration = step.duration ?? autoDuration(distance, cfg.height, ease);
    const frames = Math.max(1, Math.round(duration * cfg.fps));

    for (let f = 1; f <= frames; f++) offsets.push(snap(from + distance * ease(f / frames)));
    y = target;

    const isLast = i === steps.length - 1;
    const hold = step.hold ?? (isLast ? 0.8 : 0.6);
    const holdFrames = Math.round(hold * cfg.fps);
    for (let f = 0; f < holdFrames; f++) offsets.push(snap(y));

    const vh = Math.abs(distance) / cfg.height;
    plan.push(
      `${startT.toFixed(2)}s  ${distance >= 0 ? 'scroll to' : 'back to'} ${describe(step.to)} ` +
        `(y=${Math.round(target)}, ${Math.abs(Math.round(distance))}px = ${vh.toFixed(1)}vh) ` +
        `over ${duration.toFixed(2)}s ${typeof step.ease === 'string' ? step.ease : DEFAULT_EASE}` +
        (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
    );
  }

  return { offsets, actions, sequential: actions.length > 0, plan };
}

/**
 * Peak per-frame displacement, in device pixels. Above roughly 30 device px the
 * motion starts reading as strobing rather than movement — worth warning about
 * because it's invisible until you watch the render.
 */
export function peakStep(track: Track, dpr: number): number {
  let peak = 0;
  for (let i = 1; i < track.offsets.length; i++) {
    peak = Math.max(peak, Math.abs(track.offsets[i] - track.offsets[i - 1]) * dpr);
  }
  return peak;
}
