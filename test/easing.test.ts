import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoDuration,
  clamp,
  cubicBezier,
  MAX_PEAK_VH_PER_SEC,
  peakSlope,
  resolveEase,
  strobeThreshold,
} from '../src/easing.ts';

const NAMES = [
  'inOutSine', 'inOutQuad', 'inOutCubic', 'inOutQuart', 'inOutQuint', 'inOutExpo',
  'outSine', 'outQuad', 'outCubic', 'outQuart', 'outQuint', 'outExpo',
] as const;

test('every named curve hits its endpoints exactly', () => {
  for (const name of NAMES) {
    const fn = resolveEase(name);
    assert.equal(fn(0), 0, name);
    assert.equal(fn(1), 1, name);
    assert.equal(fn(-0.5), 0, name);
    assert.equal(fn(1.5), 1, name);
  }
});

// The "no overshoot" rule from easing.ts: a curve that reverses or leaves [0,1]
// re-fires scroll reveals and trips sticky headers. This is a design invariant.
test('every named curve is monotonic and stays within [0,1]', () => {
  for (const name of NAMES) {
    const fn = resolveEase(name);
    let prev = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = fn(i / 1000);
      assert.ok(v >= prev - 1e-9, `${name} reverses at t=${i / 1000}`);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${name} overshoots at t=${i / 1000}`);
      prev = v;
    }
  }
});

test('cubicBezier solves x(u)=t, not naive u=t', () => {
  // For an asymmetric curve, y at x=0.5 differs a lot from sampleY(0.5).
  const fn = cubicBezier(0.42, 0, 1, 1); // CSS ease-in
  assert.ok(Math.abs(fn(0.5) - 0.3153) < 0.01);
  // Symmetric in-out passes through the midpoint.
  const sym = cubicBezier(0.65, 0, 0.35, 1);
  assert.ok(Math.abs(sym(0.5) - 0.5) < 1e-4);
});

test('resolveEase: default, linear, raw bezier, and errors', () => {
  const dflt = resolveEase(undefined);
  const inOutCubic = resolveEase('inOutCubic');
  for (const t of [0.1, 0.33, 0.5, 0.77]) assert.equal(dflt(t), inOutCubic(t));

  const lin = resolveEase('linear');
  assert.equal(lin(0.37), 0.37);

  const raw = resolveEase([0.65, 0, 0.35, 1]);
  assert.ok(Math.abs(raw(0.5) - inOutCubic(0.5)) < 1e-9);

  assert.throws(() => resolveEase('bounce' as never), /unknown ease/);
  assert.throws(() => resolveEase([1, 2, 3] as never), /ease must be/);
  assert.throws(() => resolveEase([0, 0, 0, NaN] as never), /ease must be/);
});

test('peakSlope: 1 for linear, ~2.9x for inOutCubic, ~5.9x for inOutQuint', () => {
  assert.ok(Math.abs(peakSlope((t) => t) - 1) < 0.01);
  const cubic = peakSlope(resolveEase('inOutCubic'));
  assert.ok(cubic > 2.5 && cubic < 3.3, `got ${cubic}`);
  const quint = peakSlope(resolveEase('inOutQuint'));
  assert.ok(quint > 5 && quint < 7, `got ${quint}`);
});

test('autoDuration: zero for sub-pixel hops, clamped to [0.35, 6]', () => {
  const ease = resolveEase('inOutCubic');
  assert.equal(autoDuration(0.5, 800, ease), 0);
  assert.equal(autoDuration(2, 800, ease), 0.35);        // short hop hits floor
  assert.equal(autoDuration(200_000, 800, ease), 6);     // huge transit hits ceiling
});

test('autoDuration keeps peak velocity under the strobe cap', () => {
  const ease = resolveEase('inOutCubic');
  for (const px of [800, 1600, 2400, 4000]) {
    const dur = autoDuration(px, 800, ease);
    if (dur >= 6) continue; // ceiling-clamped transits are allowed to exceed the cap
    const peakVhPerSec = (peakSlope(ease) * (px / 800)) / dur;
    assert.ok(peakVhPerSec <= MAX_PEAK_VH_PER_SEC * 1.001, `${px}px peaks at ${peakVhPerSec}`);
  }
});

test('strobeThreshold and clamp arithmetic', () => {
  assert.equal(strobeThreshold(800, 60, 2), (MAX_PEAK_VH_PER_SEC * 800 / 60) * 2);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});
