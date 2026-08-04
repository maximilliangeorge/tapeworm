# Changelog

All notable changes to tapeworm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `tapeworm author <url>` — visual authoring in a headful Chrome that IS the
  render environment (same flags, emulated viewport, injected runtime, pre-warm).
  Click elements to build a timeline; export with `--out config.json`.
- A Chrome extension (`extension/`, load unpacked) for authoring in an ordinary
  browser: element picker with selector quality grades, real-time preview and
  scrubbing, a "prepare page" sweep that mirrors the renderer's pre-warm, and
  JSON export. Recording is always the full viewport at the configured size, so
  "Fit window" (with breakpoint presets) resizes the browser window until the
  page viewport IS the render viewport, and an on-page badge reports the match.
  MV3 with `activeTab`/`scripting`/`storage`/`sidePanel` only.
- Exported configs carry a `meta` provenance block (`authoredWith`,
  `authoredAt`, `authoredViewport`, `url`); the renderer ignores it.

- Timeline format v2: `timeline` entries may now be typed steps (`start`,
  `move`, `hold`) as well as the existing segment form, mixed freely. Legacy
  configs are normalised internally and behave identically. Interaction steps
  (`click`, `hover`, `wait`) are part of the format now — they parse, but are
  rejected with a clear message until interaction support lands, so configs
  authored today won't break when it does.
- Anchors accept `fallbackText`: never used to find the element, only to turn
  "selector matched nothing" into a diagnosis of whether the content is gone
  or just re-marked-up.
- A shared plain-JS core (`src/shared/`) for easing, anchor resolution, and
  selector generation, used verbatim by both the renderer's injected runtime
  and the upcoming visual authoring tools, so they cannot drift apart.

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
