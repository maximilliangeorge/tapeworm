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
 * `click`/`hover`/`wait` are part of the format NOW — configs containing them
 * parse and typecheck — but are rejected with a clear message until interactions
 * land, so designer-authored configs won't break when they do.
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
  | { type: 'wait'; forSelector?: string; seconds?: number };

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
    video?: VideoMode;
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
    video: VideoMode;
    css: string;
    script: string;
    settle: number;
    waitForIntro: number;
    replayIntro: boolean;
    unlockIntro: { enabled: boolean; maxTicks: number; deltaY: number };
  };
  jobs: number;
  chromePath: string | null;
  headful: boolean;
};
