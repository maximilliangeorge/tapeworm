# Changelog

All notable changes to tapeworm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The extension now pins its identity with a `key` in the manifest, so every
  unpacked install shares one extension ID
  (`bclflmcbfiplaghcgcnclooakcopnekb`) regardless of where the repo is cloned.
  This makes the extension allowlistable and keeps `chrome.storage.session`
  state stable across re-clones. The extension is also included in the npm
  package now, so `npm i -g tapeworm` puts a loadable `extension/` on disk.

- `page.substitute` — replace assets during the render by intercepting their
  requests (CDP Fetch domain, the mechanism behind DevTools "local overrides"):
  `{ "from": "<url wildcard>", "to": "<url or local file>" }`. Local files are
  served straight from disk with HTTP Range support, so a substituted
  `<video>` still seeks per frame. Applies identically across pre-warm,
  reloads, navigating clicks, authoring (`tapeworm author`), and all shards.

- `"ease": "natural"` — a flick-scroll easing modelled on momentum physics: a
  brief ramp to peak velocity, then exponential friction decay. Its shape
  derives from the scroll distance — longer scrolls get a quicker attack and a
  longer inertial tail. It is the new default easing (for configs that omit
  `ease`, auto mode, and newly authored steps — previously `inOutCubic`); all
  existing named easings remain available and unchanged.

- `tapeworm author <url>` — visual authoring in a headful Chrome that IS the
  render environment (same flags, emulated viewport, injected runtime, pre-warm).
  Click elements to build a timeline; export with `--out config.json`.
- A Chrome extension ("Tapeworm", `extension/`, load unpacked) for authoring in
  an ordinary browser: element picker with selector quality grades, real-time
  preview, a "warm up" sweep that mirrors the renderer's pre-warm, and JSON
  export. The panel is staged around the authoring sequence — readiness chips
  (viewport match / warm-up / scroll gate), a setup stage that collapses once
  the viewport fits, and a to-scale duration ruler that doubles as the
  scrubber over collapsible step rows with drawn easing curves. Recording is
  always the full viewport at the configured size, so "Fit window" (with
  breakpoint presets) resizes the browser window until the page viewport IS
  the render viewport, and an on-page badge reports the match.
  MV3 with `activeTab`/`scripting`/`storage`/`sidePanel` only.
- Exported configs carry a `meta` provenance block (`authoredWith`,
  `authoredAt`, `authoredViewport`, `url`); the renderer ignores it.
- `tapeworm -` reads the config from stdin. The extension's "Copy command"
  button uses it to produce a fully self-contained render command (config
  embedded in a heredoc) — no exported file needed.
- The extension's export bar gained a codec select (h264 / ProRes / PNG frames)
  that shapes the copied command's `--out` extension (`.mp4` / `.mov` / `.png`),
  which is what selects the codec CLI-side.
- `click` and `hover` timeline steps are now executed: real input through
  Chrome's input pipeline (`isTrusted: true`, `:hover` styles apply) at the
  element's position at that point in the timeline, with a `settle` dwell
  (default 0.6s) while whatever they trigger animates. Interactive timelines
  render sequentially (`jobs` forced to 1). The extension gained ＋ Click /
  ＋ Hover arm modes that record the next picked element as an interaction,
  and its preview emulates hovers (synthetic mouse events + cloned `:hover`
  CSS rules, ended by later interactions, scrub-aware) and clicks (fired once
  during playback; effects persist until the page is reloaded). `wait`
  remains format-only.
- The `start` step can carry a `url`, and the extension pins the page URL
  there when the first keyframe is added — so navigating during authoring
  (recorded clicks or plain browsing) no longer exports a config pointing at
  the wrong page. Config `url` and start `url` must agree if both exist.
- Clicks that navigate are supported: anchors after the click resolve on the
  destination page. Interactions are performed while the plan is built, the
  page is reset for the capture pass, and each mid-render navigation is
  settled and pre-warmed before filming continues.

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
