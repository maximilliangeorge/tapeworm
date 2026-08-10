/**
 * Recorded-gesture resolution: raw pointer/scroll samples → per-frame state.
 *
 * SHARED CORE — the renderer (src/timeline.ts via src/gesture.ts), the injected
 * page runtime and the authoring extension's preview all resolve a recording
 * through THIS file, so what the preview plays is what the render captures. No
 * imports, no exports, no Node APIs — it installs one global and touches
 * nothing else.
 *
 * A recording is `{ samples: { t, x, y, s }, buttons?, smoothing? }`: parallel
 * arrays, one entry per sample — t = ms from recording start (non-decreasing),
 * x/y = pointer in viewport CSS px, s = window.scrollY — plus sparse
 * left-button edges `[{ t, action: 'down'|'up' }]` in chronological order,
 * plus the optional cursor-smoothing opt-in (see the smoothing section).
 *
 * `pointerAt` is THE interpolation seam: linear interpolation between the two
 * adjacent samples, over either the raw x/y channels or — when the step opts
 * in via `smoothing` — a denoised copy of them (see the smoothing section).
 * `resample` is built on it, so smoothing flows through to every consumer
 * automatically. Raw samples stay in the config precisely so resolution can
 * improve without re-recording.
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

// ---------------------------------------------------------------- smoothing
/**
 * Opt-in cursor denoising, from the record step's `smoothing` field (`true`,
 * or `{ mode: 'denoise', strength: 0..1 }`; `true` means strength 0.5). The
 * x/y channels are convolved with a Gaussian kernel — resolution is offline,
 * the whole take is known, so unlike a live filter (1€, springs) this is
 * zero-phase: no lag, no overshoot, the path keeps its human shape minus
 * tremor and capture's integer-rounding stairsteps.
 *
 * The smoothed path is pinned back to the raw one around every button edge
 * and at the take's ends, so presses, releases and drag grab/drop points land
 * where the finger actually was — a recording captures WHERE, not WHAT, and a
 * shifted press could miss a small target. Between a down and its up the path
 * IS smoothed: a drag's route may differ slightly from the capture, which is
 * the accepted trade of opting in. The scroll channel is never smoothed —
 * what content is on screen is a different feature.
 */
const SMOOTH_SIGMA_MAX_MS = 120; // kernel σ at strength 1; beyond this, corners visibly drag
const SMOOTH_PIN_MS = 120; // within this of a pin, blend linearly back to raw

function smoothingSigmaMs(rec) {
  const sm = rec.smoothing;
  if (!sm) return 0;
  const strength = typeof sm === 'object' && typeof sm.strength === 'number' ? sm.strength : 0.5;
  return SMOOTH_SIGMA_MAX_MS * Math.min(Math.max(strength, 0), 1);
}

/**
 * The denoised x/y arrays for a recording, memoized per (rec, strength) —
 * pointerAt runs per frame in the render and per tick in previews, so the
 * O(n·window) convolution must happen once. Null when smoothing is off.
 * Sample arrays are treated as immutable, which every producer honours.
 */
const smoothedPaths = new WeakMap();
function smoothedPath(rec) {
  const sigma = smoothingSigmaMs(rec);
  if (!(sigma > 0)) return null;
  const hit = smoothedPaths.get(rec);
  if (hit && hit.sigma === sigma) return hit;
  const { t, x, y } = rec.samples;
  const n = t.length;
  const sx = new Array(n);
  const sy = new Array(n);
  const reach = 3 * sigma; // ±3σ carries 99.7% of the kernel's weight
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (t[lo] < t[i] - reach) lo++;
    let wSum = 0, xSum = 0, ySum = 0;
    for (let j = lo; j < n && t[j] <= t[i] + reach; j++) {
      const d = (t[j] - t[i]) / sigma;
      const w = Math.exp(-0.5 * d * d);
      wSum += w;
      xSum += w * x[j];
      ySum += w * y[j];
    }
    // the truncated kernel renormalizes, so the take's ends don't pull inward
    sx[i] = xSum / wSum;
    sy[i] = ySum / wSum;
  }
  const pins = [t[0], t[n - 1]];
  for (const e of rec.buttons || []) pins.push(e.t);
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (const p of pins) w = Math.max(w, 1 - Math.abs(t[i] - p) / SMOOTH_PIN_MS);
    if (w >= 1) {
      // bit-exact, not a blend that happens to round back: a sample ON a pin
      // is the raw sample, so a press there dispatches the recorded integers
      sx[i] = x[i];
      sy[i] = y[i];
    } else if (w > 0) {
      sx[i] += (x[i] - sx[i]) * w;
      sy[i] += (y[i] - sy[i]) * w;
    }
  }
  const entry = { sigma, x: sx, y: sy };
  smoothedPaths.set(rec, entry);
  return entry;
}

/**
 * Pointer state at tSec, clamped into the recording's time range:
 * { x, y, scroll, down }.
 */
function pointerAt(rec, tSec) {
  const { t, x, y, s } = rec.samples;
  const n = t.length;
  if (!n) return { x: 0, y: 0, scroll: 0, down: false };
  const sm = smoothedPath(rec);
  const px = sm ? sm.x : x;
  const py = sm ? sm.y : y;
  const tMs = Math.min(Math.max(tSec * 1000, t[0]), t[n - 1]);
  const i = Math.max(0, sampleBefore(t, tMs));
  const j = Math.min(i + 1, n - 1);
  const span = t[j] - t[i];
  const f = span > 0 ? (tMs - t[i]) / span : 0;
  return {
    x: px[i] + (px[j] - px[i]) * f,
    y: py[i] + (py[j] - py[i]) * f,
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
