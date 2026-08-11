# Bundled macOS cursors

SVG recreations of the macOS pointer set, vendored unmodified from
[sawyerh/cursor.in](https://github.com/sawyerh/cursor.in)
(`gh-pages/assets`, fetched 2026-08-11). The upstream repository declares no
license; the artwork mimics Apple's system cursors. Bundled here for
convenience in rendered scrollthroughs — if that provenance matters for your
use, supply your own sprite via `page.cursor.image` instead.

Drawn by `page.cursor: { "auto": true }` — the render picks a sprite per frame
from the CSS cursor in effect under the pointer (see the README's cursor
section). The set's natural widths and hotspots live in `AUTO_CURSORS` in
`src/config.ts`; the config test walks that table, so a file missing here
fails the suite. `poof` and `jk` are in the set upstream but triggered by no
CSS cursor value, so auto mode never draws them.
