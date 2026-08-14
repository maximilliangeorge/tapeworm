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

**Interactions**: `{ "type": "click", "target": { "selector": "#menu-btn" }, "settle": 0.8 }` (and `hover` likewise) performs the interaction mid-timeline with **real input** through Chrome's input pipeline — `isTrusted` is true, `:hover` styles apply, and libraries that ignore synthetic events respond. `target` must be an element anchor and must be **in view** when the interaction fires — an off-screen target is an error rather than a click on whatever is on screen instead, so `move` to it first. `settle` (default 0.6s) is how long the timeline dwells afterwards while whatever it triggered animates — a menu opening over 300ms starts at the right frame and eases correctly, courtesy of the same animation birth-time machinery everything else uses. The pointer stays on the target through the settle — its `:hover`/`:active` state is part of the shot — and is parked off-page the moment the timeline scrolls on: Chrome re-computes `:hover` on every scroll, so a pointer left at the interaction point would hover everything that scrolls past it for the rest of the render. Because frame N now shows whatever earlier clicks did to the page, an interactive timeline renders sequentially (`jobs` is forced to 1, like prewarm `cache`/`none`).

**Clicks may navigate.** A timeline can click a link and keep going on the destination page — anchors after the click resolve there. To make that possible, interactions are *performed while the plan is built* (a click has to happen before the far side of it can be seen), the page is reset to the configured URL for the capture pass, and each navigation mid-render waits the new view in, settles it (intro, consent, scroll gate), and pre-warms it before filming continues. This also means `--dry-run` on an interactive timeline does perform the interactions to resolve the plan — it just skips rendering.

That covers both kinds of navigation. A document load is spotted with a marker the new document can't have. A **client-side router** instead swaps the view under the same document, so the tell is that `location.href` moved — and since there is no load event to wait for and `readyState` is already `complete`, the destination is waited in by watching the DOM until it stops mutating. Routers routinely animate the old view out, sit still for a beat, and only then mount the new one, so the wait deliberately requires a longer lull (0.75s) than that gap. As a further backstop, once any interaction has been performed a missing anchor is retried for up to 5s before it's reported as a bad selector — the same patience covers a modal mounting or a tab revealing its panel. Before the first interaction there's nothing to wait for, so a bad selector still fails immediately.

**The route transition is content, and it stays in the video.** The waiting above happens only while the plan is built. During capture, a click that routes client-side keeps filming: the transition — exit animation, view swap, entrance animation — plays across the click's settle frames, seeked per frame by the same virtual clock as everything else. Those frames are *free*: the page owns the scroll while the router swaps views (the outgoing view holds the click offset; the router jumps to the top when the new view mounts), so tapeworm imposes no offset and reports no scroll drift there. When the click has no explicit `settle`, the settle is sized to the transition measured during planning (at least the 0.6s default, capped at 4s), so the whole swap fits on camera; if you set a shorter `settle` yourself, the plan warns with a ⚠ that the timeline may take the scroll back mid-transition. A full document load is different — tearing down the document destroys any transition, so there is nothing to film, and the new page is settled and pre-warmed off-camera in both passes.

**Recorded gestures**: a `record` step replays a captured stretch of *your* real interaction — pointer movement, clicks and drags, scrolling — exactly as you performed it. You don't write one by hand; the extension's **● Record** button (or `r` in `tapeworm author`) captures it: interact with the page, press **ESC**, and the whole gesture becomes one step.

```jsonc
{
  "type": "record",
  "samples": { "t": [0, 16, 33, …], "x": [512, 514, 519, …], "y": [300, 301, 303, …], "s": [0, 0, 2, …] },
  "buttons": [{ "t": 1204, "action": "down" }, { "t": 1287, "action": "up" }],
  "viewport": { "width": 1280, "height": 800, "dpr": 2 },
  "smoothing": true,
  "hold": 0.5
}
```

`samples` are parallel arrays — one entry per captured frame: `t` ms from the recording's start, `x`/`y` the pointer in viewport CSS px, `s` the scroll offset. `buttons` are the left-button edges. During the render, the recorded scroll becomes the scroll track for those frames, and the pointer is driven per frame through Chrome's real input pipeline — `:hover` states, drags, and clicks all behave as they did live, and anything they animate is seeked by the same birth-time machinery as every other animation. A cursor sprite is drawn into the page so the gesture is visible on camera (`"page": { "cursor": false }` hides it; the input still happens). Like `click`/`hover`, a recording is path-dependent, so it forces sequential rendering (`jobs: 1`).

The sprite is replaceable at render time — the macOS cursor set, a touch-style dot, or one sprite of your own:

```jsonc
"page": { "cursor": { "auto": true } }
"page": { "cursor": { "dot": true } }
"page": { "cursor": { "image": "hand.png", "tip": [14, 2], "size": 40 } }
```

`auto` draws the macOS cursors bundled in `assets/cursors/` (SVGs from [cursor.in](https://github.com/sawyerh/cursor.in)), and — like the real OS pointer — switches sprite every frame based on the CSS cursor in effect under the pointer: the arrow over plain page, the pointing hand over links and buttons, open hand over `cursor: grab` (closing while the button is held), plus `move`, `copy`/`alias`, `help`, `not-allowed`/`no-drop`, `zoom-in`/`zoom-out`, `nesw-resize`, and `crosshair`. Keywords the set has no artwork for (notably `text` — there's no I-beam in cursor.in — and the other resize directions) fall back to the arrow. Each cursor renders at its natural macOS size with its own hotspot (arrow point, fingertip, palm centre) landing on the recorded point; `size` rescales the whole set proportionally, stated as the arrow's rendered width in CSS px (default 28, its natural size). The lookup is `elementFromPoint` at the frame's coordinates — a pure function of pointer position and document state, so frames stay independent.

`dot` draws the same circular marker the extension's preview uses — a dark disc with a white ring, centred on the recorded point, turning blue while the button is down. It reads as a fingertip rather than a mouse pointer, which makes it the more pedagogic choice for touch-style demos. `size` is its diameter in CSS px (default 18, matching the preview).

`image` is instead a single fixed sprite: a local image file (png/svg/gif/jpeg/webp — embedded into the render at config time, so a typo'd path fails before Chrome launches), or an `https:`/`data:` URL. `tip` is the [x, y] px inside the rendered sprite where the pointer tip sits — the point that lands on what the recording pointed at (default `[0, 0]`, the top-left corner). `size` is the rendered width in CSS px, height keeping the image's aspect (default 32). The press feedback (a slight shrink around the tip while a button is down) applies in every mode. From the CLI, `--cursor auto` / `--cursor dot` / `--cursor hand.png` do the same, `--cursor-size 40` sets the size, and `--cursor none` hides it.

By default the sprite pops in on the recording's first frame and pops out when the scroll first moves off wherever it parked (through a `hold`, the sprite stays up). `"fade": 0.3` softens both edges: the sprite ramps to full opacity over its first 0.3s on screen and back to nothing over its last 0.3s, ending exactly where it used to vanish — timings don't shift, and a run too short for both ramps shrinks them so they never cross. It works with the built-in arrow alone (`"cursor": { "fade": 0.3 }`), alongside `auto` or `dot`, or alongside `image`/`tip`/`size`; `0` (the default) means no fade. From the CLI, `--cursor-fade 0.3`. The opacity is computed per frame index like everything else, never from the wall clock. The extension has the same knob (**Cursor fade** in the setup panel): its preview dot fades identically, and the exported config carries the value into the render.

**Cursor smoothing** is opt-in, per take: `"smoothing": true` (or `{ "mode": "denoise", "strength": 0..1 }` — `true` means strength 0.5) resolves the pointer path through a zero-phase Gaussian kernel instead of replaying the raw samples verbatim. Hand tremor and the integer stairsteps of capture disappear while the route and its timing stay yours — resolution is offline with the whole take known, so unlike a live filter there is no lag and no overshoot. The path is pinned through the raw positions at every button edge and at the take's ends — presses, releases and a drag's grab/drop points land exactly where they were recorded — and the pin is a translation of the smooth path, not a blend back to the raw one, so the motion stays equally smooth through a click. Everything between them — drag routes included — is smoothed, which is the honest cost of opting in: the pointer path the render *dispatches* (what gets hovered or dragged through mid-flight) can differ slightly from the live capture, which is why verbatim replay stays the default. Scroll is never smoothed. The extension's record-step editor exposes the same control (off / light / medium / strong), and its preview plays the smoothed path through the same shared core the render uses.

Three rules keep recordings honest:

- **The viewport is part of the recording.** The step stamps the viewport it was captured at, and a render at any other size is refused — breakpoints make a different size a different page, and scaling coordinates would click the wrong things. Fit the window before recording (the extension pushes you to), or set the config's `viewport` to the recorded size.
- **Recorded clicks may route, but not load.** A recorded click that triggers a **client-side route change** replays fine: the document survives, the frames after the click were recorded on the destination view, and the render films straight through the transition. To make the far side resolvable, a recording that contains clicks is *replayed while the plan is built* — same as click steps — so a routed-to view gets settled and pre-warmed, and later anchors resolve there. A click that **loads a new document** is refused (at plan time, before a capture pass is wasted): the rest of the recording belongs to a page that no longer exists, and the load itself takes network wall-clock time no frame-indexed replay can reproduce. The authoring tools handle that for you — when a recorded click navigates to a new document, the take is automatically **split at that click** into `record` → `click` → `record`, and recording resumes on the destination (see the extension section below).
- **The recording's scroll wins.** If the timeline stands somewhere else when the recording begins, the video cuts to the recording's starting offset — the plan warns with a ⚠ so you can add a `move` to its start first.

The raw samples stay in the config on purpose: the sample-to-frame resolution lives in `shared/gesture-core.js`, so turning `smoothing` on (or off, or up) simply re-resolves an existing recording — no re-recording, and future resolution modes get the same property. Expect recorded scroll to be noisier than a `move` on `scroll-snap` pages: the page re-snaps offsets a human scroll passed through, and the drift note will say so.

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

### Embeds (YouTube, Vimeo)

A cross-origin embed's inner `<video>` is unreachable (cross-origin DOM in a separate renderer process), so embeds get their own mechanism: tapeworm drives the provider's player through its postMessage API from the top frame — pausing it, muting it, and seeking it to each frame's timestamp. `page.embeds` (CLI `--embeds`) takes the same three modes as `page.video` and **defaults to whatever `page.video` is**, so most configs never mention it; set it separately when you want native videos synced but an embed frozen.

Page UI built on the providers' JS SDKs keeps working while tapeworm holds the player paused. A paused Vimeo player never emits the `timeupdate` stream a playing one does, so in sync mode tapeworm re-broadcasts each frame's timestamp as the same `timeupdate` message the player posts during real playback — a custom scrubber or chapter highlight wired to `player.on('timeupdate', …)` tracks the render timeline instead of freezing at 0. When the timeline runs past the embed's duration, the stream pins one final `timeupdate` at `percent: 1` and goes quiet, the way a finished player does. Each embed also gets a **birth time**: one that mounts mid-render (a click-opened overlay player) is seeked from its own zero, not the render's global clock — otherwise a short video in a long render would start midway or sit past its end, frozen on its last frame.

`play` is broadcast too, once, just ahead of the first `timeupdate`. Without it a play/pause button reads the *real* `pause` that tapeworm's own autoplay defense provokes and sits on the wrong icon for every frame of the output while the video visibly advances behind it. If the player emits a real `pause` later, the next frame restates `play`. The side effects are real and accepted: a page's `play` handler runs during the render, so analytics fire and pause-other-players logic runs — a page that can't take that wants `freeze` or `ignore`.

**A pause the page itself commands is honored** (Vimeo only). The player acks every method call it receives, and tapeworm counts its own pause commands against those acks — an unmatched pause ack means the page's own `player.pause()` ran, whether from a scripted click or a pause-on-scroll/visibility handler reacting to the timeline. The embed then freezes on the frame it stopped at, one synthetic `pause` flips the page's UI (the really-already-paused player emits no event for a no-op pause), and the `timeupdate` stream goes quiet the way a paused player's does. When the page calls `play()` again, playback resumes from the paused-at time — the frames spent paused don't skip ahead — and a scrub while paused (`pause()` then `setCurrentTime()`) moves the resume point. This makes those frames depend on *when* the pause landed, which is fine only because sync-mode embeds already run single-worker. YouTube's widget protocol has no per-command acks, so a page pause there is invisible from the top frame and the control keeps driving.

Some events are deliberately *not* faked: `pause` outside the page-commanded case above (the page hears the player's real ones, and an unprompted forged one would only undo the `play` above), `ended` (pages routinely close or hide their player when the video finishes — a forged `ended` blanks the embed on camera; the pinned `timeupdate` carries the same information without commanding anyone's UI — and past the end no `play` is announced either, since a stopped player isn't playing), and `cuepoint` (it only fires when playback crosses a registered cue point, which paused seeks never do). Everything else — `seeked`, `progress`, buffering, volume — the paused player still emits for real. YouTube needs no equivalent — a page's own `YT.Player` registers its own listening channel and the widget keeps it informed on every seek.

Honest caveats, because this path is best-effort where the native one is exact:

- **Provider seeks are keyframe-coarse.** The player snaps to what's buffered and keyed, so an embed can sit a couple hundred ms off the exact frame time. Fine in a scrollthrough; not a mastering path.
- **Sync-mode embeds force `--jobs 1`.** Each parallel worker would buffer the stream independently, and a shard boundary could land inside the embed on a visibly different frame. The render says so when it clamps; `--embeds freeze` or `ignore` restores parallelism.
- **An embed shorter than the timeline holds its last frame.** Provider embeds don't loop, so once the render's clock passes the video's duration every seek clamps there and the picture stops moving — for a 10s video in a 20s render, exactly halfway. That's the video ending, not the render breaking; the pre-render probe now says so. Shorten the timeline, or accept the still.
- **YouTube embeds need `enablejsapi=1`** in the iframe URL. tapeworm adds it automatically at discovery (which reloads the iframe — harmless during page load/pre-warm, and only ever during a render).
- **An embed nobody wrote an adapter for** (or one that never answers the handshake — consent walls inside the iframe do this) free-runs on the wall clock exactly as before, and the pre-render probe names it. There is no way to freeze an arbitrary cross-origin iframe from outside; composite separately if it matters.
- YouTube may still inject ads; no API controls that.

**Won't work, no workaround:** DRM/EME content (captures black), live streams, non-YouTube/Vimeo embeds. Use `"freeze"` (native video) and composite separately.

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

`from` is a URL wildcard (`*` matches any run of characters, `?` a single one) matched against the full request URL — note that's anchored, so end with `*` if the URL carries a query string. To find the URL to match, use the extension's **Export assets** (⋯ menu): it downloads a JSON record of every URL the page fetched, biggest first. `to` is either an https URL or a local file path (relative to the working directory, checked at config time). It works the way DevTools "local overrides" does, invisibly to the page: a remote replacement is fetched in the original request's place, and a local file is served straight from disk at the interception layer, with full HTTP Range support — so a substituted video still seeks per frame. The interception survives navigation, applies during pre-warm and `cache`-mode reloads, and is a pure function of the URL, so it doesn't affect sharding.

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
- **localStorage** can be seeded before the page's own scripts run: `page.localStorage` is an object of key→value strings written into storage on the config url's origin (top frame; navigations elsewhere keep their own storage). The render's profile is pristine, so state the page keeps there — a consent choice, an intro-seen flag, a theme — is otherwise gone at render time and the page films differently than it was authored. The extension's **localStorage** setting captures the snapshot at export time; mind that a snapshot is verbatim and may contain session tokens, so only share configs you'd share the contents of. Seeding is a pure function of the config, so it doesn't affect sharding.
- **Clocks** are virtualised — `Date.now`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `setInterval` all run off the frame index. `--clock real` if this breaks a page.
- **Randomness** stays random unless you opt in: `page.seedRandom` (CLI `--seed-random`, or `--seed-random=7` for a specific seed) stubs `Math.random` with a seeded PRNG so a page that randomises — a particle field, shuffled testimonials, generative art — films the same way every run. `true` seeds with 42; an integer picks the seed. The generator is reseeded from (seed, frame time) at every frame step, so a frame's draws never depend on how many draws earlier frames made — which is what keeps the frame range shardable across `--jobs`. Draws made during load and pre-warm come off the base seed, identical in every worker. `crypto.getRandomValues` is left alone.
- **CSS and WAAPI animations** are paused and seeked per frame. Scroll-driven animations (`animation-timeline`) are deliberately left alone — they're a pure function of scroll offset, so setting the offset already puts them in the right place.

---

## Output

| Extension | Codec |
|---|---|
| `.mp4` | H.264, CRF 12, **yuv444p** — full chroma, because 4:2:0 is what puts coloured fringes on glyph edges |
| `.mov` | ProRes 4444 — editor-friendly master |
| `.png` | numbered PNG sequence in a directory — truly lossless |

Frames come out of Chrome as lossless PNG, so the encode is the only lossy step. If you have your own compression pipeline, render ProRes or PNG and feed it that.

**Sampling a single frame.** `--frame <t>` (config `"frame"`) renders exactly one frame of the timeline as a single PNG file instead of a video — the fast way to check composition, an anchor's framing, or a hover state without paying for a render. `t` is seconds into the timeline (`--frame 2.5`), or a percent of it (`--frame 50%`; `100%` is the last frame). The whole timeline is still planned, and a path-dependent render (interactions, recordings, prewarm `cache`/`none`) still walks the frames before the sampled one off camera, so the PNG is pixel-identical to that moment of a full render. `--out` names the file (default `frame.png`); pointed at a config whose output is a video, the sample lands next to it as its `.png` sibling (`demo.mp4` → `demo.png`), and `output.codec` is ignored. `trim` doesn't apply — the frame you asked for is the frame you get. The walk itself is fast: runs of frames with no input to dispatch are stepped in-page in batches (clock, scroll, timers, animation and embed birth stamps — everything later frames can depend on) rather than one round trip per frame, and the pre-render video/embed probe is skipped, since the sample surfaces the same problems itself.

**Frame accuracy.** On a path-dependent timeline the walk is still proportional to where the sample sits, so `--frame-accuracy` (config `"frame": { "at": …, "accuracy": … }`) can trade determinism for speed:

| accuracy | what it does | what can differ from a full render |
|---|---|---|
| `exact` | walks every frame before the sample — the default | nothing: pixel-identical |
| `segment` | restarts at the last **full-page navigation** at or before the sample, skipping everything on earlier documents | only pages that render differently on direct load (referrer checks, route guards) |
| `jump` | additionally steps the walk on the virtual clock alone — no rendering between frames — and replays only recorded **clicks**, not pointer movement | hover-dependent state from mid-recording movement; scroll-reveal and media phases far from the sample |

`segment` leans on the fact that a document load destroys all in-page state: the destination's state is URL + storage + HTTP cache, all of which the plan phase populated by actually performing the click chain, plus the actions after the load — which still replay. Client-side route changes are *not* boundaries (the document survives them, so router state genuinely carries). `jump` keeps the virtual clock honest — timers and the page's own rAF loop still tick once per frame, and a soft navigation is given real time to fetch and mount — and turns real rendering back on for the last second before the sample, so IntersectionObserver reveals and animations near the target sit close to where an exact walk would put them. `jump` needs prewarm `full`; with `cache`/`none` it downgrades to `segment` with a note, because filming reveals depends on the exact scroll path. For a quick composition check, `jump` is usually indistinguishable and an order of magnitude faster; anything you'd ship, verify with `exact`.

**Watching frames interactively.** `--watch` (with `--frame`) keeps the browser and the built plan alive after the sample, so repeated peeks stop repaying launch + prewarm + planning. Type a new target (`3.2`, `75%`) and press enter to re-render the PNG in place; a peek ahead of the last one walks forward from where the page already stands, a peek behind resets (to the segment boundary when accuracy allows). Saving the config file re-plans from scratch, with the same CLI flags re-applied. Ctrl-C or Ctrl-D quits.

**Trimming.** `"trim": { "start": 1000, "end": 500 }` cuts milliseconds off the ends of the finished video (either side optional, default 0). The whole timeline is still planned, and nothing time-seeked shifts — the output is exactly what you'd get by rendering everything and cutting the file afterwards, so it's the way to drop the opening hold or the last dwell without re-authoring the timeline. Trimmed-off frames aren't captured or encoded; a path-dependent render (interactions, recordings, prewarm `cache`/`none`) still walks through them off camera so the page state stays right. A trim that leaves nothing is refused before rendering starts.

**Use `--dpr 2` or `3`, never a fractional value.** Chrome stores scroll offsets on the device-pixel grid, so your effective scroll quantum is `1/dpr` CSS pixels. At DPR 1 you get integers only, and an eased curve's slow tails oscillate between 0 and 1 px per frame — visible stutter exactly where the motion should feel smoothest. Fractional DPRs quantise unevenly, which is worse. This is why 2× matters for *motion*, not just sharpness.

---

## Speed

Every time-dependent thing is seeked rather than read from the wall clock, so frame *N* doesn't depend on frame *N−1* having been rendered. That makes the frame range shardable across parallel browsers, which is where the speed comes from:

```bash
tapeworm site.json --jobs 8
```

Default is `min(4, cores-1)`. Each shard renders a contiguous range into its own segment; segments are concatenated without re-encoding. More jobs means more memory and more pre-warms, so past about 8 you're usually trading.

---

## Config reference

Everything a config file can say, with defaults. The machine-readable source of truth is the `Config` type in `src/types.ts`; this section mirrors it, and so does a published [JSON Schema](schema/tapeworm.config.schema.json) — point a top-level `"$schema"` at it and your editor validates and autocompletes the config as you type. Configs are JSON with two mercies for hand-edited files: **full-line `//` comments and trailing commas are tolerated** (inline comments after a value are not — they break the parse).

| Key | Default | |
|---|---|---|
| `$schema` | — | URL or path of the config's JSON Schema, for editors: `https://raw.githubusercontent.com/maximilliangeorge/tapeworm/main/schema/tapeworm.config.schema.json` (or a relative path to `schema/tapeworm.config.schema.json`). Ignored by the renderer; the extension stamps it into every export. |
| `url` | — | The page to record. Required — unless the timeline's `start` step carries a `url` (authoring tools stamp it there); if both are present they must agree. |
| `viewport.width` | `1280` | CSS px. |
| `viewport.height` | `800` | CSS px. |
| `viewport.dpr` | `2` | Device pixel ratio, integer 1–4. Use 2 or 3 — see "Output" for why never 1 or fractional. |
| `fps` | `60` | 1–240. |
| `timeline` | — | The scroll script — entries below. Required unless `auto` is set. |
| `auto` | `false` | `true` (or `{ "maxSections": 6 }`): discover sections and march through them instead of a timeline. |
| `output.path` | `"out.mp4"` | An extensionless path gets `.mp4`/`.mov` appended; a `png` render is a directory. |
| `output.codec` | from extension | `h264` (.mp4/.m4v) \| `prores` (.mov) \| `png`; `h264` when the extension says nothing. |
| `output.crf` | `12` | H.264 quality, lower = better. |
| `prewarm.mode` | `"full"` | `full` \| `cache` \| `none` — see "Lazy loading and scroll reveals". `cache`/`none` force `jobs: 1`. (Legacy aliases still parse: `"enabled": false` means `none`, `"reloadAfter": true` means `cache`.) |
| `prewarm.maxHeight` | `60000` | Stop stepping past this document height (px). |
| `prewarm.timeout` | `30000` | Give up pre-warming past this many wall-clock ms. |
| `prewarm.imageBudget` | `400` / `1500` | Longest a frame waits for a loading image (ms): 400 in `full` (nothing should be pending), 1500 in `cache`/`none`. |
| `frame` | — | Sample one frame as a single PNG instead of rendering the video: seconds into the timeline, or a percent string (`"50%"`) — see "Output". CLI: `--frame`. |
| `trim.start`, `trim.end` | `0` | Milliseconds cut off the ends of the finished video — see "Output". |
| `jobs` | `min(4, cores−1)` | Parallel Chromes. Forced to 1 by prewarm `cache`/`none`, by `click`/`hover`/`record` steps, and (at render time) by sync-mode provider embeds. |
| `chromePath` | auto-detect | Path to a Chrome / chrome-headless-shell binary. |
| `headful` | `false` | Show the browser window. |
| `meta` | — | Provenance stamped by authoring tools (`authoredWith`, `authoredAt`, …). Ignored by the renderer. |

Everything under `page` shapes the page before and during filming:

| Key | Default | |
|---|---|---|
| `page.dismissConsent` | `true` | Try to dismiss cookie/consent dialogs (prefers "reject"). |
| `page.hideOverlays` | `true` | Remove late-appearing fixed overlays (chat widgets, newsletter modals). |
| `page.clock` | `"virtual"` | `virtual` runs `Date.now`/`performance.now`/rAF/timers off the frame index; `real` leaves them alone. |
| `page.seekAnimations` | `true` | Pause and seek CSS/WAAPI animations per frame. |
| `page.seedRandom` | off | Stub `Math.random` with a seeded PRNG so a randomised page films the same every run: `true` = seed 42, or an integer seed. Reseeded per frame from (seed, frame time), so sharding survives — see "Page hygiene". |
| `page.video` | `"sync"` | `sync` \| `freeze` \| `ignore` — see "Video on the page". |
| `page.embeds` | follows `video` | Same modes for YouTube/Vimeo iframes — see "Embeds". `sync` forces `jobs: 1`. |
| `page.cursor` | `true` | The drawn gesture cursor: `false` hides it, `{ "auto": true }` the macOS set, `{ "dot": true }` the touch disc, `{ "image": …, "tip": [x, y] }` your own sprite — each also takes `size` and `fade`. See "Recorded gestures". |
| `page.css` | `""` | Extra CSS injected before the page's own scripts run. |
| `page.script` | `""` | Extra JS injected before the page's own scripts run. |
| `page.settle` | `0` | Wait this many ms after load before doing anything. |
| `page.waitForIntro` | `8000` | Max ms to wait out intro/preloader animations; `0` disables. |
| `page.replayIntro` | `false` | Rewind animations at capture start so the intro plays on camera. |
| `page.unlockIntro` | `true` | Wheel through a scroll-gated intro; `false`, or `{ "maxTicks": 40, "deltaY": 400 }` to tune. |
| `page.substitute` | `[]` | `[{ "from": "url pattern", "to": "url or file" }]` — swap assets at the network layer, see "Substituting assets". |
| `page.localStorage` | — | `{ "key": "value", … }` (strings) seeded into localStorage before the page's scripts run, on the config url's origin — see "What else it does to the page". The extension captures it with its **localStorage** setting. |

Timeline entries are legacy segments or typed steps, mixed freely (see "Anchors, not pixels" and "Typed steps" for the semantics):

| Entry | Fields |
|---|---|
| segment (no `type`) | `at` (first entry) or `to` (anchor), `duration?` s, `ease?`, `hold?` s. Durations derive from distance when omitted; holds default 0.8s at the ends, 0.6s between. |
| `start` | `at` (anchor), `hold?` s, `url?`. First entry only; one is synthesized (`at: "top"`) if the timeline starts with anything else. |
| `move` | `to` (anchor), `duration?` s, `ease?` (default `"natural"`), `hold?` s. |
| `hold` | `seconds`. |
| `click`, `hover` | `target` (element anchor, must be in view), `settle?` s (default 0.6). Forces `jobs: 1`. |
| `wait` | Part of the format, not executable yet — parses, then is rejected with a clear message. |
| `record` | `samples` (parallel arrays `t`/`x`/`y`/`s`), `buttons?`, `viewport` (required; the render refuses any other size), `smoothing?`, `hold?` s (default 0). Forces `jobs: 1`. |

An anchor is `"top"`, `"bottom"`, a raw pixel offset, or `{ "selector", "align"?, "offset"?, "nth"?, "fallbackText"? }`. An ease is a name from "Motion" or a raw cubic-bezier `[x1, y1, x2, y2]`.

**What's checked, and when.** A config is not statically type-checked — it's validated as it loads and plans. Every value that's read is checked with a pointed error: an unknown step type or ease name lists the known ones, malformed `record` samples name the offending sample, out-of-range numbers state the range, and local files (a cursor image, a `substitute` replacement) are resolved and checked at config time, so a typo'd path fails in seconds rather than minutes into a render. **Unknown keys are rejected too**, all reported at once, each with a guess at the key you meant (`unknown key "waitforIntro" in "page" — did you mean "waitForIntro"?`) — a misspelled key would otherwise silently fall back to the default of the key you meant, which is the worst kind of failure: nothing errors, the render just ignores you. The one deliberately unchecked place is `meta`, which is free-form by design. `--dry-run` is still the cheap way to confirm a config means what you think it does.

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
    --frame <t>        sample one frame as a single PNG: seconds into the
                       timeline, or a percent ("50%") — see "Output"
-j, --jobs <n>         parallel browsers
    --auto             discover sections instead of using the config timeline
    --sections <n>     how many sections --auto visits, default 6
    --video <mode>     sync | freeze | ignore
    --embeds <mode>    same modes for YouTube/Vimeo iframes, default: follows --video
    --clock <mode>     virtual | real
    --seed-random[=n]  stub Math.random with a seeded PRNG so a randomised page
                       films the same every run; n = integer seed, default 42
    --cursor <c>       replace the drawn gesture cursor: "auto" (the macOS set,
                       following the CSS cursor under the pointer), "dot" (the
                       preview-style touch disc), or an image; "none" hides it
    --cursor-size <px> rendered cursor width (for auto: the arrow's width,
                       the rest of the set scales proportionally)
    --cursor-fade <s>  fade the drawn cursor in/out over this many seconds, default 0
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

**`tapeworm author <url>`** opens a headful Chrome with the render's exact flags, emulated viewport, and injected runtime, pre-warms the page the same way a render would, and overlays an element picker. Click elements to add keyframes — each shows its generated selector and an honesty grade (`id` / `data` / `class` / `structural`, the last meaning "works today, breaks on a redesign"). Terminal keys: `p` toggles the picker, `r` records your interactions until you press ESC in the browser window (they become a `record` step), `u` undoes the last pick, `w` writes the config, `q` quits (also writes). `--out config.json` names the file; otherwise the JSON goes to stdout. Navigating while authoring is fine: the overlay re-attaches on the new document (settled and pre-warmed like a render would), and a recording that a navigation split resumes there automatically.

Because author mode *is* the render environment, it's also the tiebreaker: if the browser extension and a render ever disagree about where an anchor lands, what author mode shows is what the render will do.

**The Chrome extension** (in `extension/`, load unpacked via `chrome://extensions`) authors in your everyday browser: click the toolbar action, pick elements on the page, edit timing/easing/holds in the side panel, preview the motion in real time, export the config. **● Record** arms record mode: a banner appears on the page, your pointer movement, clicks and scrolling are captured until you press ESC, and the take lands as one `record` step. Click through a link mid-recording and the take **splits automatically**: everything before the click stays a `record` step, the click becomes a `click` step (a real navigation at render time), and recording resumes on the destination once it loads — one continuous performance becomes `record` → `click` → `record` without re-arming anything. Previewing that timeline follows the navigation the same way: the panel re-attaches on the destination and playback resumes there, and scroll steps whose anchors only exist on the destination resolve once playback reaches them. (The preview replays a recording's scroll, traces a cursor dot, and emulates the hover under it — and its clicks and drags — with the same untrusted-input approximation hover steps use: a recorded click that routes client-side routes in the preview too, pointer-listener drags replay with the button held, and a `draggable` source gets the native dragstart→dragover→drop sequence. Libraries that gate on `isTrusted` respond only in the render, where the input is real.) Two honesty features matter:

- The render always captures the **full viewport at the configured size**, and CSS breakpoints mean a page laid out in a different-sized window is a different page. So the extension doesn't draw a pretend frame inside your window — **Fit window** (with viewport presets) resizes the browser window until the page viewport *is* the render viewport, and the panel's viewport chip says ✓ when it matches or warns when it doesn't. Author at the size you'll render at. Sizes no window can reach — the phone and portrait-iPad presets are taller than most screens, and Chrome won't shrink below ~500px wide — are **emulated** instead, with the renderer's own device-metrics override (this is what the extension's `debugger` permission is for): the page lays out at the exact target size scaled to fit the window, and the chip reads `✓ (emulated)`. Chrome shows its "started debugging" notice while that's active; cancelling the notice drops the emulation.
- **Prepare page** steps through the whole page the way the renderer's pre-warm does, so lazy content loads and scroll reveals fire *before* you pick. Skipping it means anchors resolve against un-fired reveal transforms — positions the render will never see. Do it first.

The extension can't send trusted input, so a scroll-gated intro (see above) has to be scrolled through by hand once — the overlay tells you when that's the case. The renderer still unlocks it automatically at capture time.

Timelines persist: the working timeline is autosaved per site (reopening the panel on a site restores where you left off), and 🗂 in the footer keeps a library of saved snapshots to toggle between, listed per site. Both live in the browser's extension storage, which survives browser restarts and extension updates — see the extension README for details.

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

**An embed free-runs or won't seek** — check the pre-render note: an embed nobody wrote an adapter for can't be controlled at all, a dead handshake (consent wall inside the iframe) means the player never listened, and a seek miss means the provider snapped to a keyframe. `--embeds freeze` pauses a controllable embed instead of chasing it.

**A page breaks with the virtual clock** — `--clock real`. You lose deterministic JS animation timing but keep everything else, including video seeking.

Set `TAPEWORM_DEBUG=1` to see Chrome's stderr, and `--headful` to watch it work.

---

## Known limits

- **Inner scroll containers** aren't supported — only the document scroller.
- **Full-page-section hijackers** (fullPage.js, Webflow page sections) need per-library adapters that don't exist yet.
- **Cross-origin iframes** are opaque — except YouTube and Vimeo embeds, which are driven through their player postMessage APIs (best-effort and keyframe-coarse; see "Embeds"). Anything else in an iframe free-runs.
- **Recorded gestures replay only on the layout they were captured on**: a `record` step refuses a different viewport, and a recorded click that loads a new document is refused (client-side route changes replay; for document loads the authoring tools split the take into `record` → `click` → `record` automatically).
- **No motion blur.** The correct approach is supersampling — render at 4–8× the frame rate in sub-frame steps and average — which isn't implemented. It would come free from the existing frame-index model.
- **No audio.** By design; this is a picture pipeline.
- **`--dpr` above 3** works but memory climbs fast at large viewports.

---

## Layout

```
bin/tapeworm.ts   CLI: arg parsing, progress, output
src/types.ts       config schema — the source of truth for what's configurable
src/config.ts      defaults + validation
schema/            the same schema as JSON Schema, for editor validation ($schema)
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
