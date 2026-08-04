/**
 * Turn a timeline of anchors + easings into one scroll offset per frame.
 *
 * Anchors resolve to pixels *in the page, at capture time* rather than at author
 * time, so a config survives a late-loading image, a font swap, a dismissed cookie
 * banner, or a different viewport size.
 */

import type { Session } from './cdp.ts';
import type { Anchor, Resolved, Segment } from './types.ts';
import { autoDuration, DEFAULT_EASE, resolveEase } from './easing.ts';

export type Track = {
  /** Scroll offset for each frame, already snapped to the device-pixel grid. */
  offsets: number[];
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

export async function autoTimeline(session: Session, maxSections: number): Promise<Segment[]> {
  const stops = await session.eval<number[]>(`window.__sr.discoverSections(${maxSections})`);
  if (!stops || stops.length < 2) {
    // Nothing section-like found — fall back to a single sweep to the bottom.
    return [
      { at: 'top', hold: 1.0 },
      { to: 'bottom', ease: 'inOutCubic', hold: 1.4 },
    ];
  }
  const segs: Segment[] = [{ at: stops[0], hold: 1.0 }];
  for (let i = 1; i < stops.length; i++) {
    segs.push({
      to: stops[i],
      ease: i === stops.length - 1 ? 'outCubic' : 'inOutCubic',
      hold: i === stops.length - 1 ? 1.4 : 0.7,
    });
  }
  return segs;
}

export async function buildTrack(session: Session, cfg: Resolved): Promise<Track> {
  let segments = cfg.timeline;
  if (cfg.auto || segments.length === 0) {
    const max = cfg.auto ? cfg.auto.maxSections : 6;
    segments = await autoTimeline(session, max);
  }
  if (segments.length === 0) throw new Error('timeline is empty');

  const offsets: number[] = [];
  const plan: string[] = [];
  const quantum = 1 / cfg.dpr; // Chrome stores scroll offsets on the device-pixel grid
  const snap = (y: number) => Math.round(y / quantum) * quantum;

  const first = segments[0];
  let y = await resolve(session, first.at ?? first.to ?? 'top');
  const firstHold = first.hold ?? 0.8;
  const firstFrames = Math.round(firstHold * cfg.fps);
  for (let i = 0; i < firstFrames; i++) offsets.push(snap(y));
  plan.push(`0.00s  hold ${firstHold.toFixed(2)}s at ${describe(first.at ?? 'top')} (y=${Math.round(y)})`);

  const rest = first.to !== undefined && first.at !== undefined ? segments : segments.slice(1);
  const tail = first.at !== undefined ? segments.slice(1) : rest;

  for (let i = 0; i < tail.length; i++) {
    const seg = tail[i];
    if (seg.to === undefined) throw new Error(`timeline[${i + 1}] needs a "to"`);
    const target = await resolve(session, seg.to);
    const from = y;
    const distance = target - from;
    const ease = resolveEase(seg.ease);
    const duration = seg.duration ?? autoDuration(distance, cfg.height, ease);
    const frames = Math.max(1, Math.round(duration * cfg.fps));
    const startT = offsets.length / cfg.fps;

    for (let f = 1; f <= frames; f++) offsets.push(snap(from + distance * ease(f / frames)));
    y = target;

    const isLast = i === tail.length - 1;
    const hold = seg.hold ?? (isLast ? 0.8 : 0.6);
    const holdFrames = Math.round(hold * cfg.fps);
    for (let f = 0; f < holdFrames; f++) offsets.push(snap(y));

    const vh = Math.abs(distance) / cfg.height;
    plan.push(
      `${startT.toFixed(2)}s  ${distance >= 0 ? 'scroll to' : 'back to'} ${describe(seg.to)} ` +
        `(y=${Math.round(target)}, ${Math.abs(Math.round(distance))}px = ${vh.toFixed(1)}vh) ` +
        `over ${duration.toFixed(2)}s ${typeof seg.ease === 'string' ? seg.ease : DEFAULT_EASE}` +
        (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
    );
  }

  return { offsets, plan };
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
