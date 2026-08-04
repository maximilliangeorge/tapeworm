# tapeworm

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

`start` sets the opening position (first entry only), `move` is a scroll with the same `duration`/`ease`/`hold` fields as the segment form, and `hold` dwells at the current position. The format also defines `click`, `hover`, and `wait` steps for mid-timeline interactions; they are accepted by the parser but rejected with a clear message until interaction support lands — configs written with them today will work unchanged once it does.

---

## Motion

Omit `duration` and it's derived from the distance — sub-linear, so short hops feel snappy and long transits don't drag — then stretched if needed to keep peak velocity under a readable limit.

That cap is the part worth understanding. `inOutQuint` looks like the prettiest curve on paper, but it peaks at **5.9×** its average velocity; over a full viewport it either strobes or forces an uncomfortably long segment. The default is `inOutCubic` (peak 2.9×). Set `ease` explicitly if you disagree — the tool will warn if the result exceeds what reads as smooth motion, and let you do it anyway.

```
linear 1.0 · inOutSine 1.6 · inOutQuad 1.8 · inOutCubic 2.9 · inOutQuart 4.2 · inOutQuint 5.9 · inOutExpo 7.7
outCubic 3.0 · outQuint 4.5 · outExpo 6.2
```

You can also give a raw CSS cubic-bezier: `"ease": [0.65, 0, 0.35, 1]`.

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
