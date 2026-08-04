# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

tapeworm records website scrollthroughs as video by rendering frames one at a time through CDP rather than screen-capturing in real time. TypeScript run directly under Node 22.18+ via type stripping — **no build step, no runtime dependencies** (ffmpeg and Chrome are external binaries). Keep it that way: don't add npm dependencies or a compile step.

## Commands

```bash
npm run typecheck          # tsc --noEmit
npm test                   # node:test suites in test/ — pure logic + the page runtime in a vm; no Chrome/ffmpeg needed
node bin/tapeworm.ts <url-or-config.json> [options]   # run the CLI
node bin/tapeworm.ts <url> --dry-run                  # print the plan without rendering (fast, use for iteration)
```

Useful while debugging: `TAPEWORM_DEBUG=1` shows Chrome's stderr, `--headful` shows the browser window, `TAPEWORM_CHROME`/`--chrome-path` points at a specific Chrome. Example configs live in `examples/`.

tsconfig uses `erasableSyntaxOnly` — no enums, namespaces, or parameter properties; type-only syntax only, so files stay runnable by Node's type stripping.

## Architecture

The core invariant: **every time-dependent thing (scroll, CSS/WAAPI animations, video, JS timers) is seeked from the frame index, never read from the wall clock.** Frame N doesn't depend on frame N−1, which is what makes the frame range shardable across parallel Chrome instances (`--jobs`). Any change that reintroduces wall-clock or previous-frame dependence breaks sharding.

Data flow: `bin/tapeworm.ts` parses args → `config.ts` validates into a `Resolved` (schema in `types.ts`, the source of truth for what's configurable) → `render.ts` launches workers. Each worker: `browser.ts` launches Chrome → `cdp.ts` speaks DevTools protocol over `--remote-debugging-pipe` → `page.ts` opens the page and pre-warms → `timeline.ts` resolves anchors to a per-frame scroll offset array → `render.ts` captures each frame as PNG → `encode.ts` pipes to ffmpeg and concatenates shard segments without re-encoding.

Two halves talk across the CDP boundary:

- **Node side** (`render.ts`, `timeline.ts`, `page.ts`) drives everything by evaluating expressions against the in-page API.
- **Page side** (`runtime.ts`) is a single JS payload, generated as a string by `runtimeSource(cfg)` and injected via `Page.addScriptToEvaluateOnNewDocument` so it runs *before* the page's own scripts — that ordering is what lets it override the clock (`Date.now`, `performance.now`, rAF, timers) the page captures, and hook Lenis at construction time. It exposes `window.__sr` (`frame()`, `resolveAnchor()`, `discoverSections()`, …). It's code-in-a-template-literal, so typos surface at page runtime, not typecheck time.

Details that look wrong but are deliberate:

- `render.ts` treats any scroll discrepancy beyond `1/dpr` px as the page fighting the scroll (`ScrollDrift`) — Chrome stores scroll offsets on the device-pixel grid, so that's the legitimate quantum.
- Scroll-driven animations (`animation-timeline`) are *not* seeked: they're a pure function of scroll offset.
- `prewarm` modes `cache`/`none` force `--jobs 1` because reveal state depends on the scroll path taken, not just position.
- Videos are seeked per frame and awaited via `requestVideoFrameCallback`; each animation gets a "birth time" so mid-render starts don't snap to completion.

The README is unusually thorough on behaviour (intro handling, prewarm modes, easing velocity caps, output codecs, failure modes) — read the relevant section before changing that behaviour, and keep it accurate when you do.
