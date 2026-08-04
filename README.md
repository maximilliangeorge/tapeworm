# 🪱 tapeworm

Record website scrollthroughs as high-quality video, with keyframed scrolling and easing curves.

Frames are rendered one at a time rather than screen-captured in real time, which means the motion is exactly the curve you authored, the output is retina and lossless-sourced, and **playing video on the page lands on the right frame** instead of drifting.

```bash
tapeworm https://stripe.com --out stripe.mp4
tapeworm site.json --dpr 3 --out master.mov
```

TypeScript, run directly — no build step, no dependencies.

---

## Requirements

- **Node 22.18+** (or 24+). Runs `.ts` files natively via type stripping.
- **ffmpeg** on PATH — `brew install ffmpeg`.
- **Chrome**. Auto-detected from `/Applications`, `~/.cache/puppeteer`, or `$CHROME_PATH`. If you don't have one:
  ```bash
  npx @puppeteer/browsers install chrome@stable
  ```

```bash
git clone <this repo> && cd tapeworm
node bin/tapeworm.ts --help
```

There is nothing to install and nothing to compile. `npm install` is only needed if you want editor typechecking (`@types/node`).

---

## Two ways in

**Point it at a URL.** It discovers sections, builds a timeline, and marches through them:

```bash
tapeworm https://linear.app --out linear.mp4
```

**Write a config** when you want control:

```jsonc
{
  "url": "https://example.com",
  "viewport": { "width": 1440, "height": 900, "dpr": 2 },
  "fps": 60,
  "output": { "path": "marketing.mp4" },
  "timeline": [
    { "at": "top", "hold": 1.6 },
    { "to": { "selector": "#features", "align": "top", "offset": -80 }, "hold": 1.0 },
    { "to": { "selector": "#pricing", "align": "center" }, "ease": "inOutCubic", "hold": 1.6 },
    { "to": { "selector": "footer", "align": "bottom" }, "ease": "outCubic", "hold": 1.8 }
  ]
}
```

`--dry-run` prints the plan without rendering. Use it constantly — it's fast, and it tells you what the tool found:

```
  0.00s  hold 1.60s at top (y=0)
  1.60s  scroll to #features -80px (y=902, 902px = 1.0vh) over 1.31s inOutCubic, hold 1.00s
  3.91s  scroll to #pricing center (y=1702, 800px = 0.9vh) over 1.24s inOutCubic, hold 1.60s

  596 frames (9.9s)
  · dismissed a consent dialog
  · hid 1 overlay
  · pre-warmed in 7 steps (1.2s)
  · document 4102px, 1 video, 1 animation
```

---

## Anchors, not pixels

`{ "selector": "#pricing", "align": "center", "offset": -80 }` is resolved **in the page at capture time**. A raw pixel offset is invalidated by a late-loading image, a font swap, a dismissed cookie banner, or a different viewport; an anchor survives all of them. It also composes better — landing a section edge at the viewport top with a little breathing room is what makes frames look designed rather than arbitrary.

| Anchor | Meaning |
|---|---|
| `"top"` / `"bottom"` | document extremes |
| `1200` | raw pixel offset (the escape hatch) |
| `{ "selector": "#x" }` | element's top edge at the viewport top |
| `{ "selector": "#x", "align": "center" }` | element centred |
| `{ "selector": "#x", "align": "bottom" }` | element's bottom edge at the viewport bottom |
| `{ "selector": ".card", "nth": 2 }` | the third match |
| `offset` | pixels added after alignment; negative = space above |

An element anchor can also carry `"fallbackText"` — a snippet of the element's text at author time. It is **never** used to find the element. It only upgrades the error when a selector stops matching: tapeworm checks whether that text is still on the page, and tells you whether the content moved to different markup (fix the selector) or was removed outright (fix the timeline).

### Typed steps

Timeline entries can also be written as typed steps, and the two forms mix freely in one timeline:

```jsonc
{
  "timeline": [
    { "type": "start", "at": "top", "hold": 1.6 },
    { "type": "move", "to": { "selector": "#features" }, "ease": "inOutCubic", "hold": 1.0 },
    { "type": "hold", "seconds": 2 },
    { "type": "move", "to": "bottom", "ease": "outCubic" }
  ]
}
```

`start` sets the opening position (first entry only), `move` is a scroll with the same `duration`/`ease`/`hold` fields as the segment form, and `hold` dwells at the current position. `start` may also carry a `url` — authoring tools stamp it when the first keyframe is created, so navigating during authoring can't silently re-point the config at the wrong page. It substitutes for the top-level `url`, and if both are present they must agree.

**Interactions**: `{ "type": "click", "target": { "selector": "#menu-btn" }, "settle": 0.8 }` (and `hover` likewise) performs the interaction mid-timeline with **real input** through Chrome's input pipeline — `isTrusted` is true, `:hover` styles apply, and libraries that ignore synthetic events respond. `target` must be an element anchor; `settle` (default 0.6s) is how long the timeline dwells afterwards while whatever it triggered animates — a menu opening over 300ms starts at the right frame and eases correctly, courtesy of the same animation birth-time machinery everything else uses. Because frame N now shows whatever earlier clicks did to the page, an interactive timeline renders sequentially (`jobs` is forced to 1, like prewarm `cache`/`none`).

**Clicks may navigate.** A timeline can click a link and keep going on the destination page — anchors after the click resolve there. To make that possible, interactions are *performed while the plan is built* (a click has to happen before the far side of it can be seen), the page is reset to the configured URL for the capture pass, and each navigation mid-render waits the new document in, settles it (intro, consent, scroll gate), and pre-warms it before filming continues. This also means `--dry-run` on an interactive timeline does perform the interactions to resolve the plan — it just skips rendering.

`wait` remains format-only for now: it parses but is rejected with a clear message until it lands.

---

## Motion

Omit `duration` and it's derived from the distance — sub-linear, so short hops feel snappy and long transits don't drag — then stretched if needed to keep peak velocity under a readable limit.

That cap is the part worth understanding. `inOutQuint` looks like the prettiest curve on paper, but it peaks at **5.9×** its average velocity; over a full viewport it either strobes or forces an uncomfortably long segment. `inOutCubic` (peak 2.9×) reads as smooth. The default is `natural` (below), which sidesteps the choice by deriving its shape from the distance. Set `ease` explicitly if you disagree — the tool will warn if the result exceeds what reads as smooth motion, and let you do it anyway.

```
linear 1.0 · inOutSine 1.6 · inOutQuad 1.8 · inOutCubic 2.9 · inOutQuart 4.2 · inOutQuint 5.9 · inOutExpo 7.7
outCubic 3.0 · outQuint 4.5 · outExpo 6.2
```

You can also give a raw CSS cubic-bezier: `"ease": [0.65, 0, 0.35, 1]`.

**`"ease": "natural"`** — the default — imitates a real flick-scroll, and is the one curve that isn't a fixed shape: it's modelled on velocity — a brief ramp to peak speed (the flick), then exponential friction decay (the glide), which is how momentum scrolling actually moves. Its shape derives from the scroll distance: short hops read close to a gentle out-curve, while longer scrolls get a proportionally quicker attack and a longer inertial tail — at 8 viewports, over half the segment is spent gliding through the last 5% of the distance. (`outExpo` is this family's fixed end point: zero attack, maximum decay.) Being tail-heavy, its peak velocity is high for its average — like `outExpo`, expect longer auto-derived durations than `inOutCubic` for the same distance, and the same strobe warning if you force a short one.

Two rules the curve set deliberately enforces:

- **No overshoot.** Back-easing and bouncy springs reverse scroll direction, which trips direction-sensitive sticky headers, can re-fire scroll reveals, and reads as a mis-scroll rather than intent.
- **No plain ease-in.** It starts imperceptibly and reads as lag.

**Holds are what sell it.** A constant-velocity pan reads as machine. Humans scroll in bursts with dwells — hold at the top, transit, dwell, transit, settle at the footer. Default holds are 0.8s at the ends and 0.6s between; 1.5–3s on a hero or a headline you want read.

---

## Video on the page

This is the part most tools get wrong. Every `<video>` is paused, seeked to the frame's timestamp with a half-frame bias, and awaited via `requestVideoFrameCallback` before the frame is captured. Frame *n* of the output holds exactly the video frame that belongs at *n/fps*.

| `page.video` | |
|---|---|
| `"sync"` | seek per frame — the default |
| `"freeze"` | pause on the first frame; use for DRM'd or streamed video |
| `"ignore"` | don't touch it (it will drift and look wrong) |

**If a video won't seek, the tool tells you which and why** — it probes before the render rather than after. The most common cause is a server that ignores HTTP Range requests: `currentTime` assignment silently no-ops and every frame shows the same picture with no error anywhere. Python's `http.server` does this, so a locally-served page will hit it.

**Won't work, no workaround:** DRM/EME content (captures black), cross-origin embeds like YouTube and Vimeo (the inner `<video>` is unreachable and adaptive anyway), live streams. Use `"freeze"` and composite separately.

### Substituting assets

`page.substitute` swaps assets at the network layer during the render — most usefully, a page's video for a different source file:

```json
"page": {
  "substitute": [
    { "from": "*/hero.mp4", "to": "./assets/hero-4k.mp4" },
    { "from": "https://cdn.example.com/promo-*.webm", "to": "https://example.com/replacement.webm" }
  ]
}
```

`from` is a URL wildcard (`*` matches any run of characters, `?` a single one) matched against the full request URL — note that's anchored, so end with `*` if the URL carries a query string. `to` is either an https URL or a local file path (relative to the working directory, checked at config time). It works the way DevTools "local overrides" does, invisibly to the page: a remote replacement is fetched in the original request's place, and a local file is served straight from disk at the interception layer, with full HTTP Range support — so a substituted video still seeks per frame. The interception survives navigation, applies during pre-warm and `cache`-mode reloads, and is a pure function of the URL, so it doesn't affect sharding.

Caveats: the replacement video must itself be seekable (mp4 with the `moov` atom up front — `ffmpeg -movflags +faststart`); a shorter replacement freezes on its last frame once the timeline seeks past its end, and a different aspect ratio letterboxes per the page's `object-fit`; a remote replacement must be `https` when the page is (Chrome refuses the downgrade — the config says so upfront); and `blob:` sources (MSE players — HLS/DASH) can't be swapped by URL, since the media element's URL isn't the network request.

---

## Intro animations and preloaders

Two different things get called "an intro", and they need opposite treatment.

**Time-gated** (a splash that plays and finishes). The tool waits it out: after load it polls until no *finite* animation is running — infinite decorative loops are ignored, or the wait would never end — up to `--wait-for-intro` ms (default 8000). Then, crucially, animations already running when capture begins **carry on from where they are** rather than rewinding, so the intro you just waited out doesn't replay on frame 0. Their positions are snapshotted after the page settles and before any frame renders, including probe frames.

**Scroll-gated** (an intro that advances as you scroll, common on studio and portfolio sites). Waiting achieves nothing — until you push through it, `document.scrollHeight` equals the viewport and there is nothing to film. And `window.scrollTo` doesn't work either, because these intros listen for *wheel* events, which a CSSOM scroll never produces. So when the page isn't scrollable after load, real wheel events are dispatched through CDP — Chrome's actual input pipeline — until it opens up, then the scroll returns to the top.

```
· unlocked a scroll-gated intro with 5 wheel ticks (document went 823px -> 9700px)
```

`--no-unlock-intro` disables it. If a page hijacks scrolling permanently (never becomes natively scrollable), you'll get a note saying so rather than a silent one-frame video.

```bash
tapeworm https://example.com --out out.mp4                  # skip the intro (default)
tapeworm https://example.com --replay-intro --out out.mp4    # film the intro
tapeworm https://example.com --wait-for-intro 15000          # a slow one
```

If a time-based intro is driven by JS that never registers a WAAPI animation, the poll can't see it — add a fixed `--settle 4000` on top.

---

## Lazy loading and scroll reveals

Whether reveals appear *in* the video is a real choice, and `--prewarm` is where you make it.

| Mode | What happens | Use when |
|---|---|---|
| `full` (default) | Step-scroll the whole page, then film. Everything is loaded and every reveal has already fired, so the pass is clean with no popping. Shards across `--jobs`. | Most product videos. You want the page to look finished. |
| `cache` | Step-scroll to fill the HTTP cache, then **reload** and film. Reveals fire on camera and animate over their real duration, with images instantly available because they're cached. | You want the fade-ins and slide-ups in the video. `--reveals` is a shorthand. |
| `none` | Film a cold page. | You specifically want to show real network behaviour. |

```bash
tapeworm https://example.com --reveals --out reveals.mp4
```

Two things make `cache` work, and they're worth knowing because they're where the naive version fails:

**Animations get a birth time.** An animation that starts mid-render can't be given `currentTime = <absolute render time>` — that's far past its duration, so a 0.6s fade snaps to completed in a single frame. Each animation's first-seen timestamp is recorded and `currentTime` is set relative to it. Anything already running at frame 0 (a decorative infinite loop) gets birth 0, which is what you want.

**Frames wait for images.** An image entering the viewport is still in flight when the reveal starts, so without waiting you'd film a fade-in of an empty box followed by a pop. Each frame awaits `decode()` on any incomplete image within ~1.5 viewports, bounded by `--image-budget` (default 1500ms in `cache`/`none`, 400ms in `full` where nothing should be pending).

**`cache` and `none` force `--jobs 1.`** Reveal state depends on the path taken to reach a scroll position — a shard jumping straight to frame 400 has a different reveal state than one that scrolled through — so those modes can't be sharded. `full` still parallelises.

One honest caveat: in `none`, image arrival is governed by the network, not the timeline. Frames are ~180ms apart in wall clock, so a slow image may land a frame or two later than it "should", and re-running won't reproduce it identically. `cache` exists precisely to make reveals repeatable: same animations, same timing, every run.

---

## What else it does to the page before filming

- **Consent dialogs** get dismissed, preferring "reject" over "accept" (fewer follow-up dialogs), and whatever scroll lock they applied to `<body>` gets undone.
- **Overlays** — chat widgets, newsletter modals — are removed if they appear after load and cover enough of the viewport. Top and bottom nav bars are deliberately kept.
- **Hygiene CSS**: `overflow-anchor: none` (Chrome silently adjusts your scroll offset when content above changes size), `scroll-behavior: auto`, no carets, no focus rings, no selection highlight, scrollbars hidden at the browser level rather than via CSS (which would change layout width).
- **Smooth-scroll libraries** are detected and neutralised: `lenis.stop()`, `ScrollSmoother.smooth(0)`, `ScrollTrigger.normalizeScroll(false)`. A Lenis instance is captured at construction time, since sites rarely expose one.
- **Clocks** are virtualised — `Date.now`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `setInterval` all run off the frame index. `--clock real` if this breaks a page.
- **CSS and WAAPI animations** are paused and seeked per frame. Scroll-driven animations (`animation-timeline`) are deliberately left alone — they're a pure function of scroll offset, so setting the offset already puts them in the right place.

---

## Output

| Extension | Codec |
|---|---|
| `.mp4` | H.264, CRF 12, **yuv444p** — full chroma, because 4:2:0 is what puts coloured fringes on glyph edges |
| `.mov` | ProRes 4444 — editor-friendly master |
| `.png` | numbered PNG sequence in a directory — truly lossless |

Frames come out of Chrome as lossless PNG, so the encode is the only lossy step. If you have your own compression pipeline, render ProRes or PNG and feed it that.

**Use `--dpr 2` or `3`, never a fractional value.** Chrome stores scroll offsets on the device-pixel grid, so your effective scroll quantum is `1/dpr` CSS pixels. At DPR 1 you get integers only, and an eased curve's slow tails oscillate between 0 and 1 px per frame — visible stutter exactly where the motion should feel smoothest. Fractional DPRs quantise unevenly, which is worse. This is why 2× matters for *motion*, not just sharpness.

---

## Speed

Every time-dependent thing is seeked rather than read from the wall clock, so frame *N* doesn't depend on frame *N−1* having been rendered. That makes the frame range shardable across parallel browsers, which is where the speed comes from:

```bash
tapeworm site.json --jobs 8
```

Default is `min(4, cores-1)`. Each shard renders a contiguous range into its own segment; segments are concatenated without re-encoding. More jobs means more memory and more pre-warms, so past about 8 you're usually trading.

---

## CLI

```
tapeworm <config.json> | <url> | -     # - reads the config from stdin
-o, --out <path>       output file; extension picks the codec
    --fps <n>          default 60
    --width <px>       CSS pixels, default 1280
    --height <px>      CSS pixels, default 800
    --dpr <n>          device pixel ratio, default 2
    --crf <n>          H.264 quality, lower is better, default 12
-j, --jobs <n>         parallel browsers
    --auto             discover sections instead of using the config timeline
    --sections <n>     how many sections --auto visits, default 6
    --video <mode>     sync | freeze | ignore
    --clock <mode>     virtual | real
    --prewarm <mode>   full | cache | none, default full
    --reveals          shorthand for --prewarm cache
    --image-budget <ms>  longest a frame waits for a loading image
    --settle <ms>      wait after load before doing anything
    --wait-for-intro <ms>  max wait for intro/preloader animations, default 8000
    --replay-intro     rewind the intro so it plays on camera instead
    --no-unlock-intro  don't wheel through a scroll-gated intro
    --headful          show the browser window
    --chrome-path <p>  path to a Chrome binary
    --dry-run          print the plan and exit
```

---

## Authoring timelines visually

Hand-writing selectors and guessing holds works, but there are two faster ways to build a timeline.

**`tapeworm author <url>`** opens a headful Chrome with the render's exact flags, emulated viewport, and injected runtime, pre-warms the page the same way a render would, and overlays an element picker. Click elements to add keyframes — each shows its generated selector and an honesty grade (`id` / `data` / `class` / `structural`, the last meaning "works today, breaks on a redesign"). Terminal keys: `p` toggles the picker, `u` undoes the last pick, `w` writes the config, `q` quits (also writes). `--out config.json` names the file; otherwise the JSON goes to stdout.

Because author mode *is* the render environment, it's also the tiebreaker: if the browser extension and a render ever disagree about where an anchor lands, what author mode shows is what the render will do.

**The Chrome extension** (in `extension/`, load unpacked via `chrome://extensions`) authors in your everyday browser: click the toolbar action, pick elements on the page, edit timing/easing/holds in the side panel, preview the motion in real time, export the config. Two honesty features matter:

- The render always captures the **full viewport at the configured size**, and CSS breakpoints mean a page laid out in a different-sized window is a different page. So the extension doesn't draw a pretend frame inside your window — **Fit window** (with viewport presets) resizes the browser window until the page viewport *is* the render viewport, and a badge on the page says ✓ when it matches or warns when it doesn't. Author at the size you'll render at.
- **Prepare page** steps through the whole page the way the renderer's pre-warm does, so lazy content loads and scroll reveals fire *before* you pick. Skipping it means anchors resolve against un-fired reveal transforms — positions the render will never see. Do it first.

The extension can't send trusted input, so a scroll-gated intro (see above) has to be scrolled through by hand once — the overlay tells you when that's the case. The renderer still unlocks it automatically at capture time.

Exported configs carry a `meta` block (`authoredWith`, `authoredAt`, `authoredViewport`, `url`) that the renderer ignores but keeps for diagnosing authoring/render drift.

The extension ships `src/shared/*.js` verbatim (selector generation, anchor resolution, easing) — `npm run sync-shared` copies them, and a test fails if the copies drift. That shared core is why the picker, the preview, and the render agree.

---

## When it goes wrong

**"page moved the scroll offset"** — something is fighting the scroll. Usual suspects, in order: `scroll-snap-type` (Chrome re-snaps after programmatic scrolls), a smooth-scroll library that wasn't detected, or `content-visibility: auto` changing the document height as you scroll. Try `"page": { "css": "* { scroll-snap-type: none !important }" }`. The render continues and reports the affected frames rather than aborting.

**Content pops in mid-shot** — pre-warm didn't reach it. Raise `prewarm.timeout`, or check whether it's behind an interaction rather than a scroll. If it's a reveal you *want*, see `--reveals` above.

**A reveal snaps instead of fading in `--reveals` mode** — raise `--image-budget`; the image probably arrived after the transition had started.

**Reveals never animate** — that's `--prewarm full` working as intended; they're already revealed. Use `--reveals` if you want them on camera.

**The page renders but nothing moves** — the document isn't the scroller. If it's a scroll-gated intro, unlocking handles it (see above). If it's an app shell scrolling an inner `overflow: auto` element, that isn't supported yet.

**Video is one frozen frame** — check the note in the output. Almost always Range requests.

**A page breaks with the virtual clock** — `--clock real`. You lose deterministic JS animation timing but keep everything else, including video seeking.

Set `TAPEWORM_DEBUG=1` to see Chrome's stderr, and `--headful` to watch it work.

---

## Known limits

- **Inner scroll containers** aren't supported — only the document scroller.
- **Full-page-section hijackers** (fullPage.js, Webflow page sections) need per-library adapters that don't exist yet.
- **Cross-origin iframes** are opaque: their animations and video can't be controlled.
- **No motion blur.** The correct approach is supersampling — render at 4–8× the frame rate in sub-frame steps and average — which isn't implemented. It would come free from the existing frame-index model.
- **No audio.** By design; this is a picture pipeline.
- **`--dpr` above 3** works but memory climbs fast at large viewports.

---

## Layout

```
bin/tapeworm.ts   CLI: arg parsing, progress, output
src/types.ts       config schema — the source of truth for what's configurable
src/config.ts      defaults + validation
src/cdp.ts         minimal CDP client over --remote-debugging-pipe (no deps)
src/browser.ts     finding and launching Chrome, and the flags that matter
src/runtime.ts     the in-page runtime: clock, video, animations, scroll, hygiene
src/page.ts        opening a page, pre-warm
src/easing.ts      curves, peak-velocity analysis, auto-duration
src/timeline.ts    config + anchors -> one scroll offset per frame
src/render.ts      frame loop and shard scheduler
src/encode.ts      ffmpeg
```

`src/runtime.ts` is the interesting one — it's a JS payload injected before the page's own scripts, which is what makes it possible to override the clock they capture.
