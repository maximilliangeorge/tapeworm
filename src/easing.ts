/**
 * Easing curves, evaluated the same way CSS evaluates cubic-bezier():
 * solve x(u) = t for u by Newton-Raphson, then return y(u).
 *
 * Two rules learned the hard way and encoded here:
 *  - No overshoot. Back-easing and bouncy springs reverse scroll direction, which
 *    trips direction-sensitive sticky headers, can re-fire scroll reveals, and reads
 *    as a mis-scroll rather than intent. Every curve below is monotonic.
 *  - No plain ease-in on a scroll segment. It starts imperceptibly and reads as lag.
 */

import type { Ease } from './types.ts';

export type EaseFn = (t: number) => number;

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - t;
      if (Math.abs(err) < 1e-7) return sampleY(u);
      const d = slopeX(u);
      if (Math.abs(d) < 1e-7) break;
      u -= err / d;
    }
    // Newton stalled (near-vertical slope) — bisect, which always converges.
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 24; i++) {
      const x = sampleX(u);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return sampleY(u);
  };
}

/** Standard published cubic-bezier values (easings.net). */
const NAMED: Record<string, [number, number, number, number]> = {
  inOutSine:  [0.37, 0, 0.63, 1],
  inOutQuad:  [0.45, 0, 0.55, 1],
  inOutCubic: [0.65, 0, 0.35, 1],
  inOutQuart: [0.76, 0, 0.24, 1],
  inOutQuint: [0.83, 0, 0.17, 1],
  inOutExpo:  [0.87, 0, 0.13, 1],
  outSine:    [0.61, 1, 0.88, 1],
  outQuad:    [0.5, 1, 0.89, 1],
  outCubic:   [0.33, 1, 0.68, 1],
  outQuart:   [0.25, 1, 0.5, 1],
  outQuint:   [0.22, 1, 0.36, 1],
  outExpo:    [0.16, 1, 0.3, 1],
};

/**
 * The default. Not inOutQuint, which is the prettiest curve on paper but peaks at
 * ~5.9x its average velocity — over a full viewport that either strobes or forces
 * an uncomfortably long segment. inOutCubic peaks at ~2.9x and reads as smooth.
 */
export const DEFAULT_EASE = 'inOutCubic';

export function resolveEase(ease: Ease | undefined): EaseFn {
  if (!ease) return cubicBezier(...NAMED[DEFAULT_EASE]);
  if (Array.isArray(ease)) {
    if (ease.length !== 4 || ease.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error(`ease must be [x1,y1,x2,y2], got ${JSON.stringify(ease)}`);
    }
    return cubicBezier(ease[0], ease[1], ease[2], ease[3]);
  }
  if (ease === 'linear') return (t) => t;
  const v = NAMED[ease];
  if (!v) {
    throw new Error(`unknown ease "${ease}". Known: linear, ${Object.keys(NAMED).join(', ')}`);
  }
  return cubicBezier(...v);
}

/**
 * Peak velocity, as a multiple of average velocity, for a given curve. Measured
 * numerically because it varies a lot: linear is 1.0, inOutQuint is nearly 3x.
 * This is why "duration = distance / speed" alone produces strobing — the middle
 * of an ease-in-out is far faster than its average.
 */
export function peakSlope(ease: EaseFn, samples = 512): number {
  let peak = 0;
  let prev = ease(0);
  for (let i = 1; i <= samples; i++) {
    const v = ease(i / samples);
    peak = Math.max(peak, (v - prev) * samples);
    prev = v;
  }
  return Math.max(peak, 1);
}

/**
 * Above this, consecutive frames are far enough apart that the eye reads a strobe
 * rather than movement — and body text becomes unreadable well before it.
 * Expressed as viewport-heights per second, at the curve's *peak*, not its average.
 */
export const MAX_PEAK_VH_PER_SEC = 2.2;

/**
 * Duration from distance: sub-linear so short hops feel snappy and long transits
 * don't drag, then stretched if needed to keep peak velocity under the cap.
 */
export function autoDuration(distancePx: number, viewportPx: number, ease: EaseFn): number {
  const d = Math.abs(distancePx);
  if (d < 1) return 0;
  const vh = d / viewportPx;
  const feel = 0.9 * Math.pow(vh, 0.6);
  // peak_velocity = peakSlope * distance / duration  =>  duration >= peakSlope * vh / cap
  const forVelocityCap = (peakSlope(ease) * vh) / MAX_PEAK_VH_PER_SEC;
  return clamp(Math.max(feel, forVelocityCap), 0.35, 6);
}

/** The per-frame displacement, in device pixels, that MAX_PEAK_VH_PER_SEC implies. */
export function strobeThreshold(viewportPx: number, fps: number, dpr: number): number {
  return (MAX_PEAK_VH_PER_SEC * viewportPx / fps) * dpr;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
