/**
 * Typed facade over the shared easing core.
 *
 * The implementation lives in `shared/easing-core.js` — a dependency-free plain-JS
 * file that installs `globalThis.TapewormEasing` — so the injected page runtime and
 * the authoring extension evaluate curves IDENTICALLY to the Node side. Don't add
 * logic here; add it to the core so all three consumers get it.
 */

import './shared/easing-core.js';
import type { Ease, EaseName } from './types.ts';

export type EaseFn = (t: number) => number;

type EasingCore = {
  cubicBezier: (x1: number, y1: number, x2: number, y2: number) => EaseFn;
  NAMED: Record<Exclude<EaseName, 'linear' | 'natural'>, [number, number, number, number]>;
  DEFAULT_EASE: EaseName;
  naturalEase: (distanceVh: number) => EaseFn;
  resolveEase: (ease: Ease | undefined, distanceVh?: number) => EaseFn;
  peakSlope: (ease: EaseFn, samples?: number) => number;
  MAX_PEAK_VH_PER_SEC: number;
  autoDuration: (distancePx: number, viewportPx: number, ease: EaseFn) => number;
  strobeThreshold: (viewportPx: number, fps: number, dpr: number) => number;
  clamp: (v: number, lo: number, hi: number) => number;
};

const core = (globalThis as { TapewormEasing?: EasingCore }).TapewormEasing;
if (!core) throw new Error('shared/easing-core.js did not install TapewormEasing');

export const cubicBezier: EasingCore['cubicBezier'] = core.cubicBezier;
export const DEFAULT_EASE: EaseName = core.DEFAULT_EASE;
export const naturalEase: EasingCore['naturalEase'] = core.naturalEase;
export const resolveEase: EasingCore['resolveEase'] = core.resolveEase;
export const peakSlope: EasingCore['peakSlope'] = core.peakSlope;
export const MAX_PEAK_VH_PER_SEC: number = core.MAX_PEAK_VH_PER_SEC;
export const autoDuration: EasingCore['autoDuration'] = core.autoDuration;
export const strobeThreshold: EasingCore['strobeThreshold'] = core.strobeThreshold;
export const clamp: EasingCore['clamp'] = core.clamp;
