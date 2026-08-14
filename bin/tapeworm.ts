#!/usr/bin/env node
/**
 * tapeworm — record a website scrollthrough as video.
 *
 *   tapeworm site.json
 *   tapeworm https://example.com --out demo.mp4
 */

import { readFileSync, statSync, watch as watchFile } from 'node:fs';
import { createInterface } from 'node:readline';
import { relative } from 'node:path';
import { findChrome, isHeadlessShell } from '../src/browser.ts';
import { loadConfig, parseConfig, parseFrameAt, resolveConfig } from '../src/config.ts';
import { checkFfmpeg } from '../src/encode.ts';
import { openFrameServer, render } from '../src/render.ts';
import type { Config, FrameAccuracy, Resolved, VideoMode } from '../src/types.ts';

const HELP = `tapeworm — record a website scrollthrough as video

USAGE
  tapeworm <config.json> [options]
  tapeworm <url> [options]              # auto-discovers sections
  tapeworm - [options]                  # read the config from stdin
  tapeworm author <url|config.json> [--out config.json]
                                        # visual authoring: headful Chrome with the
                                        # render's exact viewport + runtime; click
                                        # elements to build a timeline, export JSON

OPTIONS
  -o, --out <path>       output file; extension picks the codec
                         .mp4 = H.264 CRF 12 yuv444p, .mov = ProRes 4444,
                         .png = lossless frame sequence (--out names a directory)
      --fps <n>          default 60
      --width <px>       CSS pixels, default 1280
      --height <px>      CSS pixels, default 800
      --dpr <n>          device pixel ratio, default 2 (use 2 or 3, never fractional)
      --codec <c>        h264 | prores | png; normally inferred from --out
      --crf <n>          H.264 quality, lower is better, default 12
      --frame <t>        sample ONE frame of the timeline as a single PNG
                         instead of rendering the video: seconds in (2.5),
                         or a percent ("50%"; "100%" = the last frame).
                         --out names the .png file, default frame.png
      --frame-accuracy <a>  how faithful the sample must be when the timeline
                         is path-dependent (interactions, recordings):
                         exact   = walk every frame before it (the default;
                                   pixel-identical to a full render)
                         segment = restart at the last full-page navigation
                                   at or before it, skipping everything on
                                   earlier documents
                         jump    = also step the walk on the virtual clock
                                   alone and replay only recorded clicks,
                                   not pointer movement; fastest, loosest
      --watch            with --frame: keep the browser and plan alive after
                         the sample. Type a new time/percent + enter to
                         re-render it; saving the config file re-plans.
  -j, --jobs <n>         parallel browsers, default min(4, cores-1)
      --auto             discover sections instead of using the config timeline
      --sections <n>     how many sections --auto should visit, default 6
      --video <mode>     sync | freeze | ignore, default sync
      --embeds <mode>    sync | freeze | ignore for YouTube/Vimeo iframes,
                         default: follows --video
      --clock <mode>     virtual | real, default virtual
      --seed-random[=n]  stub Math.random with a seeded PRNG so a randomised
                         page films the same every run; n = integer seed,
                         default 42. Off unless given.
      --cursor <c>       replace the drawn gesture cursor. "auto" draws the
                         bundled macOS set, switching per frame with the CSS
                         cursor under the pointer (arrow, pointing hand over
                         links, open/closed hand across a grab, zoom, ...).
                         "dot" draws the preview-style touch disc, centred on
                         the point and blue while pressed — reads as a
                         fingertip for touch-style demos. Or one sprite of
                         your own: an image file or an https/data: URL,
                         pointer tip at its top-left corner. "none" hides it.
      --cursor-size <px> rendered cursor width in CSS px. For auto, the
                         arrow's width — the other cursors keep macOS's
                         relative proportions. For dot, its diameter.
                         Config page.cursor also sets an image sprite's
                         tip point.
      --cursor-fade <s>  fade the drawn cursor in/out over this many seconds
                         where it appears and disappears, default 0 (no fade)
      --prewarm <mode>   full | cache | none, default full
                         full  = load everything first, then film a clean pass
                         cache = warm the cache, reload, film reveals as they happen
                         none  = film a cold page
      --reveals          shorthand for --prewarm cache
      --image-budget <ms>  longest a frame waits for a loading image
      --settle <ms>      wait this long after load before doing anything
      --wait-for-intro <ms>  max wait for intro/preloader animations, default 8000
      --replay-intro     rewind the intro so it plays on camera instead
      --no-unlock-intro  don't wheel through a scroll-gated intro
      --headful          show the browser window
      --chrome-path <p>  path to a Chrome binary
      --dry-run          print the plan and exit without rendering
  -h, --help

EXAMPLES
  tapeworm https://stripe.com --out stripe.mp4
  tapeworm site.json --dpr 3 --out master.mov
  tapeworm site.json --dry-run
  tapeworm https://example.com --reveals --out reveals.mp4
  tapeworm site.json --frame 50% --out peek.png
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const takesValue = new Set([
    'out', 'o', 'fps', 'width', 'height', 'dpr', 'crf', 'frame', 'frame-accuracy', 'jobs', 'j',
    'sections', 'video', 'embeds', 'clock', 'cursor', 'cursor-size', 'cursor-fade', 'settle', 'chrome-path', 'codec', 'prewarm', 'image-budget', 'wait-for-intro',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-') || a === '-') { positional.push(a); continue; }
    const name = a.replace(/^--?/, '');
    if (name.includes('=')) {
      const [k, v] = name.split(/=(.*)/s);
      flags[k] = v;
    } else if (takesValue.has(name)) {
      const v = argv[++i];
      if (v === undefined) fail(`--${name} needs a value`);
      flags[name] = v;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function fail(msg: string): never {
  process.stderr.write(`\ntapeworm: ${msg}\n\n`);
  process.exit(1);
}

function num(flags: Flags, ...names: string[]): number | undefined {
  for (const n of names) {
    if (flags[n] === undefined) continue;
    const v = Number(flags[n]);
    if (!Number.isFinite(v)) fail(`--${n} must be a number, got "${flags[n]}"`);
    return v;
  }
  return undefined;
}

function str(flags: Flags, ...names: string[]): string | undefined {
  for (const n of names) if (typeof flags[n] === 'string') return flags[n] as string;
  return undefined;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function bar(done: number, total: number, width = 28): string {
  const filled = Math.round((done / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * --watch: keep the browser and the built plan alive after a --frame sample.
 * stdin lines retarget the sample ("3.2", "75%") and re-render it into the
 * same PNG; saving the config file tears down and re-plans. Runs until Ctrl-C.
 */
async function watchFrames(
  cfg: Resolved,
  chrome: string,
  io: {
    configFile: string | null;
    applyOverrides: (c: Config) => Config;
    printPlan: (plan: string[], track: { offsets: unknown[] }, notes: string[]) => void;
    rel: (p: string) => string;
  },
): Promise<void> {
  let current = cfg;
  const server = await openFrameServer(cfg, chrome, {
    onPlan: (plan, track, notes) => io.printPlan(plan, track, notes),
    onNote: (n) => process.stdout.write(`  · ${n}\n`),
  }).catch((e) => fail((e as Error).message));

  let lastSpec: { sec?: number; pct?: number } = current.frame!;
  // Renders and reloads share one browser — run them strictly in turn. Nothing
  // here rejects (each job reports its own errors), so the chain never breaks.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => { queue = queue.then(fn); };

  const show = (spec: { sec?: number; pct?: number }): void => enqueue(async () => {
    lastSpec = spec;
    try {
      const r = await server.render(spec);
      process.stdout.write(
        `  → ${io.rel(current.outPath)}  (frame ${r.index} of ${r.total}, ${(r.index / current.fps).toFixed(2)}s — ${r.seconds.toFixed(1)}s)\n`,
      );
    } catch (e) {
      process.stdout.write(`  ✗ ${(e as Error).message}\n`);
    }
  });

  show(lastSpec);
  enqueue(async () => {
    process.stdout.write(
      `\n  watching — type a frame target (3.2 or 75%) and press enter to re-render` +
        (io.configFile ? `; saving ${io.configFile} re-plans` : '') +
        `. Ctrl-C or Ctrl-D quits.\n\n`,
    );
  });

  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => {
    // Ctrl-D, or the end of a piped script — finish queued renders, then leave
    enqueue(async () => {
      server.close();
      process.exit(0);
    });
  });
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    let spec: { sec?: number; pct?: number };
    try {
      spec = parseFrameAt(raw);
    } catch (e) {
      process.stdout.write(`  ✗ ${(e as Error).message}\n`);
      return;
    }
    show(spec);
  });

  if (io.configFile) {
    const path = io.configFile;
    let timer: ReturnType<typeof setTimeout> | null = null;
    watchFile(path, () => {
      // debounced — editors fire several events per save
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => enqueue(async () => {
        process.stdout.write(`\n  ${path} changed — re-planning\n\n`);
        let next: Resolved;
        try {
          next = resolveConfig(io.applyOverrides(loadConfig(path)));
        } catch (e) {
          process.stdout.write(`  ✗ ${(e as Error).message}\n`);
          return;
        }
        try {
          await server.reload(next);
        } catch (e) {
          process.stdout.write(`  ✗ ${(e as Error).message}\n`);
          return;
        }
        current = next;
        show(next.frame ?? lastSpec);
      }), 300);
    });
  }

  await new Promise(() => {}); // hold the process open until Ctrl-C
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(positional.length === 0 && !flags.help && !flags.h ? 1 : 0);
  }

  const authorMode = positional[0] === 'author';
  const target = positional[authorMode ? 1 : 0];
  if (authorMode && !target) fail('author needs a URL or config file: tapeworm author <url>');
  let config: Config;
  if (looksLikeUrl(target)) {
    config = { url: target, auto: true };
  } else if (target === '-') {
    // config on stdin — what the extension's "Copy command" heredoc uses
    if (authorMode) fail('author mode needs its stdin for keyboard control; pass a file or URL instead of -');
    let raw = '';
    try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
    if (!raw.trim()) fail('expected a config on stdin (tapeworm - < config.json)');
    config = parseConfig(raw, 'stdin');
  } else {
    let isFile = false;
    try { isFile = statSync(target).isFile(); } catch { isFile = false; }
    if (!isFile) fail(`"${target}" is neither a URL nor a readable file`);
    config = loadConfig(target);
  }

  // CLI overrides config — as a function so --watch can re-apply the same
  // flags when the config file changes on disk.
  const applyOverrides = (config: Config): Config => {
    const width = num(flags, 'width');
    const height = num(flags, 'height');
    const dpr = num(flags, 'dpr');
    if (width || height || dpr) {
      config.viewport = {
        ...config.viewport,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(dpr ? { dpr } : {}),
      };
    }
    const fps = num(flags, 'fps');
    if (fps) config.fps = fps;

    const out = str(flags, 'out', 'o');
    const crf = num(flags, 'crf');
    const codec = str(flags, 'codec');
    if (codec && !['h264', 'prores', 'png'].includes(codec)) fail('--codec must be h264, prores or png');
    if (out || crf !== undefined || codec) {
      config.output = {
        ...config.output,
        ...(out ? { path: out } : {}),
        ...(crf !== undefined ? { crf } : {}),
        ...(codec ? { codec: codec as 'h264' | 'prores' | 'png' } : {}),
      };
    }

    // Raw string on purpose: "2.5" and "50%" both parse in resolveConfig, so the
    // CLI and the config key share one validator and one set of error messages.
    const frame = str(flags, 'frame');
    if (frame !== undefined) {
      // a config already carrying { at, accuracy } keeps its accuracy
      config.frame = typeof config.frame === 'object' && config.frame !== null ? { ...config.frame, at: frame } : frame;
    }
    const frameAccuracy = str(flags, 'frame-accuracy');
    if (frameAccuracy !== undefined) {
      if (!['exact', 'segment', 'jump'].includes(frameAccuracy)) fail('--frame-accuracy must be exact, segment or jump');
      const at = typeof config.frame === 'object' && config.frame !== null ? config.frame.at : config.frame;
      if (at === undefined) fail('--frame-accuracy needs a frame to sample — pass --frame, or set "frame" in the config');
      config.frame = { at, accuracy: frameAccuracy as FrameAccuracy };
    }

    const jobs = num(flags, 'jobs', 'j');
    if (jobs) config.jobs = jobs;
    if (flags.auto) config.auto = true;
    const sections = num(flags, 'sections');
    if (sections) config.auto = { maxSections: sections };
    if (flags.headful) config.headful = true;
    const chromePath = str(flags, 'chrome-path');
    if (chromePath) config.chromePath = chromePath;

    const videoMode = str(flags, 'video');
    if (videoMode) {
      if (!['sync', 'freeze', 'ignore'].includes(videoMode)) fail(`--video must be sync, freeze or ignore`);
      config.page = { ...config.page, video: videoMode as VideoMode };
    }
    const embedsMode = str(flags, 'embeds');
    if (embedsMode) {
      if (!['sync', 'freeze', 'ignore'].includes(embedsMode)) fail(`--embeds must be sync, freeze or ignore`);
      config.page = { ...config.page, embeds: embedsMode as VideoMode };
    }
    const clock = str(flags, 'clock');
    if (clock) {
      if (!['virtual', 'real'].includes(clock)) fail('--clock must be virtual or real');
      config.page = { ...config.page, clock: clock as 'virtual' | 'real' };
    }
    // Not in takesValue: bare --seed-random opts in with the default seed, and
    // a specific one rides the = form (--seed-random=7).
    const seedRandom = flags['seed-random'];
    if (seedRandom !== undefined) {
      if (seedRandom !== true && !Number.isInteger(Number(seedRandom))) {
        fail('--seed-random takes an integer seed (--seed-random=7), or none for the default');
      }
      config.page = { ...config.page, seedRandom: seedRandom === true ? true : Number(seedRandom) };
    }
    const cursor = str(flags, 'cursor');
    if (cursor) {
      config.page = {
        ...config.page,
        cursor: cursor === 'none' ? false
          : cursor === 'auto' ? { auto: true }
          : cursor === 'dot' ? { dot: true }
          : { image: cursor },
      };
    }
    const cursorSize = num(flags, 'cursor-size');
    if (cursorSize !== undefined) {
      const cur = config.page?.cursor;
      if (typeof cur !== 'object' || cur === null) {
        fail('--cursor-size needs a sprite to size — pass --cursor <auto, dot, or image>, or set page.cursor in the config');
      }
      config.page = { ...config.page, cursor: { ...cur, size: cursorSize } };
    }
    const cursorFade = num(flags, 'cursor-fade');
    if (cursorFade !== undefined) {
      // Merge with whatever --cursor / the config already chose; a cursor
      // switched off stays off.
      const cur = config.page?.cursor;
      if (cur !== false) {
        config.page = { ...config.page, cursor: { ...(typeof cur === 'object' ? cur : {}), fade: cursorFade } };
      }
    }
    const settle = num(flags, 'settle');
    if (settle !== undefined) config.page = { ...config.page, settle };
    const waitForIntro = num(flags, 'wait-for-intro');
    if (waitForIntro !== undefined) config.page = { ...config.page, waitForIntro };
    if (flags['replay-intro']) config.page = { ...config.page, replayIntro: true };
    if (flags['no-unlock-intro']) config.page = { ...config.page, unlockIntro: false };
    const prewarmMode = str(flags, 'prewarm');
    if (prewarmMode) {
      if (!['full', 'cache', 'none'].includes(prewarmMode)) fail('--prewarm must be full, cache or none');
      config.prewarm = { ...config.prewarm, mode: prewarmMode as 'full' | 'cache' | 'none' };
    }
    if (flags.reveals) config.prewarm = { ...config.prewarm, mode: 'cache' };
    if (flags['no-prewarm']) config.prewarm = { ...config.prewarm, mode: 'none' };
    if (flags['reload-after']) config.prewarm = { ...config.prewarm, mode: 'cache' };
    const imageBudget = num(flags, 'image-budget');
    if (imageBudget !== undefined) config.prewarm = { ...config.prewarm, imageBudget };
    return config;
  };

  let cfg;
  try { cfg = resolveConfig(applyOverrides(config)); } catch (e) { fail((e as Error).message); }

  let chrome: string;
  try { chrome = findChrome(cfg.chromePath); } catch (e) { fail((e as Error).message); }

  if (authorMode) {
    const { author } = await import('../src/author.ts');
    const configOut = str(flags, 'out', 'o') ?? null;
    process.stdout.write(`\n  authoring ${cfg.url}\n  ${cfg.width}×${cfg.height} @${cfg.dpr}x, ${cfg.fps}fps — the render's exact viewport\n\n`);
    try {
      await author(cfg, chrome, configOut, {
        onNote: (n) => process.stdout.write(`  · ${n}\n`),
        onPicked: (step, ev) => {
          if (step.type !== 'move' || typeof step.to !== 'object') return;
          const q = ev.quality === 'structural' ? 'structural — fragile' : ev.quality;
          process.stdout.write(
            `  + move to ${step.to.selector}${step.to.nth ? ` [${step.to.nth}]` : ''} (${q}` +
              `${ev.resolvedY != null ? `, y=${Math.round(ev.resolvedY)}` : ''})\n`,
          );
        },
      });
    } catch (e) {
      fail((e as Error).message);
    }
    process.exit(0);
  }

  if (cfg.codec !== 'png') await checkFfmpeg().catch((e) => fail((e as Error).message));

  const rel = (p: string) => {
    const r = relative(process.cwd(), p);
    return r.startsWith('..') ? p : r;
  };

  process.stdout.write(`\n  ${cfg.url}\n`);
  process.stdout.write(
    `  ${cfg.width}×${cfg.height} @${cfg.dpr}x = ${cfg.width * cfg.dpr}×${cfg.height * cfg.dpr}, ` +
      `${cfg.fps}fps, ${cfg.codec}${cfg.codec === 'h264' ? ` crf ${cfg.crf}` : ''} → ${rel(cfg.outPath)}\n`,
  );
  if (isHeadlessShell(chrome)) {
    process.stdout.write(
      `  note: using chrome-headless-shell — if the page has an mp4 hero video and it\n` +
        `        renders black, this build may lack H.264. Try full Chrome.\n`,
    );
  }
  process.stdout.write('\n');

  let lastLine = 0;
  const dryRun = Boolean(flags['dry-run']);

  const printPlan = (plan: string[], track: { offsets: unknown[] }, notes: string[]): void => {
    for (const line of plan) process.stdout.write(`  ${line}\n`);
    process.stdout.write(
      `\n  ${track.offsets.length} frames (${(track.offsets.length / cfg.fps).toFixed(1)}s)\n`,
    );
    for (const n of notes) process.stdout.write(`  · ${n}\n`);
    process.stdout.write('\n');
    if (dryRun) { process.stdout.write('  --dry-run: stopping here.\n\n'); process.exit(0); }
  };

  if (flags.watch) {
    if (!cfg.frame) fail('--watch needs a frame to sample — pass --frame (or set "frame" in the config)');
    if (target === '-') fail('--watch needs its stdin for retargeting; pass a config file or URL instead of -');
    // the config file (when there is one), so edits to it re-plan in place
    const configFile = looksLikeUrl(target) ? null : target;
    await watchFrames(cfg, chrome, { configFile, applyOverrides, printPlan, rel });
    return; // runs until Ctrl-C
  }

  try {
    const result = await render(cfg, chrome, {
      onPlan(plan, track, notes) {
        printPlan(plan, track, notes);
      },
      onFrame(done, total) {
        const now = Date.now();
        const tty = process.stdout.isTTY;
        // Without a TTY, \r doesn't erase — so log sparse lines instead of spamming.
        if (now - lastLine < (tty ? 80 : 5000) && done < total) return;
        lastLine = now;
        const pct = Math.round((done / total) * 100);
        if (tty) process.stdout.write(`\r  ${bar(done, total)}  ${done}/${total}  ${pct}%   `);
        else process.stdout.write(`  ${done}/${total}  ${pct}%\n`);
      },
      onNote(n) { process.stdout.write(`\n  · ${n}\n`); },
    });

    const fpsOut = result.frames / result.seconds;
    process.stdout.write(
      (process.stdout.isTTY ? `\r  ${bar(1, 1)}  ${result.frames}/${result.frames}  100%   \n` : '') + `\n` +
        `  done in ${result.seconds.toFixed(1)}s (${fpsOut.toFixed(1)} frames/s)\n` +
        `  → ${rel(result.outPath)}\n\n`,
    );
  } catch (e) {
    process.stdout.write('\n');
    fail((e as Error).message);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
