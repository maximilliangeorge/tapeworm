#!/usr/bin/env node
/**
 * scrollrec — record a website scrollthrough as video.
 *
 *   scrollrec site.json
 *   scrollrec https://example.com --out demo.mp4
 */

import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { findChrome, isHeadlessShell } from '../src/browser.ts';
import { loadConfig, resolveConfig } from '../src/config.ts';
import { checkFfmpeg } from '../src/encode.ts';
import { render } from '../src/render.ts';
import type { Config, VideoMode } from '../src/types.ts';

const HELP = `scrollrec — record a website scrollthrough as video

USAGE
  scrollrec <config.json> [options]
  scrollrec <url> [options]              # auto-discovers sections

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
  -j, --jobs <n>         parallel browsers, default min(4, cores-1)
      --auto             discover sections instead of using the config timeline
      --sections <n>     how many sections --auto should visit, default 6
      --video <mode>     sync | freeze | ignore, default sync
      --clock <mode>     virtual | real, default virtual
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
  scrollrec https://stripe.com --out stripe.mp4
  scrollrec site.json --dpr 3 --out master.mov
  scrollrec site.json --dry-run
  scrollrec https://example.com --reveals --out reveals.mp4
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const takesValue = new Set([
    'out', 'o', 'fps', 'width', 'height', 'dpr', 'crf', 'jobs', 'j',
    'sections', 'video', 'clock', 'settle', 'chrome-path', 'codec', 'prewarm', 'image-budget', 'wait-for-intro',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { positional.push(a); continue; }
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
  process.stderr.write(`\nscrollrec: ${msg}\n\n`);
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

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(positional.length === 0 && !flags.help && !flags.h ? 1 : 0);
  }

  const target = positional[0];
  let config: Config;
  if (looksLikeUrl(target)) {
    config = { url: target, auto: true };
  } else {
    let isFile = false;
    try { isFile = statSync(target).isFile(); } catch { isFile = false; }
    if (!isFile) fail(`"${target}" is neither a URL nor a readable file`);
    config = loadConfig(target);
  }

  // CLI overrides config
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
  const clock = str(flags, 'clock');
  if (clock) {
    if (!['virtual', 'real'].includes(clock)) fail('--clock must be virtual or real');
    config.page = { ...config.page, clock: clock as 'virtual' | 'real' };
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

  let cfg;
  try { cfg = resolveConfig(config); } catch (e) { fail((e as Error).message); }

  if (cfg.codec !== 'png') await checkFfmpeg().catch((e) => fail((e as Error).message));

  let chrome: string;
  try { chrome = findChrome(cfg.chromePath); } catch (e) { fail((e as Error).message); }

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

  try {
    const result = await render(cfg, chrome, {
      onPlan(plan, track, notes) {
        for (const line of plan) process.stdout.write(`  ${line}\n`);
        process.stdout.write(
          `\n  ${track.offsets.length} frames (${(track.offsets.length / cfg.fps).toFixed(1)}s)\n`,
        );
        for (const n of notes) process.stdout.write(`  · ${n}\n`);
        process.stdout.write('\n');
        if (dryRun) { process.stdout.write('  --dry-run: stopping here.\n\n'); process.exit(0); }
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
