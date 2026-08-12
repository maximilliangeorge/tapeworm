# 🪱 Tapeworm — Chrome extension

Author tapeworm timelines visually: pick keyframes by clicking elements, set
timing and easing in the side panel, preview the motion in real time, export a
config the renderer runs unchanged.

## Load it

1. `npm run sync-shared` in the repo root (copies `src/shared/*.js` here —
   `npm test` fails if the copies are stale).
2. `chrome://extensions` → Developer mode → **Load unpacked** → pick this
   `extension/` directory. Chrome 114+.

To update, `git pull` and hit ⟳ on the card in `chrome://extensions`.

The manifest carries a `key`, so the extension ID is always
`bclflmcbfiplaghcgcnclooakcopnekb` no matter where the repo sits on disk —
allowlists and stored state survive a re-clone. The matching private key is
`extension-key.pem` at the repo root; it is gitignored, and you only need it to
pack a `.crx` with that same ID. **Drop the `key` field before uploading to the
Chrome Web Store** — the store assigns its own key and rejects a manifest whose
`key` doesn't match the item's.

## Use it

1. Open the page you want to film and click the Tapeworm toolbar action. This
   injects the overlay into the current tab (that's the `activeTab` permission —
   the extension has no standing access to any site) and opens the side panel.

The panel is organised around the authoring sequence, and the readiness chips
at the top answer the question that matters — *will the render match what I'm
seeing?* — as three states: viewport match, page warm-up, scroll gating.

2. **Set up the shot**: set the render viewport (or pick a preset) and hit
   **Fit window** — the browser window resizes until the page viewport exactly
   matches. The render always captures the full viewport at that size, and
   breakpoints mean a page in a bigger window is a *different* page — so author
   at the real size. The stage collapses to a summary once the viewport
   matches; the chip going red reopens it.
   Sizes no window can reach — the phone and portrait-iPad presets are taller
   than most screens — are **emulated** instead, with the renderer's own
   `Emulation.setDeviceMetricsOverride`: the page lays out, previews and
   records at the exact target viewport, scaled to fit the real window with
   input remapped through the scale, like DevTools device mode. Chrome shows
   its "started debugging" notice while the emulation is active; Cancel on
   that bar drops it and the chip goes red again. (This is what the
   `debugger` permission is for — Chrome forbids requesting it on demand, so
   it has to be granted at install.)
3. **⟳ Warm up** (also in setup): steps through the whole page like the
   renderer's pre-warm, so lazy images load and scroll reveals fire before you
   pick.
4. **＋ Scroll to**, then click things on the page. Each step shows its
   generated selector and a quality grade — `structural` is flagged as fragile.
   **⊕ Click** / **⊙ Hover** arm interaction mode instead: the next element you
   click is recorded as a click or hover step, performed with real trusted
   input during the render. In the preview, both are emulated with synthetic
   (untrusted) events — hovers continuously, plus cloned `:hover` CSS rules;
   clicks once as playback crosses them, never on scrub, and their effects
   persist (a preview can't un-open a menu — reload to reset). Close enough
   to judge timing by; the render is the truth. A click that loads a new
   document is followed: the panel re-attaches on the destination and
   playback resumes there, the rest of the click's settle dwelling at the
   destination's top the way the render films it. Scroll-to steps whose
   target only exists on the destination resolve when playback reaches them
   (until then the ruler shows an estimated span; it adjusts to the real
   distance as they resolve).
   **● Record** captures a stretch of real interaction until ESC, as one
   `record` step. The preview replays a take's scroll, traces the pointer
   with a cursor dot (filled while the button is held), emulates hover under
   it, and fires its clicks the same synthetic way — so a recorded click that
   routes client-side routes in the preview too. Recorded **drags** replay
   synthetically as well: pointer-listener drags get per-tick moves with the
   button held (aimed at the capturing element if the page grabbed the
   pointer), and a `draggable="true"` source gets the native HTML5 sequence —
   dragstart, dragenter/dragover along the path, drop where it was accepted,
   dragend. Libraries that insist on `isTrusted` input only respond in the
   render, where the drag is real. Clicking through a link to a **new
   document** mid-recording splits the take automatically — `record` →
   `click` → `record` — and recording resumes on the destination once it
   loads.
5. Steps collapse to one line — selector, quality, a drawn easing curve, and
   the seconds the step occupies. Drag the ⠿ grip to reorder (the start step
   stays pinned first). Click a row to open its editor
   (align / offset / duration / ease / hold, reorder, ⌖ jump-to-element).
6. The **duration ruler** above the steps shows the whole timeline to scale —
   moves solid, holds striped, interactions as markers — so pacing problems are
   visible before playing. It doubles as the scrubber: drag it to seek.
   **▶ Preview** plays in real time with the same easing math the renderer uses.
7. **Export** downloads the JSON (render it: `tapeworm that-file.json`) —
   or **Copy command** puts a fully self-contained render command on the
   clipboard, config embedded via a stdin heredoc (`tapeworm -`). Paste it into
   a terminal at the tapeworm repo; no exported file needed. Copy JSON and
   **Start over** live behind the ⋯ menu.
   With the **localStorage** box in setup ticked, every export also snapshots
   the page's localStorage into `page.localStorage`, and the render seeds it
   back before the page's scripts run — so state the page keeps there
   (consent choices, intro-seen flags, themes) films the way you authored it
   instead of resetting in the render's pristine profile. The snapshot is
   taken at export time from the page as it stands, and skipped if the tab
   has navigated off the timeline's origin. It's off by default because the
   snapshot is verbatim: it may contain session tokens, so only export
   configs you'd be happy to share.
8. **Export assets** (⋯ menu) downloads `<hostname>.assets.json` — a record of
   every URL the current page has fetched (via Resource Timing, so no extra
   permissions), biggest first, with request counts and bytes where the server
   allows measuring them (`bytes: null` means cross-origin without
   `Timing-Allow-Origin`). It's the reference list for writing
   `page.substitute` rules in the config. Warm up first so lazy-loaded media
   makes the list; the record is per-document (a reload starts it over) and
   top-frame only — iframe embeds keep their own timelines.
9. **🗂 Saves** (footer): snapshot the current timeline into a library and
   load past ones back — the current site's saves listed first, everything
   else behind an "other sites" divider. Saves are immutable snapshots
   (loading copies one into the working timeline; saving again makes a new
   entry), stored in `chrome.storage.local`, so they survive browser
   restarts, extension reloads and updates — only uninstalling clears them
   (and the pinned manifest key keeps the storage stable across re-clones,
   see above). The working timeline is also autosaved per site: opening the
   panel with an empty timeline on a site you've authored on restores where
   you left off. **Start over…** clears the timeline *and* the site's
   autosave — the library is untouched.

If the page is scroll-gated (the overlay will say so), scroll through the intro
by hand once to unlock it, then author. The renderer unlocks it automatically at
capture time.

## Layout

```
manifest.json        MV3: activeTab, scripting, storage, sidePanel — plus
                     debugger, used only to emulate viewports no window can
                     reach (Chrome forbids debugger as an optional permission,
                     so it can't be requested on demand)
background.js        injects on action click, opens the side panel
icons/               the 🪱 emoji rendered to PNG at 16/32/48/128 (Apple Color
                     Emoji rasterized via a one-off AppKit script)
content/overlay.js   picker, preview, viewport badge (author mode only — the
                     extension shows that state in the panel's chip instead) —
                     chrome-free; `tapeworm author` injects this same file
                     over CDP
content/bridge.js    the only content file that touches chrome.*
sidepanel/           the editor (working state in chrome.storage.session;
                     saves library + per-site autosave in chrome.storage.local)
shared/              byte-identical copies of src/shared/*.js — the same
                     selector, anchor, and easing code the renderer runs
```
