# Visual timeline authoring for tapeworm

**Status:** Phase 0 complete and verified (commit `61f324a`). Phase 1 built
(extension + `tapeworm author` pulled forward), verified headlessly end-to-end;
human pass on the headful/extension UX still to do. Phase 2 remainder
(`preview --watch`, `--draft`) and Phase 3 outstanding.

**Finding from the Phase 1 drift check (2026-08-04):** the first automated
pick-export-dryrun round trip caught a 40px anchor mismatch — not a selector
bug, but *page state*: an un-prewarmed page holds elements where their un-fired
reveal transforms put them (`translateY(40px)` before the IntersectionObserver
adds `.on`), positions the render never sees. Consequence, now implemented:
`tapeworm author` runs the same `prewarm()` as the render before anything
resolves, and the extension overlay grew a "prepare page" sweep that mimics it
with `setScroll` stepping. Drift lives in page state as much as in code — the
shared core alone would not have caught this.

> An earlier version of this plan marked Phase 0 done, but that work was never
> committed — no branch, stash, or worktree had it. It was rebuilt from this
> document on 2026-08-04 and re-verified (256-frame render byte-identical
> before/after, against a baseline first confirmed deterministic across runs).

## Repo layout: one package, no monorepo

Decided 2026-08-04. The shared core is dependency-free plain JS installing
globals — it needs no module system, so nothing here needs workspaces, separate
versioning, or a build step (which CLAUDE.md forbids anyway). The extension is a
top-level `extension/` directory in this repo, excluded from the npm `files`
array. Chrome content scripts must be real files inside the extension directory
(symlinks don't survive unpacked loading or Web Store packaging), so:

- `npm run sync-shared` — a trivial Node script copying `src/shared/*.js` →
  `extension/shared/`.
- A test asserts **byte-equality** between the two locations, so renderer ↔
  extension drift is a failing `npm test`, not something anyone remembers.

The one future event that would justify restructuring is the hosted render
service — a real second deployable — and even that can be its own repo consuming
exported configs. Don't restructure for it now.

**Sequencing note:** `tapeworm author` (Phase 2) is pulled forward into Phase 1
— it's the drift tiebreaker, needed *while* building the extension, and cheap
(`launch()` already takes `extraArgs`; the overlay files are shared). After the
Phase 1 drift check (extension preview screenshot vs. headless render of the
same keyframe), stop and evaluate: if framing disagrees beyond tolerance, fix
the shared core / camera-frame math before investing in side-panel polish.

## Context

`tapeworm` renders website scrollthroughs from a JSON config. Authoring that config today means hand-writing CSS selectors, guessing durations and holds, and running `--dry-run` to see whether the anchors resolved — then rendering to find out whether the framing and pacing are any good. That loop is minutes long and requires a terminal.

The goal is a visual authoring tool that designers and marketing can use without a terminal: pick keyframes by clicking elements, set timing and easing, preview the motion in real time, export a config. Interactions (clicking buttons mid-timeline) are wanted eventually but not in v1 — however the timeline format must accommodate them **now**, so configs authored by designers don't break when interactions land.

Handoff is JSON export for now, with a hosted render service as a later possibility. Distribution is undecided, so the extension must stay review-friendly (minimal permissions) to keep the Web Store route open.

**The central risk is drift.** The extension authors in the designer's ordinary Chrome — their window size, their DPR, no injected runtime, no compositor flags. The renderer runs headless with a fixed viewport and a specific flag set. If the two disagree about where an anchor lands, the tool actively misleads. Most of the design below exists to close that gap.

---

## Phase 0 — Timeline format v2 and a shared core ✅ done

No UI. The foundation both the renderer and the extension stand on, and the phase that makes interactions a non-breaking addition later.

### Discriminated step union (`src/types.ts`)

`Segment` had five optional fields and no discriminant, so there was no room to express "click this button". Added:

```ts
export type Step =
  | { type: 'start'; at: Anchor; hold?: number }
  | { type: 'move'; to: Anchor; duration?: number; ease?: Ease; hold?: number }
  | { type: 'hold'; seconds: number }
  // Defined now, rejected with a clear message until Phase 3:
  | { type: 'click'; target: Anchor; settle?: number }
  | { type: 'hover'; target: Anchor; settle?: number }
  | { type: 'wait'; forSelector?: string; seconds?: number };
```

The key stays `timeline`, and entries may be **either** a legacy `Segment` (no `type`) or a `Step`, mixed freely. `resolveConfig` normalises to `Step[]`. No new top-level key, no migration, existing configs untouched. `Resolved.timeline` is `Step[]`, so `buildTrack` only ever sees the normalised form.

`Anchor` gained an optional `fallbackText` — never used to find the element, only to turn "selector matched nothing" into a message saying whether the content is gone or just re-marked-up.

### Track carries actions (`src/timeline.ts`)

```ts
export type Track = {
  offsets: number[];
  actions: Array<{ frame: number; step: Step }>;  // empty until Phase 3
  sequential: boolean;                            // actions.length > 0
  plan: string[];
};
```

`sequential` is the hook Phase 3 uses to force `jobs: 1`. The precedent already exists in `config.ts`, where `prewarm.mode` of `cache`/`none` forces serial rendering for the same reason: path-dependent state can't be sharded.

`buildTrack` now also handles `hold` steps as first-class, and the dead `rest`/`tail` branch is gone.

### The shared core — the anti-drift lever

The extension must resolve anchors and evaluate easings **identically** to the renderer, or the picker lies. Anchor resolution lived inside the template literal in `runtimeSource()`, and easing lived in `src/easing.ts` — two places an extension cannot import from.

Three dependency-free plain-JS files, no imports, no exports, each installing one global:

| File | Installs | Contains |
|---|---|---|
| `src/shared/easing-core.js` | `TapewormEasing` | `cubicBezier`, `NAMED`, `peakSlope`, `autoDuration`, `strobeThreshold`, `MAX_PEAK_VH_PER_SEC` |
| `src/shared/anchor-core.js` | `TapewormAnchors` | `resolveAnchor`, `discoverSections`, `maxScroll`, `setScroll`, `visibleRect` |
| `src/shared/selector.js` | `TapewormSelector` | `bestSelector`, `checkSelector` |

Three consumers, one implementation:

1. `runtimeSource()` concatenates them ahead of the payload via `readFileSync(new URL('./shared/…', import.meta.url))`. No build step — and because they're concatenated rather than pasted into the template literal, these files may contain backticks and `${}` freely, which the payload itself cannot.
2. `src/easing.ts` is now a thin typed re-export, so Node-side callers are unchanged.
3. The extension will ship the same files verbatim as content scripts.

### Selector generation (`src/shared/selector.js`)

Where visual pickers usually rot. Ranking, in order:

1. `#id`, but only if it looks authored — rejects hashes, React `:r1a:`, `radix-`, styled-components `sc-`
2. `[data-testid]`, `[data-test]`, `[data-section]`, `[data-scroll]`, `[data-id]`
3. tag + stable class combo, with hashed and awkward classes filtered out, narrowed to the fewest classes that stay unique
4. short structural path with `:nth-of-type`

Returns `{ selector, nth, unique, quality, fallbackText }`. `quality` is `id | data | class | structural`; the UI should warn on `structural`, which is the one most likely to break on a redesign. `checkSelector()` validates hand-edits live.

Measured against the class names real builds produce:

| Input | Output |
|---|---|
| `#features` | `#features` (id) |
| `css-1x2y3z sc-aBcDeF` + id `r1a2b3c4d5e6` | falls through to structural — hashes correctly refused |
| `text-size-[clamp(64px,4.5vw+1rem,128px)] lg:whitespace-normal` | `div.flex-column` |
| `Header_nav__aBc12 nav-primary` | `div.nav-primary` |

The Tailwind case is taken from djernesbell.com's actual markup.

### Verification (done)

- Sticky and scroll-gated configs rendered to PNG sequences before and after: **194 frames, byte-identical checksums**.
- `peakSlope` table unchanged after extraction: `inOutCubic 2.857`, `inOutQuint 5.8779`, `outCubic 3.024`.
- All five example configs still parse and normalise.
- Re-verified after the `scrollrec` → `tapeworm` rename: still byte-identical.

### Deviations from the original plan

- `Step` is ordered with `start` first rather than `move`. Cosmetic.
- `describeMiss` (the `fallbackText` error message) lives in `anchor-core.js` rather than the selector module, since that's where the failure actually occurs.

---

## Phase 1 — The extension (v1: keyframes, timing, preview, export)

MV3, structured to keep the Web Store route open: `activeTab`, `scripting`, `storage`, `sidePanel`. **No host permissions up front** — the content script is injected on demand when the user clicks the action, with `optional_host_permissions` requested only if persistent access proves necessary.

- **Side panel** (`chrome.sidePanel`, Chrome 114+) — the editor: viewport/fps settings, keyframe list with per-step duration / easing / hold, reorder, export. A side panel doesn't fight page CSS and survives scrolling.
- **Content script** — the overlay, mounted in a **Shadow DOM** host (`position: fixed`, max z-index, `isolation: isolate`) so page CSS can't reach it:
  - ~~**Camera frame**: a letterboxed rectangle matching the configured render viewport.~~ **Superseded (2026-08-04):** the render always captures the full viewport at the configured size, and breakpoints mean a page laid out in a bigger window is a *different* page — a scaled frame inside the wrong-sized window shows the wrong layout, not just the wrong crop. Instead: **Fit window** (with viewport presets) resizes the browser window until the page viewport equals the render viewport, and an on-page badge reports match/mismatch honestly. `tapeworm author` gets this for free via viewport emulation.
  - **Picker**: hover highlight + live selector preview from `TapewormSelector.bestSelector`, click to add a keyframe.
  - **Preview**: rAF loop driving `TapewormAnchors.setScroll` through `TapewormEasing` at real time, plus a scrub slider and click-to-jump per keyframe.
- **Export**: a full `Config` plus a `meta` block (`authoredWith`, `authoredAt`, `authoredViewport`, `url`) — useful for diagnosing drift, and the natural payload for a hosted service later.
- State in `chrome.storage.session` (MV3 service workers get evicted).

### Known limitation to surface in the UI, not hide

A content script **cannot dispatch trusted input events**. On scroll-gated sites — djernesbell.com being exactly one — the page is unscrollable until real wheel input arrives, and the extension can't produce it. Detect `maxScroll() === 0` and say so plainly: *"This page gates scrolling behind an intro. Scroll down manually to unlock it, then add keyframes."* The renderer already handles this automatically via CDP (`unlockScroll` in `src/page.ts`) — only authoring needs the human.

### Verification

Load unpacked; author a three-keyframe timeline against the local test site and against djernesbell.com; export; run the exported config through `--dry-run` and assert the resolved offsets match what the extension displayed. Then the drift check that matters: screenshot the extension's preview at a keyframe, render that same keyframe headless, compare framing.

---

## Phase 2 — CLI parity and a fast loop

- **`tapeworm author <url>`** — headful Chrome with the render's exact flags, viewport and injected runtime, hosting the *same* overlay files. The WYSIWYG reference: when the extension and the renderer disagree, this says which is right.
- **`tapeworm preview config.json --watch`** — reload and re-frame on save, for people who'd rather edit JSON.
- **`--draft`** — DPR 1, 30fps, `-preset ultrafast`. Preview shows intent; a draft render shows truth (DPR, video seeking, prewarm behaviour) in seconds instead of minutes.

`launch()` already accepts `extraArgs` with no caller — author mode is its first user.

---

## Phase 3 — Interactions

**Status: done for click/hover (2026-08-04).** Executed via CDP
`Input.dispatchMouseEvent` in `render.ts` (`performAction`), aimed by
`__sr.actionPoint` at dispatch time; `Track.actions` populated, `sequential`
set, `jobs` forced to 1 in `resolveConfig`; extension arm-modes shipped.
Verified on the local test page: a click handler gated on `event.isTrusted`
fired (synthetic clicks can't), and `:hover` styling appeared in the frames —
compared against a no-interaction control render at identical frame indices.
Still open: `wait` steps (format-only), and the optional drawn cursor.

Format landed in Phase 0, so this is execution only:

- Execute `click` / `hover` via CDP `Input.dispatchMouseEvent` at the element's current viewport position. Real input, not `el.click()` — synthetic DOM clicks don't produce hover/active states and many libraries ignore them. `unlockScroll` in `src/page.ts` is the existing template.
- Populate `Track.actions`, set `sequential`, and force `jobs: 1` in `resolveConfig` exactly as `prewarm.mode` already does.
- The animation birth-time machinery in `src/runtime.ts` already handles whatever the click animates — a menu opening over 300ms starts at the right frame and eases correctly.
- Optional: a drawn cursor, since a click nobody can see reads as a glitch.
- Extension: an "arm interaction" mode that records the next click as a step.

---

## Files

| File | Change | Status |
|---|---|---|
| `src/types.ts` | `Step` union; `Resolved.timeline: Step[]`; `Anchor.fallbackText` | done |
| `src/config.ts` | `normaliseTimeline`; reject Phase-3 steps with a clear message | done |
| `src/timeline.ts` | Iterate `Step[]`; `Track.actions` + `sequential`; `hold` steps | done |
| `src/runtime.ts` | Concatenate the shared core instead of defining anchors inline | done |
| `src/easing.ts` | Typed re-export of `shared/easing-core.js` | done |
| `src/shared/*.js` | `easing-core.js`, `anchor-core.js`, `selector.js` | done |
| `extension/*` | `manifest.json`, side panel, content-script overlay | Phase 1 |
| `bin/tapeworm.ts` | `author`, `preview`, `--draft` | Phase 2 |

## Risks

- **Drift** is mitigated by the shared core, viewport fitting, and the prepare/prewarm parity, not eliminated. `tapeworm author` is the tiebreaker; `--draft` is the cheap confirmation.
- **Scroll-gated and scroll-hijacking sites** can't be authored without manual unlocking (untrusted events). Surfaced in the UI.
- **MV3 service worker eviction** — no state in the worker.
- **Web Store review** if that route is taken: permissions kept minimal specifically to survive it.
