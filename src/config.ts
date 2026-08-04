/** Config parsing, defaults, and validation with useful error messages. */

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { extname, resolve as resolvePath } from 'node:path';
import type { Config, Resolved } from './types.ts';

const CODEC_BY_EXT: Record<string, 'h264' | 'prores' | 'png'> = {
  '.mp4': 'h264',
  '.m4v': 'h264',
  '.mov': 'prores',
  '.png': 'png',
};

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read config: ${path}`);
  }
  try {
    // tolerate // comments and trailing commas — these are hand-edited files
    const stripped = raw
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as Config;
  } catch (e) {
    throw new Error(`config is not valid JSON (${path}): ${(e as Error).message}`);
  }
}

export function resolveConfig(input: Config): Resolved {
  if (!input.url || typeof input.url !== 'string') throw new Error('config needs a "url"');
  try {
    // eslint-disable-next-line no-new
    new URL(input.url);
  } catch {
    throw new Error(`"url" is not a valid URL: ${input.url}`);
  }

  const dpr = input.viewport?.dpr ?? 2;
  if (!Number.isInteger(dpr) || dpr < 1 || dpr > 4) {
    throw new Error(
      `dpr must be an integer 1-4 (got ${dpr}). Fractional DPRs quantise scroll unevenly and judder.`,
    );
  }

  const fps = input.fps ?? 60;
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new Error(`fps must be 1-240 (got ${fps})`);

  let outPath = resolvePath(input.output?.path ?? 'out.mp4');
  const codec = input.output?.codec ?? CODEC_BY_EXT[extname(outPath).toLowerCase()] ?? 'h264';
  if (codec === 'png') {
    // A frame sequence is a directory, so "frames.png" means "a directory called frames"
    outPath = outPath.replace(/\.png$/i, '');
  } else if (!extname(outPath)) {
    outPath += codec === 'prores' ? '.mov' : '.mp4';
  }

  const prewarmMode: 'full' | 'cache' | 'none' =
    input.prewarm?.mode ??
    (input.prewarm?.enabled === false ? 'none' : input.prewarm?.reloadAfter ? 'cache' : 'full');
  if (!['full', 'cache', 'none'].includes(prewarmMode)) {
    throw new Error(`prewarm.mode must be full, cache or none (got "${prewarmMode}")`);
  }

  const timeline = input.timeline ?? [];
  if (!Array.isArray(timeline)) throw new Error('"timeline" must be an array');

  const auto = input.auto
    ? { maxSections: (typeof input.auto === 'object' ? input.auto.maxSections : undefined) ?? 6 }
    : (false as const);

  if (!auto && timeline.length === 0) {
    throw new Error('config needs a "timeline", or "auto": true to discover sections automatically');
  }

  return {
    url: input.url,
    width: input.viewport?.width ?? 1280,
    height: input.viewport?.height ?? 800,
    dpr,
    fps,
    timeline,
    auto,
    outPath,
    codec,
    crf: input.output?.crf ?? 12,
    prewarm: {
      mode: prewarmMode,
      maxHeight: input.prewarm?.maxHeight ?? 60_000,
      timeout: input.prewarm?.timeout ?? 30_000,
      imageBudget: input.prewarm?.imageBudget ?? (prewarmMode === 'full' ? 400 : 1500),
    },
    page: {
      dismissConsent: input.page?.dismissConsent ?? true,
      hideOverlays: input.page?.hideOverlays ?? true,
      clock: input.page?.clock ?? 'virtual',
      seekAnimations: input.page?.seekAnimations ?? true,
      video: input.page?.video ?? 'sync',
      css: input.page?.css ?? '',
      script: input.page?.script ?? '',
      settle: input.page?.settle ?? 0,
      waitForIntro: input.page?.waitForIntro ?? 8000,
      replayIntro: input.page?.replayIntro ?? false,
      unlockIntro: {
        enabled: input.page?.unlockIntro !== false,
        maxTicks: (typeof input.page?.unlockIntro === 'object' ? input.page.unlockIntro.maxTicks : undefined) ?? 40,
        deltaY: (typeof input.page?.unlockIntro === 'object' ? input.page.unlockIntro.deltaY : undefined) ?? 400,
      },
    },
    // 'cache' and 'none' film reveals as they happen, and reveal state depends on the
    // path taken to get there — a shard that jumps straight to frame 400 would show
    // different reveals than one that scrolled through. So those modes are single-job.
    jobs: prewarmMode === 'full' ? (input.jobs ?? Math.max(1, Math.min(4, cpus().length - 1))) : 1,
    chromePath: input.chromePath ?? null,
    headful: input.headful ?? false,
  };
}
