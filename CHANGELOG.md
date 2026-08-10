# Changelog

All notable changes to tapeworm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Cursor smoothing (opt-in).** A `record` step now takes
  `"smoothing": true` or `{ "mode": "denoise", "strength": 0..1 }`: the
  recorded pointer path is resolved through a zero-phase Gaussian kernel, so
  hand tremor and capture stairsteps disappear while the route and timing stay
  yours. The path is pinned to the raw positions at button edges and the
  take's ends — clicks and a drag's grab/release land exactly where recorded;
  the route between them (drags included) is smoothed, so the dispatched
  hover/drag path can differ slightly from the live capture. Scroll is never
  smoothed, and the default remains verbatim replay. The extension's
  record-step editor gains the matching off/light/medium/strong control, and
  its preview plays the smoothed path.

- **Embed control.** YouTube and Vimeo iframes no longer free-run (and so play
  visibly too fast) in the output: tapeworm now drives them through their
  postMessage player APIs — paused, muted, and seeked to each frame's
  timestamp. New `page.embeds` / `--embeds` takes the same
  `sync | freeze | ignore` modes as `page.video` and defaults to following it.
  Provider seeks are keyframe-coarse and best-effort, so sync-mode embeds
  force `--jobs 1` (the render notes it); the pre-render probe reports embeds
  that can't be controlled — unknown providers, dead handshakes — which
  free-run as before. YouTube embeds get `enablejsapi=1` added to their src at
  discovery.

- **Vimeo SDK `timeupdate` events keep flowing while an embed is driven.** A
  paused Vimeo player never emits the `timeupdate` stream a playing one does,
  so page UI wired to `player.on('timeupdate', …)` (custom scrubbers, chapter
  highlights) froze at 0 under embed control. In sync mode tapeworm now
  re-broadcasts each frame's timestamp as the player's own `timeupdate`
  message — correct origin and source, so the SDK's checks pass — and the UI
  tracks the render timeline. Past the embed's duration the stream pins one
  final `timeupdate` at `percent: 1` and goes quiet, as a finished player
  would. Each embed gets a birth time: one that mounts mid-render (a
  click-opened overlay player) is seeked from its own zero rather than the
  render's global clock, so it plays from its start instead of beginning
  midway — or frozen past its end. A `play` event leads the stream, so a
  page's play/pause button shows the playing state instead of reading the real
  `pause` that tapeworm's autoplay defense provokes and sitting on the wrong
  icon for the whole render; it is restated whenever the player emits a real
  `pause`. That means a page's own `play` handler runs during a render
  (analytics, pause-other-players logic) — `freeze` or `ignore` if that
  matters. `pause`, `ended` and `cuepoint` are deliberately not faked —
  `ended` in particular makes pages close their player on camera (rationale in
  `src/embeds-core.js`). YouTube
  pages need no equivalent: the widget already updates every registered page
  listener on each seek.

- **Saved timelines.** The extension now persists recordings: 🗂 in the panel
  footer snapshots the current timeline into a per-site library — the current
  site's saves listed first — and loads or deletes past ones. The working
  timeline is also autosaved per site, so reopening the panel on a site
  restores where you left off (**Start over…** clears that autosave). Both
  live in `chrome.storage.local`, which survives browser restarts, extension
  reloads and updates; only uninstalling clears it.

- **Export assets.** The extension's ⋯ menu can now download
  `<hostname>.assets.json` — a record of every URL the current page has
  fetched, sorted biggest first, with request counts and bytes where the
  server allows measuring them. It's the reference list for writing
  `page.substitute` rules. Collected passively via Resource Timing, so the
  extension still needs no permissions beyond `activeTab`.

- **iPad Pro viewport preset.** The extension's viewport preset list now
  includes iPad Pro 1366×1024 (landscape).

- **Replaceable cursor sprite.** `page.cursor` now also accepts
  `{ image, tip?, size? }` to draw your own sprite during recorded-gesture
  replay instead of the built-in arrow — a local image file (embedded at
  config time, so a wrong path fails before Chrome launches) or an
  `https:`/`data:` URL, with `tip` naming the px inside the sprite that lands
  on the recorded point (default top-left) and `size` the rendered width in
  CSS px (default 32). `--cursor <image>` sets it from the CLI;
  `--cursor none` hides the sprite. `true`/`false` behave as before.

- **Recordings survive navigation.** A recorded click that triggers a
  client-side route change now replays: a recording with clicks is performed
  while the plan is built (like click steps), so the routed-to view is settled,
  pre-warmed, and resolvable for later anchors, and the capture pass films
  straight through the transition instead of refusing. A recorded click that
  loads a new document is still refused — but at plan time now, before a
  capture pass is wasted, and in practice you won't see it: when a recorded
  click navigates to a new document, the extension **splits the take at that
  click automatically** — everything before it stays a `record` step, the
  click becomes a `click` step, and recording resumes on the destination once
  it loads. `tapeworm author` does the same, and also re-attaches its overlay
  after any navigation (previously a navigation ended authoring).

- **Record mode** — capture a stretch of real interaction as one timeline
  step. Arm **● Record** in the extension (or press `r` in `tapeworm author`),
  hover around, click, drag and scroll on the page, press **ESC**, and the
  take becomes a `record` step carrying the raw samples. The render replays it
  through Chrome's real input pipeline frame by frame — `:hover` states,
  drags and clicks behave as they did live — with a drawn cursor sprite so
  the gesture is visible on camera (`page.cursor: false` hides it). Recorded
  scroll becomes the scroll track for those frames. Recordings force
  `jobs: 1` like the other interactions; a render at a different viewport
  than the recording's is refused (breakpoints make it a different page).
  Recorded clicks may navigate — see the entry above.
  Raw samples stay in the config so future smoothing can re-resolve them
  without re-recording (resolution lives in `shared/gesture-core.js`,
  currently linear interpolation). The extension preview replays a
  recording's scroll, traces a cursor dot (filled while the button is held),
  and emulates the hover, clicks and drags under it with synthetic events
  (untrusted, like hover steps): pointer-listener drags replay with the
  button held — aimed at the capturing element when the page took
  `setPointerCapture` — and a `draggable="true"` source replays as native
  HTML5 drag-and-drop (dragstart → dragenter/dragover → drop where accepted →
  dragend, with a real `DataTransfer`). Widgets that require `isTrusted`
  input respond only in the render.

- Extension: timeline steps can be **dragged to reorder** via a ⠿ grip on each
  row — the rows part to show where the step will land. The start step stays
  pinned first. The ↑/↓ buttons in the step editor remain.

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

### Changed

- Extension: the **＋ Keyframe** button is now labelled **＋ Scroll to**, naming
  what the picked step does rather than the timeline concept behind it.

### Fixed

- Extension: **Scroll-to steps on the far side of a navigation now preview.**
  A move step whose anchor only exists on the page a preceding click
  navigates to was silently dropped from the preview geometry — its selector
  doesn't resolve on the page playback starts from — so the scroll never
  played, while the render (which performs interactions while planning and
  resolves later anchors on the destination) scrolled fine. Behind an
  interaction, such a step now keeps a placeholder span and resolves the
  moment playback reaches it: on the destination, starting from the live
  scroll position, auto durations recomputed from the real distance, the
  ruler re-stretching to match — and the anchor is retried while its span
  plays, since the destination may still be mounting. Scrubbing can't
  navigate, so on a seek the span plays as a hold at the current position.
  With no interaction upstream, a missing anchor still reports as an error.

- Extension: **the preview follows a navigating click step**. A click step
  that loads a new document used to take the preview down with the page — the
  destination appeared, but every later step (the second half of a split
  take, say) never played. The panel now waits the load in, re-attaches the
  overlay, and resumes playback where the click left off; the remainder of
  the click's settle dwells at the destination's top, matching how the render
  films a navigating click. Client-side route changes never needed this — the
  document, and with it the preview, survives those.

- Extension: **the preview replays recorded clicks**. A click inside a
  `record` step now fires synthetically during playback — hit-tested at the
  recorded pointer position, once as playback crosses its release, never on
  scrub — so a recorded click that triggers a client-side route change routes
  in the preview the way it will in the render. Previously recorded clicks
  were skipped entirely, so everything after one previewed against the wrong
  view. A down→up with real pointer travel is a drag and stays render-only.

- Extension: **▶ Preview returns to the start URL first**. If authoring
  navigated the tab away from the page the timeline is pinned to (trying out
  a click that navigates, or plain browsing), Preview now brings the tab back
  to the start step's url, re-attaches the overlay, and then plays — matching
  where a render actually begins. Previously the preview played over whatever
  page the tab happened to be on, where the timeline's anchors don't resolve.

- Extension: **closing the side panel now unmounts the overlay** from the page.
  The panel holds a lifeline port open to the content script; when the panel
  closes (MV3 has no close event, so the port dropping is the signal), the
  overlay tears down — badge, highlight, banners, the cloned `:hover` rules
  sheet, any lingering `__tw-hover` marker classes, and its page listeners all
  go with it. Previously they stayed in the DOM until the page was reloaded.
  Reopening the panel remounts the overlay.

- Clicks that navigate via a **client-side router** are now recognised as
  navigation. Previously only a document load counted, so on a site whose links
  are handled by the History API the timeline carried straight on 150ms after
  the click — before the destination view had mounted — and any anchor on the
  far side died with `selector matched nothing`. Such a navigation is now
  detected by `location.href` moving. While the plan is built, the new view is
  waited in by watching the DOM go quiet (there is no load event to wait for),
  then settled and pre-warmed like any other page — which also loads its assets
  into Chrome's cache for the capture pass.

- The router's **page transition stays in the video**. During capture, a
  navigating click returns immediately instead of waiting the new view in: the
  transition plays across the settle frames, driven per-frame by the virtual
  clock like any other animation a click starts. Those frames are _free_ — the
  page owns the scroll while the router swaps views (the outgoing view stays at
  the click offset; the router jumps to top at mount), so no offset is imposed
  and no scroll drift is reported there. When the click has no explicit
  `settle`, the settle stretches to the transition duration measured while
  planning (capped at 4s); an explicit `settle` shorter than the measured
  transition earns a ⚠ in the plan.

- A navigating click is now replayed from the scroll offset it was authored at.
  The track pinned each interaction to a frame only, and the capture pass fired
  it from _that frame's_ offset — but a navigating click puts its own frame at
  the top of the destination, so the click was dispatched at scroll 0 on the
  page it was supposed to be leaving. It landed on whichever element sat there,
  and the render was a convincing video of the wrong thing. Interactions now
  carry the offset they fire from (`action.at`).

- The pointer is **parked off-page when scrolling resumes** after a click or
  hover. Chrome keeps the last pointer position an interaction left behind and
  re-computes `:hover` on every scroll, so everything that scrolled past that
  point for the rest of the render picked up hover styles — the render-side
  twin of the preview artifact the extension's cursor shield already fixed.
  The pointer stays on the target through the interaction's settle (its
  hover/active state is part of the shot) and leaves the moment the timeline
  moves on.

- Clicking or hovering a target that is out of view is now an error rather than
  a click on something else: the target point was clamped into the viewport, so
  an off-screen element silently retargeted the interaction.

- Once an interaction has been performed, an anchor that isn't there yet is
  retried for up to 5s instead of failing on the first ask — a view mounting, a
  modal opening, a tab revealing its panel. Anchors before the first
  interaction still fail immediately, so a genuine typo is still reported at
  once.

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
