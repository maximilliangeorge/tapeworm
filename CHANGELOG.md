# Changelog

All notable changes to tapeworm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Test suites (`npm test`, Node's built-in runner, no new dependencies) covering
  easing math, config resolution, timeline building against a fake CDP session,
  and the injected page runtime booted in a `node:vm` sandbox — including the
  core invariant that the virtual clock follows the frame index, not the wall
  clock.

## [0.1.0] - 2026-08-04

Initial version (as `scrollrec`, renamed to `tapeworm`).

### Added

- Frame-by-frame scrollthrough recording over CDP: scroll, CSS/WAAPI
  animations, videos, and JS timers all seeked from the frame index, making
  frames independent and the render shardable across parallel Chrome
  instances (`--jobs`).
- Keyframed easing with monotonic curves, auto-derived durations, and a peak
  velocity cap to prevent strobing.
- Timeline anchors resolved in-page at capture time: keywords, pixel offsets,
  and CSS selectors with alignment and offset; `--auto` section discovery.
- Prewarm modes `full` / `cache` / `none` for lazy content and scroll reveals.
- Intro handling: wait-out, replay, and wheel-through for scroll-gated intros.
- Page hygiene: consent dismissal, overlay removal, scrollbar/caret hiding,
  smooth-scroll hijacker neutralisation (Lenis, ScrollSmoother, ScrollTrigger).
- Output as H.264 (yuv444p), ProRes 4444, or a lossless PNG sequence, with
  shard segments concatenated without re-encoding.
