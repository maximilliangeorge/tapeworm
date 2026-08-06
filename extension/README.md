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
   matches; the chip going red (and the on-page badge) reopens it.
3. **⟳ Warm up** (also in setup): steps through the whole page like the
   renderer's pre-warm, so lazy images load and scroll reveals fire before you
   pick.
4. **＋ Scroll to**, then click things on the page. Each step shows its
   generated selector and a quality grade — `structural` is flagged as fragile.
   **⊕ Click** / **⊙ Hover** arm interaction mode instead: the next element you
   click is recorded as a click or hover step, performed with real trusted
   input during the render. In the preview, hovers are emulated (synthetic
   mouse events plus cloned `:hover` CSS rules — close enough to judge timing
   by; the render is the truth). Clicks are skipped in the preview — no
   trusted input from a content script, and they'd mutate page state that
   scrubbing couldn't undo — but their settle time still counts.
   **● Record** captures a stretch of real interaction until ESC, as one
   `record` step. Clicking through a link mid-recording splits the take
   automatically — `record` → `click` → `record` — and recording resumes on
   the destination once it loads.
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

If the page is scroll-gated (the overlay will say so), scroll through the intro
by hand once to unlock it, then author. The renderer unlocks it automatically at
capture time.

## Layout

```
manifest.json        MV3: activeTab, scripting, storage, sidePanel — nothing else
background.js        injects on action click, opens the side panel
icons/               the 🪱 emoji rendered to PNG at 16/32/48/128 (Apple Color
                     Emoji rasterized via a one-off AppKit script)
content/overlay.js   viewport badge, picker, preview — chrome-free; `tapeworm
                     author` injects this same file over CDP
content/bridge.js    the only content file that touches chrome.*
sidepanel/           the editor (state in chrome.storage.session)
shared/              byte-identical copies of src/shared/*.js — the same
                     selector, anchor, and easing code the renderer runs
```
