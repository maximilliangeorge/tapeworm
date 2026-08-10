/** Config parsing, defaults, and validation with useful error messages. */

import { existsSync, readFileSync, statSync } from 'node:fs';
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

const STEP_TYPES = ['start', 'move', 'hold', 'click', 'hover', 'wait', 'record'] as const;

/** Defined in the format now so authored configs survive, executable later. */
const NOT_YET_EXECUTABLE = ['wait'] as const;

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
      if (NOT_YET_EXECUTABLE.includes(e.type as never)) {
        throw new Error(
          `timeline[${i}]: "${e.type}" steps are part of the format but not executable yet — ` +
            `support is coming. This config will work unchanged once it lands.`,
        );
      }
      if (e.type === 'start' && i !== 0) {
        throw new Error(`timeline[${i}]: "start" is only valid as the first entry`);
      }
      if (e.type === 'click' || e.type === 'hover') {
        const t = e.target;
        if (!t || typeof t !== 'object' || typeof (t as { selector?: unknown }).selector !== 'string') {
          throw new Error(
            `timeline[${i}]: a "${e.type}" step needs a "target" element anchor ({ selector: … }) — ` +
              `keywords and raw offsets name positions, not things you can ${e.type}`,
          );
        }
        if (e.settle != null && !(typeof e.settle === 'number' && Number.isFinite(e.settle) && e.settle >= 0)) {
          throw new Error(`timeline[${i}]: "settle" must be seconds >= 0`);
        }
      }
      if (e.type === 'move' && e.to === undefined) {
        throw new Error(`timeline[${i}]: a "move" step needs a "to"`);
      }
      if (e.type === 'hold' && !(typeof e.seconds === 'number' && Number.isFinite(e.seconds) && e.seconds >= 0)) {
        throw new Error(`timeline[${i}]: a "hold" step needs "seconds" >= 0`);
      }
      if (e.type === 'record') validateRecord(e, i);
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

/**
 * A recording is authored data the renderer replays blind, so malformed samples
 * must fail here with the sample index, not as a nonsense frame mid-render.
 */
function validateRecord(e: Step & { type: 'record' }, i: number): void {
  const s = e.samples as { t?: unknown; x?: unknown; y?: unknown; s?: unknown } | undefined;
  const isNums = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!s || !isNums(s.t) || !isNums(s.x) || !isNums(s.y) || !isNums(s.s)) {
    throw new Error(
      `timeline[${i}]: a "record" step needs "samples" with parallel number arrays t, x, y, s`,
    );
  }
  const len = s.t.length;
  if (len < 2) throw new Error(`timeline[${i}]: "record" samples need at least 2 entries (got ${len})`);
  if (s.x.length !== len || s.y.length !== len || s.s.length !== len) {
    throw new Error(
      `timeline[${i}]: "record" sample arrays must be the same length ` +
        `(t=${len}, x=${s.x.length}, y=${s.y.length}, s=${s.s.length})`,
    );
  }
  if (s.t[0] < 0) throw new Error(`timeline[${i}]: "record" samples.t must start at >= 0`);
  for (let n = 1; n < len; n++) {
    if (s.t[n] < s.t[n - 1]) {
      throw new Error(
        `timeline[${i}]: "record" samples.t must be non-decreasing (sample ${n} goes ${s.t[n - 1]} → ${s.t[n]})`,
      );
    }
  }
  const lastT = s.t[len - 1];
  if (e.buttons !== undefined) {
    if (!Array.isArray(e.buttons)) throw new Error(`timeline[${i}]: "record" buttons must be an array`);
    let prevT = -1;
    for (let n = 0; n < e.buttons.length; n++) {
      const b = e.buttons[n] as { t?: unknown; action?: unknown };
      if (!b || typeof b.t !== 'number' || !Number.isFinite(b.t) || (b.action !== 'down' && b.action !== 'up')) {
        throw new Error(`timeline[${i}]: "record" buttons[${n}] must be { t: ms, action: "down" | "up" }`);
      }
      if (b.t < 0 || b.t > lastT) {
        throw new Error(`timeline[${i}]: "record" buttons[${n}].t (${b.t}) is outside the recording (0..${lastT})`);
      }
      if (b.t < prevT) throw new Error(`timeline[${i}]: "record" buttons must be chronological`);
      if (n === 0 && b.action !== 'down') {
        throw new Error(
          `timeline[${i}]: "record" buttons must begin with a "down" — a recording can't start mid-press`,
        );
      }
      prevT = b.t;
    }
  }
  if (e.smoothing !== undefined && typeof e.smoothing !== 'boolean') {
    const sm = e.smoothing as { mode?: unknown; strength?: unknown };
    if (typeof sm !== 'object' || sm === null) {
      throw new Error(`timeline[${i}]: "record" smoothing must be a boolean or { mode?, strength? }`);
    }
    // reject unknown modes so a config authored for a future tapeworm fails
    // loudly here instead of silently rendering with the wrong look
    if (sm.mode !== undefined && sm.mode !== 'denoise') {
      throw new Error(`timeline[${i}]: unknown "record" smoothing mode "${String(sm.mode)}" (this version has: denoise)`);
    }
    if (
      sm.strength !== undefined &&
      (typeof sm.strength !== 'number' || !Number.isFinite(sm.strength) || sm.strength < 0 || sm.strength > 1)
    ) {
      throw new Error(`timeline[${i}]: "record" smoothing strength must be a number from 0 to 1`);
    }
  }
  const v = e.viewport as { width?: unknown; height?: unknown } | undefined;
  const isDim = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!v || !isDim(v.width) || !isDim(v.height)) {
    throw new Error(
      `timeline[${i}]: a "record" step needs the "viewport" it was recorded at ({ width, height }) — ` +
        `the render refuses to replay it at a different size`,
    );
  }
  if (e.hold != null && !(typeof e.hold === 'number' && Number.isFinite(e.hold) && e.hold >= 0)) {
    throw new Error(`timeline[${i}]: "hold" must be seconds >= 0`);
  }
}

/**
 * Local replacements are checked at config time, not when the first request
 * matches mid-render — a typo'd path should fail in seconds, not minutes.
 */
function resolveSubstitute(subs: Array<{ from: string; to: string }> | undefined, pageUrl: string): Resolved['page']['substitute'] {
  if (subs === undefined) return [];
  if (!Array.isArray(subs)) throw new Error('"page.substitute" must be an array of { from, to }');
  return subs.map((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.from !== 'string' || s.from === '' || typeof s.to !== 'string' || s.to === '') {
      throw new Error(`page.substitute[${i}] must be { from: "url pattern", to: "url or file path" }`);
    }
    if (/^https?:\/\//.test(s.to)) {
      // Chrome refuses to rewrite a request from a secure page to an insecure
      // URL (net::ERR_BLOCKED_BY_CLIENT) — that would surface as the asset
      // silently failing to load mid-render. Fail here instead.
      if (pageUrl.startsWith('https:') && s.to.startsWith('http:')) {
        throw new Error(
          `page.substitute[${i}]: an https page can't be given an http:// replacement (${s.to}) — ` +
            `Chrome blocks the downgrade. Use an https URL, or a local file.`,
        );
      }
      return { from: s.from, to: s.to };
    }
    const path = resolvePath(s.to);
    if (!existsSync(path)) throw new Error(`page.substitute[${i}]: replacement file not found: ${path}`);
    if (statSync(path).isDirectory()) throw new Error(`page.substitute[${i}]: replacement is a directory: ${path}`);
    return { from: s.from, to: path };
  });
}

const CURSOR_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** The built-in arrow sprite: tip at (5,3) inside a 22px box (see runtime.ts). */
const BUILTIN_CURSOR = { image: null, tipX: 5, tipY: 3, size: 22 } as const;

/**
 * A replacement cursor image is embedded as a data: URI here, at config time —
 * the page can't read local files, and a typo'd path should fail in seconds,
 * not render an invisible cursor minutes in.
 */
function resolveCursor(
  c: boolean | { image?: unknown; tip?: unknown; size?: unknown } | undefined,
  pageUrl: string,
): Resolved['page']['cursor'] {
  if (c === false) return false;
  if (c === undefined || c === true) return { ...BUILTIN_CURSOR };
  if (typeof c !== 'object' || typeof c.image !== 'string' || c.image === '') {
    throw new Error('"page.cursor" must be true, false, or { image: "path or url", tip?: [x, y], size?: px }');
  }
  const tip = c.tip ?? [0, 0];
  if (
    !Array.isArray(tip) || tip.length !== 2 ||
    !tip.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  ) {
    throw new Error('page.cursor.tip must be [x, y] pixels >= 0 inside the rendered sprite');
  }
  const size = c.size ?? 32;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new Error('page.cursor.size must be the rendered width in CSS px > 0');
  }
  let image = c.image;
  if (/^https?:\/\//.test(image)) {
    // Same downgrade rule as page.substitute: Chrome won't load http on an
    // https page, which would surface as a cursor that silently never appears.
    if (pageUrl.startsWith('https:') && image.startsWith('http:')) {
      throw new Error(
        `page.cursor.image: an https page can't load an http:// image (${image}) — ` +
          `Chrome blocks the downgrade. Use an https URL, a data: URI, or a local file.`,
      );
    }
  } else if (!image.startsWith('data:')) {
    const path = resolvePath(image);
    if (!existsSync(path)) throw new Error(`page.cursor.image: file not found: ${path}`);
    if (statSync(path).isDirectory()) throw new Error(`page.cursor.image: is a directory: ${path}`);
    const mime = CURSOR_MIME[extname(path).toLowerCase()];
    if (!mime) {
      throw new Error(
        `page.cursor.image: can't tell the image type of ${path} — ` +
          `use one of ${Object.keys(CURSOR_MIME).join(', ')}`,
      );
    }
    image = `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  }
  return { image, tipX: tip[0], tipY: tip[1], size };
}

export function resolveConfig(input: Config): Resolved {
  if (input.timeline !== undefined && !Array.isArray(input.timeline)) {
    throw new Error('"timeline" must be an array');
  }
  const timeline = normaliseTimeline(input.timeline ?? []);

  // The URL may live on the start step (authoring tools stamp it there when
  // the first keyframe is created). Both present and disagreeing is a real
  // mistake — the selectors were authored against ONE of them.
  const first = timeline[0];
  const startUrl = first && first.type === 'start' ? first.url : undefined;
  if (input.url && startUrl && input.url !== startUrl) {
    throw new Error(
      `config "url" (${input.url}) and the timeline's start url (${startUrl}) disagree — ` +
        `the selectors were authored against one of them; remove the other`,
    );
  }
  const url = input.url ?? startUrl;
  if (!url || typeof url !== 'string') throw new Error('config needs a "url"');
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`"url" is not a valid URL: ${url}`);
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

  const videoModes = ['sync', 'freeze', 'ignore'];
  const video = input.page?.video ?? 'sync';
  if (!videoModes.includes(video)) {
    throw new Error(`page.video must be sync, freeze or ignore (got "${video}")`);
  }
  const embeds = input.page?.embeds ?? video;
  if (!videoModes.includes(embeds)) {
    throw new Error(`page.embeds must be sync, freeze or ignore (got "${embeds}")`);
  }

  const prewarmMode: 'full' | 'cache' | 'none' =
    input.prewarm?.mode ??
    (input.prewarm?.enabled === false ? 'none' : input.prewarm?.reloadAfter ? 'cache' : 'full');
  if (!['full', 'cache', 'none'].includes(prewarmMode)) {
    throw new Error(`prewarm.mode must be full, cache or none (got "${prewarmMode}")`);
  }

  // A recording's coordinates and scroll offsets only mean anything at the
  // viewport they were captured in — breakpoints make a different size a
  // DIFFERENT page. Scaling would produce a plausible render of the wrong
  // thing, so refuse instead. (Runs here, not in normaliseTimeline, because
  // the resolved viewport doesn't exist there.)
  const width = input.viewport?.width ?? 1280;
  const height = input.viewport?.height ?? 800;
  for (let i = 0; i < timeline.length; i++) {
    const s = timeline[i];
    if (s.type !== 'record') continue;
    if (s.viewport.width !== width || s.viewport.height !== height) {
      throw new Error(
        `timeline[${i}]: this recording was made at ${s.viewport.width}×${s.viewport.height} but the render ` +
          `viewport is ${width}×${height} — a different viewport is a different layout, so the recorded ` +
          `pointer would land on the wrong things. Set viewport to the recorded size, or re-record.`,
      );
    }
  }

  const auto = input.auto
    ? { maxSections: (typeof input.auto === 'object' ? input.auto.maxSections : undefined) ?? 6 }
    : (false as const);

  if (!auto && timeline.length === 0) {
    throw new Error('config needs a "timeline", or "auto": true to discover sections automatically');
  }

  return {
    url,
    width,
    height,
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
      cursor: resolveCursor(input.page?.cursor, url),
      video,
      embeds,
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
      substitute: resolveSubstitute(input.page?.substitute, url),
    },
    // 'cache' and 'none' film reveals as they happen, and reveal state depends on the
    // path taken to get there — a shard that jumps straight to frame 400 would show
    // different reveals than one that scrolled through. So those modes are single-job.
    // Interactions are path-dependent for the same reason: frame N shows whatever the
    // clicks before it did to the page, so an interactive timeline can't shard either.
    // Recordings replay real input (hover states, drags), so they're interactions too.
    jobs: prewarmMode === 'full' && !timeline.some((s) => s.type === 'click' || s.type === 'hover' || s.type === 'record')
      ? (input.jobs ?? Math.max(1, Math.min(4, cpus().length - 1)))
      : 1,
    chromePath: input.chromePath ?? null,
    headful: input.headful ?? false,
  };
}
