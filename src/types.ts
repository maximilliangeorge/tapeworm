/** Public config types. A config file is a JSON document matching `Config`. */

export type Align = 'top' | 'center' | 'bottom';

/** Where to scroll to. Either a keyword, a raw pixel offset, or an element anchor. */
export type Anchor =
  | 'top'
  | 'bottom'
  | number
  | {
      /** CSS selector, resolved at capture time (not at author time). */
      selector: string;
      /** Where the element sits in the viewport. Default 'top'. */
      align?: Align;
      /** Pixels added after alignment. Negative = breathing room above. Default 0. */
      offset?: number;
      /** Which match to use if the selector matches several. Default 0. */
      nth?: number;
      /**
       * A snippet of the element's text at author time. NEVER used to find the
       * element — only to turn "selector matched nothing" into a message that says
       * whether the content is gone or just re-marked-up.
       */
      fallbackText?: string;
    };

export type EaseName =
  | 'linear'
  /**
   * A flick-scroll: brief ramp to peak velocity, then exponential friction
   * decay. The only curve whose shape derives from the scroll distance —
   * longer scrolls get a shorter attack and a longer inertial tail.
   */
  | 'natural'
  | 'inOutSine' | 'inOutQuad' | 'inOutCubic' | 'inOutQuart' | 'inOutQuint' | 'inOutExpo'
  | 'outSine' | 'outQuad' | 'outCubic' | 'outQuart' | 'outQuint' | 'outExpo';

/** A named easing, or a raw CSS cubic-bezier as [x1,y1,x2,y2]. */
export type Ease = EaseName | [number, number, number, number];

/**
 * Legacy timeline entry (no `type` discriminant). Still accepted everywhere a
 * `Step` is; `resolveConfig` normalises it, so nothing downstream ever sees one.
 */
export type Segment = {
  /** Target. Omit only on the first segment, which uses `at` instead. */
  to?: Anchor;
  /** Starting position — first segment only. Default 'top'. */
  at?: Anchor;
  /** Seconds of travel. Omitted = derived from distance (see timeline.ts). */
  duration?: number;
  /** Default 'natural'. */
  ease?: Ease;
  /** Seconds to dwell after arriving. Default 0.8 on the first and last, else 0.6. */
  hold?: number;
};

/**
 * Timeline format v2: a discriminated union, so future step kinds (interactions)
 * are an addition rather than a breaking change. `timeline` entries may be a
 * legacy `Segment` or a `Step`, mixed freely.
 *
 * `wait` is part of the format NOW — configs containing it parse and typecheck —
 * but is rejected with a clear message until it lands, so designer-authored
 * configs won't break when it does.
 */
export type Step =
  /**
   * `url` pins where the timeline begins — authoring tools stamp it when the
   * first keyframe is created, so navigating during authoring can't silently
   * re-point the config at the wrong page. When present it must agree with
   * (or replace) the top-level `url`.
   */
  | { type: 'start'; at: Anchor; hold?: number; url?: string }
  | { type: 'move'; to: Anchor; duration?: number; ease?: Ease; hold?: number }
  | { type: 'hold'; seconds: number }
  | { type: 'click'; target: Anchor; settle?: number }
  | { type: 'hover'; target: Anchor; settle?: number }
  | { type: 'wait'; forSelector?: string; seconds?: number }
  /**
   * A recorded gesture, captured by an authoring tool: the user's real pointer
   * movement, clicks/drags and scrolling, replayed verbatim during the render
   * through Chrome's input pipeline (plus a drawn cursor — see `page.cursor`).
   * The RAW samples are stored so future smoothing/interpolation can re-resolve
   * them without re-recording; resolution to frames lives in
   * `shared/gesture-core.js`.
   */
  | {
      type: 'record';
      /**
       * Parallel arrays, one entry per sample: t = ms from recording start
       * (non-decreasing), x/y = pointer position in viewport CSS px,
       * s = window.scrollY.
       */
      samples: { t: number[]; x: number[]; y: number[]; s: number[] };
      /** Sparse left-button edges, chronological; the first must be 'down'. */
      buttons?: Array<{ t: number; action: 'down' | 'up' }>;
      /**
       * Opt-in cursor smoothing: resolve the pointer path through a zero-phase
       * Gaussian kernel instead of replaying the raw samples verbatim. `true`
       * means strength 0.5; `strength` 0..1 scales the kernel width. The path
       * is pinned to the raw positions at button edges and the take's ends, so
       * clicks and drag grab/release points land exactly where recorded; the
       * route BETWEEN them (drags included) is smoothed, so what the render
       * hovers or drags through can differ slightly from the live capture.
       * Absent/false = verbatim replay. Scroll is never smoothed.
       */
      smoothing?: boolean | { mode?: 'denoise'; strength?: number };
      /**
       * The viewport this was recorded at. A render at a different size is
       * refused: breakpoints make it a different page, so the recorded
       * coordinates and scroll offsets would land on the wrong things.
       */
      viewport: { width: number; height: number; dpr?: number };
      /** Seconds to dwell after the replay ends. Default 0. */
      hold?: number;
    };

export type TimelineEntry = Segment | Step;

export type VideoMode =
  /** Seek every <video> to the frame's timestamp. The default, and the whole point. */
  | 'sync'
  /** Pause every <video> and leave it on its poster/first frame. */
  | 'freeze'
  /** Don't touch them. They'll advance on wall clock and look wrong. */
  | 'ignore';

export type Config = {
  url: string;
  viewport?: {
    /** CSS pixels. Default 1280. */
    width?: number;
    /** CSS pixels. Default 800. */
    height?: number;
    /** Device pixel ratio. 2 or 3 — never fractional. Default 2. */
    dpr?: number;
  };
  /** Default 60. Scroll is the worst case for temporal aliasing; 60 is worth it. */
  fps?: number;
  timeline?: TimelineEntry[];
  /**
   * With no timeline, discover candidate sections automatically and march through
   * them. Good for a first look at an unfamiliar page.
   */
  auto?: boolean | { maxSections?: number };
  output?: {
    /** Default 'out.mp4'. Extension picks a sensible default codec. */
    path?: string;
    /**
     * h264   — CRF 12, yuv444p. Big, near-transparent, plays everywhere.
     * prores — ProRes 4444. Editor-friendly master.
     * png    — numbered PNG sequence in a directory. Truly lossless.
     * Default: inferred from `path` extension, else 'h264'.
     */
    codec?: 'h264' | 'prores' | 'png';
    /** Override the x264 CRF. Lower = better. Default 12. */
    crf?: number;
  };
  prewarm?: {
    /**
     * 'full'  — step-scroll everything, then film. Lazy content is loaded and scroll
     *           reveals have already fired, so the pass is clean with no popping.
     *           Shardable across jobs. The default.
     * 'cache' — step-scroll to fill the HTTP cache, then reload and film. Reveals
     *           fire ON CAMERA and animate properly, with images instantly available
     *           because they're cached. Forces jobs=1.
     * 'none'  — film a cold page. Most authentic, least predictable: image arrival is
     *           wall-clock, not timeline. Forces jobs=1.
     */
    mode?: 'full' | 'cache' | 'none';
    /** Legacy alias: false means mode 'none'. */
    enabled?: boolean;
    /** Give up past this document height. Default 60000. */
    maxHeight?: number;
    /** Give up past this many wall-clock ms. Default 30000. */
    timeout?: number;
    /** Legacy alias: true means mode 'cache'. */
    reloadAfter?: boolean;
    /**
     * Longest a frame will wait for images that are still loading, in ms.
     * Default 1500 ('none'/'cache'), 400 ('full', where nothing should be pending).
     */
    imageBudget?: number;
  };
  page?: {
    /** Try to dismiss cookie/consent dialogs. Default true. */
    dismissConsent?: boolean;
    /** Remove late-appearing fixed overlays (newsletter modals, chat widgets). Default true. */
    hideOverlays?: boolean;
    /**
     * 'virtual' overrides Date.now/performance.now/rAF/timers so JS animation follows
     * the frame index. 'real' leaves them alone. Default 'virtual'.
     */
    clock?: 'virtual' | 'real';
    /** Pause and seek CSS/WAAPI animations per frame. Default true. */
    seekAnimations?: boolean;
    /**
     * Draw a cursor sprite during recorded-gesture replay, so the gesture is
     * visible in the video (screenshots never contain the real pointer).
     * Input is still dispatched when false. Default true.
     *
     * `{ auto: true }` draws the bundled macOS cursor set (assets/cursors/,
     * from https://github.com/sawyerh/cursor.in), switching sprite per frame
     * with the CSS cursor in effect under the pointer — arrow over the page,
     * pointing hand over links, open/closed hand across a grab, zoom, help,
     * not-allowed, and so on. Each cursor renders at its natural macOS size
     * with its own hotspot; `size` rescales the whole set, stated as the
     * arrow's rendered width in CSS px (default 28, the natural size).
     *
     * `{ dot: true }` draws the circular marker the extension preview uses —
     * a dark disc with a white ring, centred on the point, turning blue while
     * the button is down. Reads as a fingertip rather than a mouse, which
     * suits touch-style demos. `size` is its diameter in CSS px (default 18,
     * the preview's).
     *
     * `{ image: … }` replaces the built-in arrow with one sprite of your own:
     * a local image file (png/svg/gif/jpeg/webp, embedded into the render at
     * config time), or an https:// or data: URL. `tip` is the [x, y] px
     * inside the *rendered* sprite where the pointer tip sits — default
     * [0, 0], the top-left corner. `size` is the rendered width in CSS px,
     * height keeping the image's aspect — default 32.
     *
     * `fade` is how many seconds the sprite fades in when it appears and out
     * before it disappears, instead of popping. Default 0 (no fade). It
     * applies in every mode: alone (`{ fade: 0.3 }` fades the built-in
     * arrow), with `auto`, `dot`, or `image`. `tip` describes a replacement
     * sprite and requires `image`.
     */
    cursor?:
      | boolean
      | { auto: true; dot?: never; image?: never; tip?: never; size?: number; fade?: number }
      | { dot: true; auto?: never; image?: never; tip?: never; size?: number; fade?: number }
      | { image?: string; auto?: never; dot?: never; tip?: [number, number]; size?: number; fade?: number };
    video?: VideoMode;
    /**
     * Same modes, applied to provider embeds (YouTube/Vimeo iframes), driven
     * through their postMessage player APIs — best-effort and keyframe-coarse,
     * unlike the frame-exact native <video> path. Defaults to `video`'s value.
     * 'sync' embeds force jobs=1 (provider seeks buffer per worker).
     */
    embeds?: VideoMode;
    /** Extra CSS injected before the page's own scripts run. */
    css?: string;
    /** Extra JS injected before the page's own scripts run. */
    script?: string;
    /** Wait this many ms after load before doing anything. Default 0. */
    settle?: number;
    /**
     * Longest to wait for intro/preloader animations to finish before filming.
     * Polls until no finite animation is running; infinite loops are ignored.
     * 0 disables. Default 8000.
     */
    waitForIntro?: number;
    /**
     * false (default): animations already running when capture starts continue from
     * where they are — so an intro you waited out stays finished.
     * true: rewind them to 0, i.e. replay the intro on camera.
     */
    replayIntro?: boolean;
    /**
     * Some intros advance on scroll rather than time, leaving the document
     * unscrollable until you push through them. When the page isn't scrollable after
     * load, send real wheel events until it is. Default on.
     */
    unlockIntro?: boolean | { maxTicks?: number; deltaY?: number };
    /**
     * Substitute assets during the render by intercepting their requests —
     * swap the hero video for a different source file, say. `from` is a URL
     * wildcard pattern (`*` matches any run of characters, `?` any single one)
     * matched against the full request URL; `to` is the replacement: an
     * https URL fetched in the original's place, or a local file path, served
     * from disk with full Range-request support (which is what lets a
     * substituted <video> seek). The page never sees the switch. Substituted
     * videos must be seekable — mp4 with the moov atom up front
     * (ffmpeg -movflags +faststart).
     */
    substitute?: Array<{ from: string; to: string }>;
  };
  /**
   * Sample a single frame instead of rendering the video: seconds into the
   * timeline (`2.5`), or a percent of it (`"50%"` — `"100%"` is the last
   * frame). The timeline is still planned in full (and, when the render is
   * path-dependent, walked up to the sampled frame), so the frame is
   * pixel-identical to the same moment of a full render. The output is one
   * PNG file (`output.path` names it; a video extension there is swapped for
   * `.png`) and `output.codec` is ignored. CLI: `--frame`.
   */
  frame?: number | string;
  /**
   * Cut milliseconds off the ends of the finished video. The whole timeline is
   * still planned (and, when the render is path-dependent, walked) — trimming
   * only drops the trimmed frames from the output, so what remains is
   * identical to rendering everything and cutting the file afterwards.
   */
  trim?: {
    /** Milliseconds removed from the start. Default 0. */
    start?: number;
    /** Milliseconds removed from the end. Default 0. */
    end?: number;
  };
  /**
   * Render in N parallel browser processes. Frames are independent because every
   * time-dependent thing is seeked, so this is a near-linear speedup.
   * Default: min(4, cpus-1).
   */
  jobs?: number;
  /** Path to a Chrome / chrome-headless-shell binary. Default: auto-detect. */
  chromePath?: string;
  /**
   * Provenance stamped by authoring tools (authoredWith, authoredAt,
   * authoredViewport, url). Ignored by the renderer; kept for diagnosing drift
   * between the authoring environment and the render.
   */
  meta?: Record<string, unknown>;
  /** Show the browser window. Useful for debugging a page that fights you. */
  headful?: boolean;
};

/** Fully-resolved config — every default filled in. */
export type Resolved = {
  url: string;
  width: number;
  height: number;
  dpr: number;
  fps: number;
  /** Always normalised: legacy segments have been converted to steps. */
  timeline: Step[];
  auto: false | { maxSections: number };
  outPath: string;
  codec: 'h264' | 'prores' | 'png';
  crf: number;
  prewarm: {
    mode: 'full' | 'cache' | 'none';
    maxHeight: number;
    timeout: number;
    imageBudget: number;
  };
  page: {
    dismissConsent: boolean;
    hideOverlays: boolean;
    clock: 'virtual' | 'real';
    seekAnimations: boolean;
    /**
     * false = never drawn. `auto` = the macOS set: sprite name → embedded
     * data: URI, rendered width, and hotspot, all pre-scaled at config time;
     * the page runtime picks per frame from the CSS cursor under the pointer.
     * `dot` = the preview-style touch disc, tip pre-centred (tipX/tipY =
     * size/2). Otherwise one fixed sprite: the built-in arrow when `image`
     * is null, else an image URL (local files became data: URIs at config
     * time). tipX/tipY are the px inside the rendered sprite where the
     * pointer tip sits; size is the rendered width in CSS px. fade is the
     * appear/disappear fade in seconds, 0 = pop; it applies in every mode.
     */
    cursor:
      | false
      | { image: string | null; auto?: never; dot?: never; tipX: number; tipY: number; size: number; fade: number }
      | { dot: true; auto?: never; image?: never; tipX: number; tipY: number; size: number; fade: number }
      | { auto: Record<string, { url: string; tipX: number; tipY: number; size: number }>; image?: never; dot?: never; fade: number };
    video: VideoMode;
    embeds: VideoMode;
    css: string;
    script: string;
    settle: number;
    waitForIntro: number;
    replayIntro: boolean;
    unlockIntro: { enabled: boolean; maxTicks: number; deltaY: number };
    /** `to` is an http(s) URL, or an absolute local path verified to exist. */
    substitute: Array<{ from: string; to: string }>;
  };
  /** Single-frame sampling: seconds into the timeline, or a percent of it. Null = render the video. */
  frame: { sec: number; pct?: never } | { pct: number; sec?: never } | null;
  trim: { startMs: number; endMs: number };
  jobs: number;
  chromePath: string | null;
  headful: boolean;
};
