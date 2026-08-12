/**
 * Turn a timeline of steps into one scroll offset per frame.
 *
 * Anchors resolve to pixels *in the page, at capture time* rather than at author
 * time, so a config survives a late-loading image, a font swap, a dismissed cookie
 * banner, or a different viewport size.
 *
 * The timeline is always the normalised `Step[]` form — `resolveConfig` converts
 * legacy segments before anything gets here.
 */

import type { Session } from './cdp.ts';
import type { Anchor, Resolved, Step } from './types.ts';
import { autoDuration, DEFAULT_EASE, resolveEase } from './easing.ts';
import { durationSec, resample } from './gesture.ts';
import { sleep, SOFT_NAV_QUIET_MS } from './page.ts';

/** Seconds the timeline dwells after an interaction, letting what it triggered animate. */
export const DEFAULT_SETTLE = 0.6;

export type Track = {
  /**
   * Scroll offset for each frame, already snapped to the device-pixel grid.
   * NaN marks a FREE frame — the page owns the scroll there, because a
   * client-side route transition is playing and the router moves the scroll
   * itself (old view still at the click offset, jump-to-top at mount).
   */
  offsets: number[];
  /**
   * Interaction steps (click/hover/wait) pinned to the frame where they fire,
   * and to the scroll offset they fire AT. That offset is where the timeline
   * stood just before the interaction, which is not `offsets[frame]`: a click
   * that navigates puts the settle frames — frame included — at the top of the
   * destination, so replaying it from the frame's own offset would aim at
   * whatever happens to sit there. Empty until interactions are executable;
   * when populated, frames stop being independent and the track must render
   * sequentially.
   */
  actions: Array<{ frame: number; at: number; step: Step }>;
  /**
   * Recorded pointer state per frame, parallel to `offsets` (always the same
   * length — the frame count has ONE source of truth). null = no recorded
   * pointer this frame. `edges` are the button transitions the capture pass
   * dispatches on this frame, in order. Not `actions`: an action is one
   * selector-aimed event at one frame; a recording is continuous per-frame
   * data with coordinates already resolved.
   */
  pointer: Array<null | { x: number; y: number; down: boolean; edges?: Array<{ kind: 'down' | 'up'; x: number; y: number }> }>;
  /** True when interactions or a recording make frames path-dependent — the hook that forces jobs=1, like prewarm cache/none. */
  sequential: boolean;
  /** Human-readable description of what happens when. */
  plan: string[];
};

/**
 * How long to keep asking for an anchor once an interaction has been performed.
 * Before that the page is static and a miss is a bad selector, worth reporting
 * immediately; after it the page may still be mid-transition — a router mounting
 * a view, a modal opening, a tab revealing its panel — and the element is on its
 * way. The wait costs nothing when the anchor is already there.
 */
const POST_ACTION_ANCHOR_WAIT = 5_000;

async function resolve(session: Session, a: Anchor, waitMs = 0): Promise<number> {
  const deadline = Date.now() + waitMs;
  let failure: Error = new Error(`could not resolve anchor ${JSON.stringify(a)}`);
  for (;;) {
    try {
      const v = await session.eval<number>(`window.__sr.resolveAnchor(${JSON.stringify(a)})`);
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    } catch (e) {
      failure = e as Error; // the page reports WHY it missed — keep its message
    }
    if (Date.now() >= deadline) throw failure;
    await sleep(250);
  }
}

function describe(a: Anchor): string {
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return `${a}px`;
  const bits = [a.selector];
  if (a.align && a.align !== 'top') bits.push(a.align);
  if (a.offset) bits.push(`${a.offset > 0 ? '+' : ''}${a.offset}px`);
  return bits.join(' ');
}

export async function autoTimeline(session: Session, maxSections: number): Promise<Step[]> {
  const stops = await session.eval<number[]>(`window.__sr.discoverSections(${maxSections})`);
  if (!stops || stops.length < 2) {
    // Nothing section-like found — fall back to a single sweep to the bottom.
    return [
      { type: 'start', at: 'top', hold: 1.0 },
      { type: 'move', to: 'bottom', hold: 1.4 },
    ];
  }
  const steps: Step[] = [{ type: 'start', at: stops[0], hold: 1.0 }];
  for (let i = 1; i < stops.length; i++) {
    steps.push({
      type: 'move',
      to: stops[i],
      hold: i === stops.length - 1 ? 1.4 : 0.7,
    });
  }
  return steps;
}

export type BuildOptions = {
  /**
   * Actually perform a click/hover while the track is being built. Without
   * this, anchors that only exist on the page a click navigates TO cannot
   * resolve — the walk has to take the click to see the other side. The
   * callback reports whether the page changed (scroll resets to 0 there, and
   * everything after resolves against the new page); for a client-side route
   * change it also reports `sameDocument` and how long the transition took,
   * which sizes the settle so the transition fits on camera.
   */
  perform?: (
    step: Step & { type: 'click' | 'hover' },
    y: number,
  ) => Promise<{ navigated: boolean; sameDocument?: boolean; waitedMs?: number }>;
  /**
   * Replay a record step's gesture while the track is built — the recording's
   * counterpart of `perform`, and for the same reason: a recorded click can
   * navigate, and the view on the far side has to actually arrive before the
   * anchors beyond the recording can resolve there. The callback gets the
   * recording resolved onto the frame grid (offset + pointer state per frame,
   * edges attached) and reports how many clicks soft-navigated; a click that
   * loads a new document is its place to refuse, while refusing is still
   * cheap. Only called when the recording contains button edges — pointer
   * movement alone can't navigate.
   */
  performGesture?: (
    step: Step & { type: 'record' },
    rec: Array<{ y: number; ptr: NonNullable<Track['pointer'][number]> }>,
  ) => Promise<{ navigations: number }>;
};

export async function buildTrack(session: Session, cfg: Resolved, opts: BuildOptions = {}): Promise<Track> {
  let steps = cfg.timeline;
  if (cfg.auto || steps.length === 0) {
    const max = cfg.auto ? cfg.auto.maxSections : 6;
    steps = await autoTimeline(session, max);
  }
  if (steps.length === 0) throw new Error('timeline is empty');

  const offsets: number[] = [];
  const pointer: Track['pointer'] = [];
  const actions: Track['actions'] = [];
  const plan: string[] = [];
  const quantum = 1 / cfg.dpr; // Chrome stores scroll offsets on the device-pixel grid
  const snap = (y: number) => Math.round(y / quantum) * quantum;
  // The one way a frame is appended, so offsets and pointer cannot disagree
  // about the frame count.
  const push = (o: number, ptr: Track['pointer'][number] = null) => {
    offsets.push(o);
    pointer.push(ptr);
  };

  let interacted = false; // once true, anchors get time to appear (see resolve)

  const first = steps[0];
  if (first.type !== 'start') throw new Error('timeline must begin with a "start" step');
  let y = await resolve(session, first.at);
  const firstHold = first.hold ?? 0.8;
  const firstFrames = Math.round(firstHold * cfg.fps);
  for (let i = 0; i < firstFrames; i++) push(snap(y));
  plan.push(`0.00s  hold ${firstHold.toFixed(2)}s at ${describe(first.at)} (y=${Math.round(y)})`);

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const startT = offsets.length / cfg.fps;

    if (step.type === 'hold') {
      const holdFrames = Math.round(step.seconds * cfg.fps);
      for (let f = 0; f < holdFrames; f++) push(snap(y));
      plan.push(`${startT.toFixed(2)}s  hold ${step.seconds.toFixed(2)}s (y=${Math.round(y)})`);
      continue;
    }

    if (step.type === 'click' || step.type === 'hover') {
      // The interaction fires just before this frame is captured (render.ts owns
      // the actual CDP input); the settle frames dwell here while whatever it
      // triggered animates — the birth-time machinery in runtime.ts picks any
      // new animation up at the right frame automatically.
      actions.push({ frame: offsets.length, at: snap(y), step });
      // Performing it NOW is what lets later anchors resolve on whatever page
      // the click leads to. A navigation puts the new document at scroll 0.
      const performed = opts.perform ? await opts.perform(step, y) : { navigated: false };
      if (opts.perform) interacted = true;
      if (performed.navigated) y = 0;

      // A client-side route change plays its transition ON CAMERA during the
      // capture pass, across these settle frames. Two consequences: an unset
      // settle stretches to the transition just measured (the quiet-detection
      // tail is silence, not transition, so it comes off), and the frames are
      // FREE — the router owns the scroll while it swaps views, and imposing
      // an offset would yank the outgoing view around mid-transition.
      const soft = performed.navigated && performed.sameDocument === true;
      const measuredSec = soft && performed.waitedMs
        ? Math.max(0, performed.waitedMs - SOFT_NAV_QUIET_MS) / 1000
        : 0;
      const settle = step.settle
        ?? (soft ? Math.min(4, Math.max(DEFAULT_SETTLE, Math.ceil(measuredSec * 10) / 10)) : DEFAULT_SETTLE);
      const settleFrames = Math.max(1, Math.round(settle * cfg.fps));
      for (let f = 0; f < settleFrames; f++) push(soft ? NaN : snap(y));
      plan.push(
        `${startT.toFixed(2)}s  ${step.type} ${describe(step.target)}` +
          (performed.navigated ? (soft ? ' → navigates (client-side route)' : ' → navigates') : '') +
          `, settle ${settle.toFixed(2)}s`,
      );
      if (soft && step.settle != null && step.settle < measuredSec) {
        plan.push(
          `       ⚠ the route transition ran ~${measuredSec.toFixed(1)}s while planning but settle is ` +
            `${step.settle.toFixed(2)}s — the timeline may take the scroll back mid-transition; raise settle to film it fully`,
        );
      }
      continue;
    }

    if (step.type === 'record') {
      // The samples are data, not something to perform: resolve them onto the
      // frame grid and let the capture pass dispatch the input. The one
      // exception is the CLICKS a recording carries — one may navigate, and
      // later anchors then live on the destination view, so a recording with
      // button edges is replayed against the page now, exactly like click
      // steps are performed. State a recorded click creates (a menu opened, a
      // route mounted) then exists for the anchors that follow, as it will
      // during capture (which stays jobs=1 — the frames are path-dependent).
      const { frames, edges } = resample(step, cfg.fps);
      const base = offsets.length;
      for (const f of frames) push(snap(f.scroll), { x: f.x, y: f.y, down: f.down });
      for (const e of edges) {
        const p = pointer[base + e.frame];
        if (p) (p.edges ??= []).push({ kind: e.kind, x: e.x, y: e.y });
      }
      let navigations = 0;
      if (opts.performGesture && edges.length > 0) {
        const rec = [];
        for (let f = 0; f < frames.length; f++) rec.push({ y: offsets[base + f], ptr: pointer[base + f]! });
        navigations = (await opts.performGesture(step, rec)).navigations;
        interacted = true;
      }
      const startScroll = step.samples.s[0];
      const stoodAt = y;
      y = snap(frames[frames.length - 1].scroll);
      const hold = step.hold ?? 0;
      for (let f = 0; f < Math.round(hold * cfg.fps); f++) push(y);
      const clicks = edges.filter((e) => e.kind === 'down').length;
      plan.push(
        `${startT.toFixed(2)}s  replay recording (${durationSec(step).toFixed(2)}s, ${step.samples.t.length} samples` +
          (clicks ? `, ${clicks} click${clicks === 1 ? '' : 's'}` : '') +
          `)` +
          (navigations > 0 ? ` → ${navigations === 1 ? 'a click navigates' : `${navigations} clicks navigate`} (client-side route)` : '') +
          (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
      );
      if (Math.abs(startScroll - stoodAt) > 8) {
        plan.push(
          `       ⚠ the recording starts at scroll ${Math.round(startScroll)} but the timeline stands at ` +
            `${Math.round(stoodAt)} — the video will cut there; move to the recording's start first`,
        );
      }
      continue;
    }

    if (step.type !== 'move') {
      // 'wait' is rejected at config time; anything else reaching here is a bug
      throw new Error(`timeline[${i}]: "${step.type}" steps are not executable yet`);
    }

    const target = await resolve(session, step.to, interacted ? POST_ACTION_ANCHOR_WAIT : 0);
    const from = y;
    const distance = target - from;
    const ease = resolveEase(step.ease, Math.abs(distance) / cfg.height);
    const duration = step.duration ?? autoDuration(distance, cfg.height, ease);
    const frames = Math.max(1, Math.round(duration * cfg.fps));

    for (let f = 1; f <= frames; f++) push(snap(from + distance * ease(f / frames)));
    y = target;

    const isLast = i === steps.length - 1;
    const hold = step.hold ?? (isLast ? 0.8 : 0.6);
    const holdFrames = Math.round(hold * cfg.fps);
    for (let f = 0; f < holdFrames; f++) push(snap(y));

    const vh = Math.abs(distance) / cfg.height;
    plan.push(
      `${startT.toFixed(2)}s  ${distance >= 0 ? 'scroll to' : 'back to'} ${describe(step.to)} ` +
        `(y=${Math.round(target)}, ${Math.abs(Math.round(distance))}px = ${vh.toFixed(1)}vh) ` +
        `over ${duration.toFixed(2)}s ${typeof step.ease === 'string' ? step.ease : DEFAULT_EASE}` +
        (hold > 0 ? `, hold ${hold.toFixed(2)}s` : ''),
    );
  }

  if (offsets.length !== pointer.length) {
    throw new Error(`internal: offsets (${offsets.length}) and pointer (${pointer.length}) frame counts diverged`);
  }
  return { offsets, pointer, actions, sequential: actions.length > 0 || pointer.some((p) => p !== null), plan };
}

/**
 * The frame range trimming keeps: [first, last). Frame indices — and so every
 * time-seeked thing — stay absolute: a trimmed render captures the SAME frames
 * the full render would, minus the ends, exactly as if the finished video had
 * been cut afterwards.
 */
export function trimRange(total: number, fps: number, trim: { startMs: number; endMs: number }): { first: number; last: number } {
  const first = Math.round((trim.startMs / 1000) * fps);
  const last = total - Math.round((trim.endMs / 1000) * fps);
  if (last - first < 1) {
    throw new Error(
      `trim leaves nothing: the timeline runs ${(total / fps).toFixed(2)}s (${total} frames) but trim ` +
        `cuts ${(trim.startMs / 1000).toFixed(2)}s from the start and ${(trim.endMs / 1000).toFixed(2)}s from the end`,
    );
  }
  return { first, last };
}

/**
 * Resolve the config's `frame` (single-frame sampling) to a frame index.
 * Seconds map through fps; a time up to the timeline's duration lands on the
 * last frame rather than erroring (the timeline runs total/fps seconds but
 * its last frame sits at (total−1)/fps), while a time past the end is refused
 * with the duration in the message. A percent maps 0..100 onto first..last.
 */
export function frameIndex(total: number, fps: number, frame: { sec?: number; pct?: number }): number {
  if (frame.pct !== undefined) return Math.round((frame.pct / 100) * (total - 1));
  const sec = frame.sec!;
  const idx = Math.round(sec * fps);
  if (idx >= total) {
    if (sec <= total / fps) return total - 1;
    throw new Error(
      `frame ${sec}s is past the end — the timeline runs ${(total / fps).toFixed(2)}s ` +
        `(${total} frames). Use "100%" for the last frame.`,
    );
  }
  return idx;
}

/**
 * Per-frame opacity for the drawn cursor sprite, so it fades in when it
 * appears and out before it disappears instead of popping. Everything is a
 * pure function of the frame index — the core invariant — so it first replays
 * the capture loop's own show/hide rule (render.ts): the sprite appears on a
 * recorded-pointer frame, survives frames that hold the offset it parked at
 * (a record step's hold), and disappears the moment the scroll moves off it
 * (or goes free), with an interaction re-parking the pointer at the offset it
 * fired AT. Each visible run then ramps 0→1 over its first `fadeSec` and, when
 * it actually ends on camera (not at the last frame), 1→0 into the frame where
 * the sprite vanishes; short runs shrink both ramps to half the run so they
 * never cross. Frames where the sprite is hidden are 0.
 */
export function cursorAlphas(track: Track, fps: number, fadeSec: number): number[] {
  const total = track.offsets.length;
  const actionAt = new Map<number, number>();
  for (const a of track.actions) actionAt.set(a.frame, a.at);

  const visible = new Array<boolean>(total);
  let pointerAt: number | null = null;
  let shown = false;
  for (let n = 0; n < total; n++) {
    if (actionAt.has(n)) pointerAt = actionAt.get(n)!;
    const y = track.offsets[n];
    if (track.pointer[n]) {
      pointerAt = y;
      shown = true;
    } else if (pointerAt !== null && (Number.isNaN(y) || y !== pointerAt)) {
      pointerAt = null;
      shown = false;
    }
    visible[n] = shown;
  }

  const alphas = new Array<number>(total).fill(0);
  const fadeFrames = Math.round(fadeSec * fps);
  for (let a = 0; a < total; a++) {
    if (!visible[a]) continue;
    let b = a;
    while (b < total && visible[b]) b++;
    const f = Math.min(fadeFrames, Math.floor((b - a) / 2));
    for (let n = a; n < b; n++) {
      let alpha = f > 0 ? Math.min(1, (n - a + 1) / (f + 1)) : 1;
      if (f > 0 && b < total) alpha = Math.min(alpha, (b - n) / (f + 1));
      alphas[n] = alpha;
    }
    a = b;
  }
  return alphas;
}

/**
 * Peak per-frame displacement, in device pixels. Above roughly 30 device px the
 * motion starts reading as strobing rather than movement — worth warning about
 * because it's invisible until you watch the render.
 */
export function peakStep(track: Track, dpr: number): number {
  // A navigating interaction jumps from where it fired to the top of the
  // destination. That's a cut between two pages, not motion, so measuring it as
  // per-frame displacement would report strobing on every such timeline. Free
  // frames (NaN, a route transition playing) aren't ours to measure either.
  const cuts = new Set(
    track.actions.filter((a) => track.offsets[a.frame] !== a.at).map((a) => a.frame),
  );
  let peak = 0;
  for (let i = 1; i < track.offsets.length; i++) {
    if (cuts.has(i)) continue;
    const d = Math.abs(track.offsets[i] - track.offsets[i - 1]) * dpr;
    if (Number.isNaN(d)) continue;
    peak = Math.max(peak, d);
  }
  return peak;
}
