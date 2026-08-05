/**
 * Recorded-gesture resolution: raw pointer/scroll samples → per-frame state.
 *
 * SHARED CORE — the renderer (src/timeline.ts via src/gesture.ts), the injected
 * page runtime and the authoring extension's preview all resolve a recording
 * through THIS file, so what the preview plays is what the render captures. No
 * imports, no exports, no Node APIs — it installs one global and touches
 * nothing else.
 *
 * A recording is `{ samples: { t, x, y, s }, buttons? }`: parallel arrays, one
 * entry per sample — t = ms from recording start (non-decreasing), x/y =
 * pointer in viewport CSS px, s = window.scrollY — plus sparse left-button
 * edges `[{ t, action: 'down'|'up' }]` in chronological order.
 *
 * `pointerAt` is THE interpolation seam: v1 is linear interpolation between
 * the two adjacent samples, and any future smoothing (splines, denoising,
 * velocity caps) replaces the inside of that one function. `resample` is built
 * on it, so smoothing flows through to every consumer automatically. Raw
 * samples stay in the config precisely so this can improve without
 * re-recording.
 *
 * No snapping or clamping happens here: buildTrack owns the device-pixel
 * snap, setScroll owns scroll clamping, and the extension preview wants the
 * raw values.
 */
(() => {
'use strict';

/** Seconds of recorded material. 0 for a degenerate recording. */
function durationSec(rec) {
  const t = rec.samples.t;
  return t.length ? t[t.length - 1] / 1000 : 0;
}

/** Index of the last sample with t <= tMs (binary search; -1 if before all). */
function sampleBefore(t, tMs) {
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Is the left button held at tMs, per the recorded edges? */
function downAt(rec, tMs) {
  const edges = rec.buttons;
  if (!edges || !edges.length) return false;
  let down = false;
  for (const e of edges) {
    if (e.t > tMs) break;
    down = e.action === 'down';
  }
  return down;
}

/**
 * Pointer state at tSec, clamped into the recording's time range:
 * { x, y, scroll, down }.
 */
function pointerAt(rec, tSec) {
  const { t, x, y, s } = rec.samples;
  const n = t.length;
  if (!n) return { x: 0, y: 0, scroll: 0, down: false };
  const tMs = Math.min(Math.max(tSec * 1000, t[0]), t[n - 1]);
  const i = Math.max(0, sampleBefore(t, tMs));
  const j = Math.min(i + 1, n - 1);
  const span = t[j] - t[i];
  const f = span > 0 ? (tMs - t[i]) / span : 0;
  return {
    x: x[i] + (x[j] - x[i]) * f,
    y: y[i] + (y[j] - y[i]) * f,
    scroll: s[i] + (s[j] - s[i]) * f,
    down: downAt(rec, tMs),
  };
}

/**
 * The whole recording resolved onto the frame grid. Frame n (0-based within
 * the recording's span) shows time (n+1)/fps — the frame BEFORE the span
 * already shows the starting state, the same convention move steps use — so
 * the last frame lands exactly on the recording's end.
 *
 * Returns { frames, edges }: frames[n] = { x, y, scroll, down }, and edges =
 * [{ frame, kind: 'down'|'up', x, y }] in chronological order with
 * non-decreasing frame indices (a sub-frame click keeps both edges, in order,
 * on one frame). Edge x/y is evaluated at the edge's OWN timestamp, not the
 * frame's — a click lands where the finger was.
 */
function resample(rec, fps) {
  const count = Math.max(1, Math.round(durationSec(rec) * fps));
  const frames = [];
  for (let n = 0; n < count; n++) frames.push(pointerAt(rec, (n + 1) / fps));
  const edges = [];
  let prevFrame = 0;
  for (const e of rec.buttons || []) {
    const at = pointerAt(rec, e.t / 1000);
    let frame = Math.min(count - 1, Math.max(0, Math.ceil((e.t / 1000) * fps) - 1));
    frame = Math.max(frame, prevFrame);
    prevFrame = frame;
    edges.push({ frame, kind: e.action, x: at.x, y: at.y });
  }
  return { frames, edges };
}

globalThis.TapewormGesture = {
  durationSec,
  pointerAt,
  resample,
};
})();
