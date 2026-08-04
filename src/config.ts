/** Config parsing, defaults, and validation with useful error messages. */

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { extname, resolve as resolvePath } from 'node:path';
import type { Config, Resolved, Segment, Step, TimelineEntry } from './types.ts';

const CODEC_BY_EXT: Record<string, 'h264' | 'prores' | 'png'> = {
  '.mp4': 'h264',
  '.m4v': 'h264',
  '.mov': 'prores',
  '.png': 'png',
};

export function parseConfig(raw: string, label = 'config'): Config {
  try {
    // tolerate // comments and trailing commas — these are hand-edited files
    const stripped = raw
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as Config;
  } catch (e) {
    throw new Error(`config is not valid JSON (${label}): ${(e as Error).message}`);
  }
}

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read config: ${path}`);
  }
  return parseConfig(raw, path);
}

const STEP_TYPES = ['start', 'move', 'hold', 'click', 'hover', 'wait'] as const;

/** Defined in the format now so authored configs survive, executable later. */
const PHASE3_TYPES = ['click', 'hover', 'wait'] as const;

/**
 * Normalise a timeline to `Step[]`. Entries may be legacy `Segment`s (no `type`)
 * or `Step`s, mixed freely; nothing downstream ever sees the legacy form.
 */
export function normaliseTimeline(entries: TimelineEntry[]): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`timeline[${i}] must be an object`);
    }

    if ('type' in e && e.type !== undefined) {
      if (!STEP_TYPES.includes(e.type as never)) {
        throw new Error(`timeline[${i}]: unknown step type "${e.type}". Known: ${STEP_TYPES.join(', ')}`);
      }
      if (PHASE3_TYPES.includes(e.type as never)) {
        throw new Error(
          `timeline[${i}]: "${e.type}" steps are part of the format but not executable yet — ` +
            `interaction support is coming. This config will work unchanged once it lands.`,
        );
      }
      if (e.type === 'start' && i !== 0) {
        throw new Error(`timeline[${i}]: "start" is only valid as the first entry`);
      }
      if (e.type === 'move' && e.to === undefined) {
        throw new Error(`timeline[${i}]: a "move" step needs a "to"`);
      }
      if (e.type === 'hold' && !(typeof e.seconds === 'number' && Number.isFinite(e.seconds) && e.seconds >= 0)) {
        throw new Error(`timeline[${i}]: a "hold" step needs "seconds" >= 0`);
      }
      if (i === 0 && e.type !== 'start') steps.push({ type: 'start', at: 'top', hold: 0 });
      steps.push(e as Step);
      continue;
    }

    // Legacy segment. The first one only ever provided the starting position;
    // later ones must have a target.
    const seg = e as Segment;
    if (i === 0) {
      steps.push({ type: 'start', at: seg.at ?? seg.to ?? 'top', hold: seg.hold });
    } else {
      if (seg.to === undefined) throw new Error(`timeline[${i}] needs a "to"`);
      steps.push({ type: 'move', to: seg.to, duration: seg.duration, ease: seg.ease, hold: seg.hold });
    }
  }
  return steps;
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

  if (input.timeline !== undefined && !Array.isArray(input.timeline)) {
    throw new Error('"timeline" must be an array');
  }
  const timeline = normaliseTimeline(input.timeline ?? []);

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
