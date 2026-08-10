/**
 * Typed facade over the shared gesture core.
 *
 * The implementation lives in `shared/gesture-core.js` — a dependency-free plain-JS
 * file that installs `globalThis.TapewormGesture` — so the injected page runtime and
 * the authoring extension resolve recordings IDENTICALLY to the Node side. Don't add
 * logic here; add it to the core so all three consumers get it.
 */

import './shared/gesture-core.js';

/** The data a `record` step carries; structurally, not tied to the Step union. */
export type GestureRecording = {
  samples: { t: number[]; x: number[]; y: number[]; s: number[] };
  buttons?: Array<{ t: number; action: 'down' | 'up' }>;
  smoothing?: boolean | { mode?: 'denoise'; strength?: number };
};

export type PointerFrame = { x: number; y: number; scroll: number; down: boolean };
export type PointerEdge = { frame: number; kind: 'down' | 'up'; x: number; y: number };

type GestureCore = {
  durationSec: (rec: GestureRecording) => number;
  pointerAt: (rec: GestureRecording, tSec: number) => PointerFrame;
  resample: (rec: GestureRecording, fps: number) => { frames: PointerFrame[]; edges: PointerEdge[] };
};

const core = (globalThis as { TapewormGesture?: GestureCore }).TapewormGesture;
if (!core) throw new Error('shared/gesture-core.js did not install TapewormGesture');

export const durationSec: GestureCore['durationSec'] = core.durationSec;
export const pointerAt: GestureCore['pointerAt'] = core.pointerAt;
export const resample: GestureCore['resample'] = core.resample;
