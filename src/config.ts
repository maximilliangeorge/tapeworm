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

/**
 * Known keys per config object, mirroring `Config` in types.ts. A misspelled
 * key is worse than a wrong value — the setting it meant to change silently
 * keeps its default, and nothing fails until you notice the render ignored
 * you — so key names are rejected outright. Only NAMES are judged here;
 * shapes and values keep their pointed errors in the resolvers below.
 *
 * Exported (with STEP_KEYS) so the test suite can hold the published JSON
 * Schema (schema/tapeworm.config.schema.json) to the same key lists.
 */
export const KNOWN_KEYS = {
  top: ['$schema', 'url', 'viewport', 'fps', 'timeline', 'auto', 'output', 'prewarm', 'page', 'frame', 'trim', 'jobs', 'chromePath', 'meta', 'headful'],
  viewport: ['width', 'height', 'dpr'],
  auto: ['maxSections'],
  output: ['path', 'codec', 'crf'],
  frame: ['at', 'accuracy'],
  prewarm: ['mode', 'enabled', 'maxHeight', 'timeout', 'reloadAfter', 'imageBudget'],
  page: [
    'dismissConsent', 'hideOverlays', 'clock', 'seekAnimations', 'seedRandom', 'cursor', 'video', 'embeds',
    'css', 'script', 'settle', 'waitForIntro', 'replayIntro', 'unlockIntro', 'substitute',
    'localStorage',
  ],
  cursor: ['auto', 'dot', 'image', 'tip', 'size', 'fade'],
  unlockIntro: ['maxTicks', 'deltaY'],
  substitute: ['from', 'to', 'on'],
  trim: ['start', 'end'],
  anchor: ['selector', 'align', 'offset', 'nth', 'fallbackText'],
  segment: ['to', 'at', 'duration', 'ease', 'hold'],
  samples: ['t', 'x', 'y', 's'],
  button: ['t', 'action'],
  smoothing: ['mode', 'strength'],
} as const;

export const STEP_KEYS: Record<string, readonly string[]> = {
  start: ['type', 'at', 'hold', 'url'],
  move: ['type', 'to', 'duration', 'ease', 'hold'],
  hold: ['type', 'seconds'],
  click: ['type', 'target', 'settle'],
  hover: ['type', 'target', 'settle'],
  wait: ['type', 'forSelector', 'seconds'],
  record: ['type', 'samples', 'buttons', 'viewport', 'smoothing', 'hold'],
};

/** Levenshtein, for "did you mean" — configs are hand-edited files. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length];
}

function unknownKey(key: string, where: string, known: readonly string[]): string {
  const near =
    known.find((k) => k.toLowerCase() === key.toLowerCase()) ??
    known.find((k) => editDistance(k.toLowerCase(), key.toLowerCase()) <= 2);
  const hint = near ? ` — did you mean "${near}"?` : `. Known keys: ${known.join(', ')}`;
  return `unknown key "${key}" in ${where}${hint}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reject every key the schema doesn't know, all at once, each with a guess at
 * the key that was meant. Non-objects where an object belongs are skipped —
 * the resolvers report those with better messages. Two deliberate holes:
 * `meta` is free-form (authoring tools stamp arbitrary provenance there),
 * `page.localStorage` holds the page's own keys, and a step whose `type` is
 * unknown is left for normaliseTimeline to reject by name rather than
 * key-by-key.
 */
function rejectUnknownKeys(input: Config): void {
  const problems: string[] = [];
  const check = (obj: unknown, where: string, known: readonly string[]): void => {
    if (!isPlainObject(obj)) return;
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) problems.push(unknownKey(key, where, known));
    }
  };

  check(input, 'the config (top level)', KNOWN_KEYS.top);
  check(input.viewport, '"viewport"', KNOWN_KEYS.viewport);
  check(input.auto, '"auto"', KNOWN_KEYS.auto);
  check(input.output, '"output"', KNOWN_KEYS.output);
  check(input.frame, '"frame"', KNOWN_KEYS.frame); // scalar forms skip through (check ignores non-objects)
  check(input.prewarm, '"prewarm"', KNOWN_KEYS.prewarm);
  check(input.trim, '"trim"', KNOWN_KEYS.trim);
  if (isPlainObject(input.page)) {
    check(input.page, '"page"', KNOWN_KEYS.page);
    check(input.page.cursor, '"page.cursor"', KNOWN_KEYS.cursor);
    check(input.page.unlockIntro, '"page.unlockIntro"', KNOWN_KEYS.unlockIntro);
    if (Array.isArray(input.page.substitute)) {
      input.page.substitute.forEach((s, i) => check(s, `"page.substitute[${i}]"`, KNOWN_KEYS.substitute));
    }
  }
  if (Array.isArray(input.timeline)) {
    input.timeline.forEach((e, i) => {
      if (!isPlainObject(e)) return;
      const step = e as Record<string, unknown>;
      const hasType = 'type' in step && step.type !== undefined;
      const known = hasType ? STEP_KEYS[step.type as string] : KNOWN_KEYS.segment;
      if (!known) return;
      check(step, `"timeline[${i}]"`, known);
      for (const a of ['to', 'at', 'target'] as const) {
        if (known.includes(a)) check(step[a], `"timeline[${i}].${a}"`, KNOWN_KEYS.anchor);
      }
      if (step.type === 'record') {
        check(step.samples, `"timeline[${i}].samples"`, KNOWN_KEYS.samples);
        check(step.viewport, `"timeline[${i}].viewport"`, KNOWN_KEYS.viewport);
        check(step.smoothing, `"timeline[${i}].smoothing"`, KNOWN_KEYS.smoothing);
        if (Array.isArray(step.buttons)) {
          step.buttons.forEach((b, n) => check(b, `"timeline[${i}].buttons[${n}]"`, KNOWN_KEYS.button));
        }
      }
    });
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
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
function resolveSubstitute(subs: Array<{ from: string; to: string; on?: string }> | undefined, pageUrl: string): Resolved['page']['substitute'] {
  if (subs === undefined) return [];
  if (!Array.isArray(subs)) throw new Error('"page.substitute" must be an array of { from, to }');
  return subs.map((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.from !== 'string' || s.from === '' || typeof s.to !== 'string' || s.to === '') {
      throw new Error(`page.substitute[${i}] must be { from: "url pattern", to: "url or file path" }`);
    }
    const on = s.on ?? null;
    if (on !== null) {
      if (typeof on !== 'string' || on === '') {
        throw new Error(`page.substitute[${i}].on must be a non-empty page wildcard ("/pricing*", or a full URL)`);
      }
      // A pattern with no scheme is matched against the document's pathname,
      // which always starts with "/" — anything else can never match.
      if (!/:\/\//.test(on) && !on.startsWith('/') && !on.startsWith('*')) {
        throw new Error(
          `page.substitute[${i}].on: "${on}" would never match — a page path starts with "/" ` +
            `(e.g. "/pricing*"), or give a full-URL wildcard (https://…)`,
        );
      }
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
      return { from: s.from, to: s.to, on };
    }
    const path = resolvePath(s.to);
    if (!existsSync(path)) throw new Error(`page.substitute[${i}]: replacement file not found: ${path}`);
    if (statSync(path).isDirectory()) throw new Error(`page.substitute[${i}]: replacement is a directory: ${path}`);
    return { from: s.from, to: path, on };
  });
}

/**
 * localStorage stores strings, so the snapshot must already be one string per
 * key — a number or object here means the config was assembled by hand, and
 * silently stringifying it would make the render disagree with the page's own
 * reading of the same key.
 */
function resolveLocalStorage(ls: Record<string, string> | undefined): Resolved['page']['localStorage'] {
  if (ls === undefined) return null;
  if (!isPlainObject(ls)) throw new Error('"page.localStorage" must be an object of string values');
  for (const [k, v] of Object.entries(ls)) {
    if (typeof v !== 'string') {
      throw new Error(
        `page.localStorage[${JSON.stringify(k)}] must be a string — localStorage stores strings; ` +
          `JSON.stringify structured values the way the page itself would`,
      );
    }
  }
  return Object.keys(ls).length > 0 ? ls : null;
}

/**
 * The seed feeds Math.imul in the runtime's PRNG, so a fractional seed would
 * be silently truncated — 4.2 and 4 rendering identically is exactly the kind
 * of quiet lie this config layer exists to refuse.
 */
function resolveSeedRandom(v: boolean | number | undefined): Resolved['page']['seedRandom'] {
  if (v === undefined || v === false) return null;
  if (v === true) return 42;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error('"page.seedRandom" must be true (seed 42) or an integer seed');
  }
  return v;
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
 * The macOS cursor sprites auto mode draws (assets/cursors/<name>.svg, vendored
 * from https://github.com/sawyerh/cursor.in — the runtime picks one per frame
 * from the CSS cursor in effect under the pointer). `w` is each SVG's natural
 * width in px, its default rendered size, so the set keeps macOS's relative
 * proportions. `tip` is the hotspot inside that natural box, measured off the
 * artwork: the arrow's point, the fingertip, palm and lens centres. The assets
 * dir also holds `poof` and `jk`, which no CSS cursor value triggers.
 */
export const AUTO_CURSORS: Record<string, { w: number; tip: [number, number] }> = {
  cursor: { w: 28, tip: [9, 7] },
  pointinghand: { w: 32, tip: [12, 8] },
  openhand: { w: 32, tip: [16, 14] },
  closedhand: { w: 32, tip: [16, 14] },
  copy: { w: 28, tip: [6, 5] },
  move: { w: 18, tip: [9, 9] },
  help: { w: 18, tip: [9, 9] },
  notallowed: { w: 28, tip: [6, 5] },
  zoomin: { w: 20, tip: [8, 8] },
  zoomout: { w: 20, tip: [8, 8] },
  resizenortheastsouthwest: { w: 18, tip: [9, 9] },
  screenshotselection: { w: 32, tip: [17, 17] },
};

/**
 * A replacement cursor image is embedded as a data: URI here, at config time —
 * the page can't read local files, and a typo'd path should fail in seconds,
 * not render an invisible cursor minutes in.
 */
function resolveCursor(
  c: boolean | { auto?: unknown; dot?: unknown; image?: unknown; tip?: unknown; size?: unknown; fade?: unknown } | undefined,
  pageUrl: string,
): Resolved['page']['cursor'] {
  if (c === false) return false;
  if (c === undefined || c === true) return { ...BUILTIN_CURSOR, fade: 0 };
  const shapeError = () =>
    new Error(
      '"page.cursor" must be true, false, { auto: true, size?: px, fade?: seconds } (the macOS set, ' +
        'picked per frame from the CSS cursor under the pointer), { dot: true, size?: px, fade?: seconds } ' +
        '(the preview-style touch disc), or ' +
        '{ image?: "path or url", tip?: [x, y], size?: px, fade?: seconds } (tip/size require image)',
    );
  if (typeof c !== 'object' || c === null) throw shapeError();
  if ([c.auto, c.dot, c.image].filter((m) => m !== undefined).length > 1) {
    throw new Error('page.cursor: give only one of "auto", "dot", "image"');
  }
  const fade = c.fade ?? 0;
  if (typeof fade !== 'number' || !Number.isFinite(fade) || fade < 0) {
    throw new Error('page.cursor.fade must be seconds >= 0');
  }
  if (c.dot !== undefined) {
    if (c.dot !== true) throw shapeError();
    if (c.tip !== undefined) {
      throw new Error('page.cursor.tip does not apply to the dot — it is centred on the point');
    }
    const size = c.size ?? 18; // the preview disc's rendered diameter
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      throw new Error('page.cursor.size must be the rendered width in CSS px > 0');
    }
    return { dot: true, tipX: size / 2, tipY: size / 2, size, fade };
  }
  if (c.auto !== undefined) {
    if (c.auto !== true) throw shapeError();
    if (c.tip !== undefined) {
      throw new Error('page.cursor.tip does not apply to auto mode — each macOS cursor carries its own hotspot');
    }
    // size is the arrow's rendered width; the rest of the set (and every
    // hotspot) scales with it, keeping macOS's relative proportions.
    const size = c.size ?? AUTO_CURSORS.cursor.w;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      throw new Error('page.cursor.size must be the rendered width in CSS px > 0');
    }
    const scale = size / AUTO_CURSORS.cursor.w;
    const sprites: Record<string, { url: string; tipX: number; tipY: number; size: number }> = {};
    for (const [name, { w, tip }] of Object.entries(AUTO_CURSORS)) {
      const svg = readFileSync(new URL(`../assets/cursors/${name}.svg`, import.meta.url));
      sprites[name] = {
        url: `data:image/svg+xml;base64,${svg.toString('base64')}`,
        tipX: tip[0] * scale,
        tipY: tip[1] * scale,
        size: w * scale,
      };
    }
    return { auto: sprites, fade };
  }
  if (c.image === undefined) {
    // Options-only form: the built-in arrow, faded. tip/size describe a
    // replacement sprite, so without one they're a mistake worth surfacing —
    // and a bare {} is too.
    if (c.tip !== undefined || c.size !== undefined || c.fade === undefined) throw shapeError();
    return { ...BUILTIN_CURSOR, fade };
  }
  if (typeof c.image !== 'string' || c.image === '') throw shapeError();
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
  return { image, tipX: tip[0], tipY: tip[1], size, fade };
}

/**
 * Parse a frame target — seconds ("2.5") or a percent ("50%"). Exported so
 * --watch can parse retarget lines with the exact same rules and messages.
 */
export function parseFrameAt(f: number | string): { sec: number } | { pct: number } {
  if (typeof f === 'string' && f.trim().endsWith('%')) {
    const body = f.trim().slice(0, -1).trim();
    const pct = body === '' ? NaN : Number(body); // Number('') is 0, so a bare "%" needs refusing by hand
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(`"frame" percent must be 0-100 (got "${f}")`);
    }
    return { pct };
  }
  const sec = typeof f === 'number' ? f : typeof f === 'string' && f.trim() !== '' ? Number(f) : NaN;
  if (!Number.isFinite(sec) || sec < 0) {
    throw new Error(
      `"frame" must be seconds into the timeline (e.g. 2.5) or a percent of it (e.g. "50%"), got ${JSON.stringify(f)}`,
    );
  }
  return { sec };
}

const FRAME_ACCURACIES = ['exact', 'segment', 'jump'] as const;

function resolveFrame(f: Config['frame']): Resolved['frame'] {
  if (f === undefined) return null;
  if (isPlainObject(f)) {
    if (f.at === undefined) {
      throw new Error('"frame" object form needs "at": seconds into the timeline (2.5) or a percent ("50%")');
    }
    const accuracy = f.accuracy ?? 'exact';
    if (!FRAME_ACCURACIES.includes(accuracy as never)) {
      throw new Error(`frame.accuracy must be exact, segment or jump (got "${accuracy}")`);
    }
    return { ...parseFrameAt(f.at), accuracy };
  }
  return { ...parseFrameAt(f), accuracy: 'exact' };
}

function resolveTrim(t: Config['trim']): Resolved['trim'] {
  if (t === undefined) return { startMs: 0, endMs: 0 };
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    throw new Error('"trim" must be an object: { start?: ms, end?: ms }');
  }
  const ms = (v: unknown, k: string): number => {
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`trim.${k} must be milliseconds >= 0`);
    }
    return v;
  };
  return { startMs: ms(t.start, 'start'), endMs: ms(t.end, 'end') };
}

export function resolveConfig(input: Config): Resolved {
  rejectUnknownKeys(input);
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

  const frame = resolveFrame(input.frame);
  let outPath = resolvePath(input.output?.path ?? (frame ? 'frame.png' : 'out.mp4'));
  let codec = input.output?.codec ?? CODEC_BY_EXT[extname(outPath).toLowerCase()] ?? 'h264';
  if (frame) {
    // A sampled frame is always one PNG file. The codec and a video extension
    // describe the video the frame is sampled FROM, so they're set aside
    // rather than argued with — "demo.mp4" samples to "demo.png".
    codec = 'png';
    outPath = extname(outPath) ? outPath.replace(/\.[^.]+$/, '.png') : outPath + '.png';
  } else if (codec === 'png') {
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
      seedRandom: resolveSeedRandom(input.page?.seedRandom),
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
      localStorage: resolveLocalStorage(input.page?.localStorage),
    },
    frame,
    trim: resolveTrim(input.trim),
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
