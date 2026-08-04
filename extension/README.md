# tapeworm author — Chrome extension

Author tapeworm timelines visually: pick keyframes by clicking elements, set
timing and easing in the side panel, preview the motion in real time, export a
config the renderer runs unchanged.

## Load it

1. `npm run sync-shared` in the repo root (copies `src/shared/*.js` here —
   `npm test` fails if the copies are stale).
2. `chrome://extensions` → Developer mode → **Load unpacked** → pick this
   `extension/` directory. Chrome 114+.

## Use it

1. Open the page you want to film and click the tapeworm toolbar action. This
   injects the overlay into the current tab (that's the `activeTab` permission —
   the extension has no standing access to any site) and opens the side panel.
2. Set the render viewport (or pick a preset) and hit **Fit window**: the
   browser window resizes until the page viewport exactly matches. The render
   always captures the full viewport at that size, and breakpoints mean a page
   in a bigger window is a *different* page — so author at the real size. The
   on-page badge shows ✓ when the viewport matches, a warning when it doesn't.
3. **⟳ Prepare page**: it steps through the whole page like the renderer's
   pre-warm, so lazy images load and scroll reveals fire before you pick.
4. **＋ Pick element**, then click things on the page. Each keyframe shows its
   generated selector and a quality grade — `structural` is flagged as fragile.
5. Adjust align / offset / duration / ease / hold per keyframe; add holds;
   reorder; click a keyframe's selector to jump the page to it.
6. **▶ Preview** plays the timeline in real time with the same easing math the
   renderer uses; the scrub bar seeks.
7. **Export config** downloads the JSON. Render it: `tapeworm that-file.json`.

If the page is scroll-gated (the overlay will say so), scroll through the intro
by hand once to unlock it, then author. The renderer unlocks it automatically at
capture time.

## Layout

```
manifest.json        MV3: activeTab, scripting, storage, sidePanel — nothing else
background.js        injects on action click, opens the side panel
content/overlay.js   viewport badge, picker, preview — chrome-free; `tapeworm
                     author` injects this same file over CDP
content/bridge.js    the only content file that touches chrome.*
sidepanel/           the editor (state in chrome.storage.session)
shared/              byte-identical copies of src/shared/*.js — the same
                     selector, anchor, and easing code the renderer runs
```
