/**
 * The render loop, and the shard scheduler around it.
 *
 * Every time-dependent thing (scroll, animations, video) is seeked from the frame
 * index rather than read from the wall clock, so frame N doesn't depend on frame
 * N-1 having been rendered. That's what makes it safe to split the frame range
 * across several browsers and stitch the results.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launch } from './browser.ts';
import type { Connection, Session } from './cdp.ts';
import { concatSegments, createEncoder, createPngFileWriter, createPngWriter, type Encoder } from './encode.ts';
import { openPage, prewarm, resetPage, settleNewDocument, sleep, waitForDocumentReady, waitForSoftNavigation } from './page.ts';
import { strobeThreshold } from './easing.ts';
import { buildTrack, cursorAlphas, frameIndex, peakStep, segmentStart, trimRange, type Track } from './timeline.ts';
import type { Resolved, Step } from './types.ts';

export type Progress = {
  onPlan?(plan: string[], track: Track, notes: string[]): void;
  onFrame?(done: number, total: number): void;
  onNote?(note: string): void;
};

type Worker = { conn: Connection; session: Session; notes: string[] };

async function startWorker(cfg: Resolved, chromePath: string): Promise<Worker> {
  const conn = launch({ chromePath, headful: cfg.headful, deviceScaleFactor: cfg.dpr });
  const { session, notes } = await openPage(conn, cfg);
  const warmNotes = await prewarm(session, cfg);
  return { conn, session, notes: [...notes, ...warmNotes] };
}

/**
 * Capture one frame. Returns the PNG bytes.
 *
 * A NaN offset is a FREE frame — one where the page owns the scroll (a router
 * transition is playing). No offset is imposed and no drift is checked, because
 * whatever the page does with the scroll during its transition is the content.
 *
 * `screenshot: false` renders the frame without capturing it — the page is
 * still scrolled, the virtual clock still advances, images are still awaited —
 * which is how a path-dependent render walks frames that trim drops from the
 * output.
 */
async function captureFrame(
  session: Session,
  y: number,
  tSec: number,
  cfg: Resolved,
  cursor?: { x: number; y: number; down: boolean; alpha?: number } | null,
  screenshot = true,
): Promise<Buffer> {
  const free = Number.isNaN(y);
  const cursorArg = cursor === undefined ? '' : `, ${JSON.stringify(cursor)}`;
  const result = await session.eval<any>(
    `window.__sr.frame(${free ? 'null' : y}, ${tSec}, ${cfg.prewarm.imageBudget}${cursorArg})`,
    true,
    Math.max(20_000, cfg.prewarm.imageBudget + 15_000),
  );

  // Chrome stores scroll offsets on the device-pixel grid; anything beyond that is
  // the page fighting us (scroll anchoring, snap, a hijacker we missed).
  if (!free && result && Math.abs(result.actual - result.requested) > 1 / cfg.dpr + 0.001) {
    const clampedAtEnd = result.requested >= result.max - 1;
    if (!clampedAtEnd) {
      throw new ScrollDrift(result.requested, result.actual);
    }
  }

  if (!screenshot) return Buffer.alloc(0);

  const shot = await session.send<{ data: string }>(
    'Page.captureScreenshot',
    { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true },
    30_000,
  );
  return Buffer.from(shot.data, 'base64');
}

/**
 * Perform a click/hover through Chrome's real input pipeline
 * (Input.dispatchMouseEvent), the same road unlockScroll takes. Synthetic DOM
 * clicks won't do: they carry isTrusted=false, produce no hover/active states,
 * and many libraries ignore them.
 *
 * A click may navigate, in either of two ways. A document load is detected with
 * a marker the new document can't have. A client-side router instead swaps the
 * view under the SAME document — the marker survives, so the tell is that
 * location.href moved.
 *
 * What happens next depends on the phase. In the 'plan' phase (building the
 * track) the new view must finish arriving before the anchors beyond it can
 * resolve, so it is waited in, settled, and pre-warmed — which also loads its
 * assets into Chrome's cache for the pass that follows. In the 'capture' phase
 * a soft navigation returns IMMEDIATELY instead: the router's transition is
 * content, and it films across the settle frames, driven per-frame by the
 * virtual clock like every other animation a click starts. Waiting here is
 * what would cut the transition out of the video. A document load still gets
 * the full treatment in both phases — tearing down the document destroys any
 * transition, so there is nothing to film, and the new page must be made
 * ready before it goes on camera.
 */
async function performAction(
  session: Session,
  cfg: Resolved,
  step: Step & { type: 'click' | 'hover' },
  y: number,
  note: (s: string) => void,
  phase: 'plan' | 'capture' = 'plan',
): Promise<{ navigated: boolean; sameDocument: boolean; waitedMs?: number; url?: string }> {
  await session.eval(`window.__sr.setScroll(${y})`);
  const target = step.target as { selector: string; nth?: number };
  const pt = await session.eval<{ found: boolean; x: number; y: number; visible: boolean }>(
    `window.__sr.actionPoint(${JSON.stringify(target)})`,
  );
  if (!pt?.found) {
    throw new Error(`cannot ${step.type} "${target.selector}": selector matched nothing at that point in the timeline`);
  }
  // actionPoint clamps into the viewport, so an off-screen target still yields a
  // point — one sitting on top of some unrelated element. Dispatching there
  // produces a plausible-looking render of the wrong thing, so refuse instead.
  if (!pt.visible) {
    throw new Error(
      `cannot ${step.type} "${target.selector}": it is not in view at scroll ${Math.round(y)}, ` +
        `so the ${step.type} would land on whatever else is there. Move to it before the ${step.type}.`,
    );
  }
  await session.eval('window.__srNavProbe = true').catch(() => {});
  const wasAt = await session.eval<string>('location.href').catch(() => '');
  const at = { x: Math.round(pt.x), y: Math.round(pt.y) };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  // the move is only queued — wait until the hover state it produces exists
  // (open-on-hover UI, :hover transitions) before pressing or capturing
  await session.eval(`window.__sr.settlePointer(${at.x}, ${at.y})`, true, 5_000).catch(() => {});
  if (step.type === 'click') {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
  }
  // give the page's handlers a beat of real time; the animations they start are
  // then driven per-frame by the virtual clock like everything else
  await new Promise((r) => setTimeout(r, 150));

  const sameDocument = await session.eval<boolean>('window.__srNavProbe === true').catch(() => false);
  const nowAt = sameDocument ? await session.eval<string>('location.href').catch(() => wasAt) : '';
  if (sameDocument && nowAt === wasAt) return { navigated: false, sameDocument: true };

  if (sameDocument && phase === 'capture') {
    // Filming: the transition the router just started IS the shot. The plan
    // phase already resolved the far side and warmed its assets into the
    // cache, so nothing needs to block here — the settle frames film the swap.
    note(`${step.type} on ${target.selector} routed to ${nowAt} — filming the transition`);
    return { navigated: true, sameDocument: true };
  }

  // The click navigated and this pass needs the destination READY — either the
  // plan phase (anchors beyond this point resolve on the new view), or a
  // document load (fresh page, must be settled before it goes on camera).
  let waitedMs: number | undefined;
  let url: string | undefined;
  if (sameDocument) {
    waitedMs = await waitForSoftNavigation(session);
    note(
      `${step.type} on ${target.selector} routed to ${nowAt} without a page load ` +
        `(waited ${(waitedMs / 1000).toFixed(1)}s for the new view) — settling and pre-warming`,
    );
  } else {
    await waitForDocumentReady(session);
    url = await session.eval<string>('location.href').catch(() => '');
    note(`${step.type} on ${target.selector} navigated to ${url || '(unknown)'} — settling and pre-warming`);
  }
  for (const n of await settleNewDocument(session, cfg)) note(n);
  for (const n of await prewarm(session, cfg)) note(n);
  return { navigated: true, sameDocument, waitedMs, url: url || undefined };
}

/**
 * Replay a recording's gesture during the plan phase — performAction's
 * counterpart for record steps. The pointer path and button edges go through
 * the real input pipeline, so state a recorded click creates (a menu opened, a
 * view routed in) exists for the anchors that follow, and — the reason this
 * runs at all — a click that navigates does it HERE, where there is time to
 * deal with it. A client-side route change is waited in, settled and
 * pre-warmed like a navigating click step's destination; a document load is
 * refused, because the frames after it were recorded on a page that no longer
 * exists and no capture pass could honour them.
 *
 * The replay is not paced to the recording's clock — only the page state it
 * leaves behind matters, the capture pass owns the timing. Two beats are kept:
 * one before each press, so open-on-hover UI the pointer path just triggered
 * has real time to open before the click lands on it, and performAction's
 * settle beat after each release for the handlers it fires.
 */
async function performRecordedGesture(
  session: Session,
  cfg: Resolved,
  rec: Array<{ y: number; ptr: { x: number; y: number; down: boolean; edges?: Array<{ kind: 'down' | 'up'; x: number; y: number }> } }>,
  note: (s: string) => void,
): Promise<{ navigations: number }> {
  let navigations = 0;
  let lastY: number | null = null;
  for (const { y, ptr } of rec) {
    if (y !== lastY) {
      await session.eval(`window.__sr.setScroll(${y})`);
      lastY = y;
    }
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(ptr.x),
      y: Math.round(ptr.y),
      button: 'none',
      buttons: ptr.down ? 1 : 0,
    });
    for (const edge of ptr.edges ?? []) {
      let wasAt = '';
      if (edge.kind === 'down') {
        await sleep(300); // hover-intent UI under the pointer gets to open first
      } else {
        await session.eval('window.__srNavProbe = true').catch(() => {});
        wasAt = await session.eval<string>('location.href').catch(() => '');
      }
      await session.send('Input.dispatchMouseEvent', {
        type: edge.kind === 'down' ? 'mousePressed' : 'mouseReleased',
        x: Math.round(edge.x),
        y: Math.round(edge.y),
        button: 'left',
        clickCount: 1,
        buttons: edge.kind === 'down' ? 1 : 0,
      });
      if (edge.kind !== 'up') continue;
      await sleep(150);
      const sameDocument = await session.eval<boolean>('window.__srNavProbe === true').catch(() => false);
      const nowAt = sameDocument ? await session.eval<string>('location.href').catch(() => wasAt) : '';
      if (!sameDocument) {
        throw new Error(
          'a recorded click loads a new document — the rest of the recording was captured on a page ' +
            'that no longer exists, so it cannot replay across the load. Split the recording at that ' +
            'click: a "click" step for the navigation, then a second recording on the destination. ' +
            '(The extension does this automatically when a recorded click navigates.)',
        );
      }
      if (nowAt !== wasAt) {
        navigations++;
        const waitedMs = await waitForSoftNavigation(session);
        note(
          `recorded click routed to ${nowAt} without a page load ` +
            `(waited ${(waitedMs / 1000).toFixed(1)}s for the new view) — settling and pre-warming`,
        );
        for (const n of await settleNewDocument(session, cfg)) note(n);
        for (const n of await prewarm(session, cfg)) note(n);
        lastY = null; // the prewarm sweep moved the scroll — re-assert on the next frame
      }
    }
  }
  return { navigations };
}

/**
 * Move the virtual pointer far off the viewport. Chrome keeps the last pointer
 * position an interaction's mouseMoved left behind and re-computes :hover on
 * every scroll, so once the timeline scrolls on, whatever passes under that
 * stale point renders hovered — the same artifact the preview's cursor shield
 * exists to keep out of authoring. Parking is deferred until the scroll
 * actually moves (see the capture loop) so the interaction's own hover/active
 * state stays on camera through its settle.
 */
async function parkPointer(session: Session): Promise<void> {
  await session
    .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -10_000, y: -10_000 })
    .catch(() => {});
}

export class ScrollDrift extends Error {
  constructor(requested: number, actual: number) {
    super(`page moved the scroll offset: asked ${requested.toFixed(2)}, got ${actual.toFixed(2)}`);
    this.name = 'ScrollDrift';
  }
}

/**
 * The capture loop's cross-frame pointer/sprite state. The pointer stays put
 * while the scroll holds the offset an interaction or recorded frame parked it
 * at (its hover/active state on the target is part of the shot) and is parked
 * the moment the scroll moves — Chrome re-computes :hover from the last
 * pointer position on every scroll, so a stale point would smear hover states
 * across whatever passes under it. Carried across watch-mode calls so the
 * sprite doesn't pop between peeks.
 */
type RangeState = {
  /** Scroll offset the pointer is sitting at, or null when it's parked off-page. */
  pointerAt: number | null;
  cursorShown: boolean;
  lastSprite: { x: number; y: number; down: boolean } | null;
};

const freshRangeState = (): RangeState => ({ pointerAt: null, cursorShown: false, lastSprite: null });

/**
 * Evaluate one run of never-captured frames as a single in-page walk — one CDP
 * round trip and no per-frame paint settles, instead of one eval and two rAFs
 * per frame. This is where a path-dependent walk used to spend its time.
 * Chunked so a very long run stays under CDP message-size and timeout limits.
 * The scroll-drift check runs per chunk on the last imposed offset — the page
 * is still re-asserted every frame in-page, only the reporting is coarser,
 * and none of these frames reaches the output.
 */
async function walkBatch(
  worker: Worker,
  cfg: Resolved,
  frames: Array<[number, number | null]>,
  native: boolean,
  drift: string[],
): Promise<void> {
  const CHUNK = 600;
  for (let i = 0; i < frames.length; i += CHUNK) {
    const part = frames.slice(i, i + CHUNK);
    const r = await worker.session.eval<any>(
      `window.__sr.walkFrames(${JSON.stringify(part)}, ${native}, ${cfg.prewarm.imageBudget})`,
      true,
      120_000,
    );
    if (r && r.requested != null && Math.abs(r.actual - r.requested) > 1 / cfg.dpr + 0.001) {
      const clampedAtEnd = r.requested >= r.max - 1;
      if (!clampedAtEnd) {
        if (drift.length < 3) {
          drift.push(
            `walked frames: page moved the scroll offset (asked ${Number(r.requested).toFixed(2)}, got ${Number(r.actual).toFixed(2)})`,
          );
        }
        await worker.session.eval(`window.__sr.setScroll(${r.requested})`).catch(() => {});
      }
    }
  }
}

type RangeOpts = {
  cfg: Resolved;
  track: Track;
  /** First frame the range establishes state from. Frames in [walkFrom, from) are walked, not captured. */
  walkFrom: number;
  /** First captured frame. */
  from: number;
  /** One past the last captured frame. */
  to: number;
  /** Actions eligible to fire — a segment restart withholds the click whose navigation the direct load replaced. */
  actions: Track['actions'];
  /**
   * How never-captured frames are walked. 'exact' dispatches every recorded
   * pointer frame through the real input pipeline and gives every
   * scroll-moving frame a real rendering step, so IntersectionObserver
   * reveals and hover-driven state land on the frames they belong to. 'jump'
   * steps the virtual clock in-page and dispatches only button edges —
   * movement-only pointer frames are skipped, their scroll still imposed.
   * Captured frames always take the full per-frame path.
   */
  walk: 'exact' | 'jump';
  enc: Encoder;
  alphas: number[] | null;
  note: (s: string) => void;
  drift: string[];
  onCaptured?: () => void;
  /** Carried across watch-mode calls; a fresh one is made when absent. */
  state?: RangeState;
};

/**
 * Walk [walkFrom, from) and capture [from, to) on one worker. The heart of
 * both render() (one call per shard) and the watch-mode frame server.
 */
async function captureRange(worker: Worker, opts: RangeOpts): Promise<void> {
  const { cfg, track, walkFrom, from, to, actions, walk, enc, alphas, note, drift } = opts;
  const st = opts.state ?? freshRangeState();
  const actionFrames = new Set(actions.map((a) => a.frame));
  // A jump walk still turns real rendering back on for the last second before
  // the capture: IntersectionObserver only delivers on rendering updates, so
  // reveals around the sampled frame would otherwise all fire at capture time
  // and render at phase 0. One second of native run-up puts everything near
  // the target close to where an exact walk would have it, at bounded cost.
  const nativeTail = walk === 'jump' ? from - Math.round(cfg.fps) : walkFrom;

  // Frames that must run the full per-frame path: captured frames, action
  // frames, dispatched pointer frames ('exact': all of them; 'jump': only
  // ones carrying button edges), and the frame where the scroll first moves
  // off a parked pointer — the park must dispatch exactly there, or hover
  // state lingers past the frame it belongs to.
  const needsOwnFrame = (n: number): boolean => {
    if (n >= from) return true;
    if (actionFrames.has(n)) return true;
    const p = track.pointer[n];
    if (p) return walk === 'exact' || (p.edges?.length ?? 0) > 0;
    if (st.pointerAt !== null) {
      const y = track.offsets[n];
      if (Number.isNaN(y) || y !== st.pointerAt) return true;
    }
    return false;
  };

  let n = walkFrom;
  while (n < to) {
    if (!needsOwnFrame(n)) {
      const native = walk === 'exact' || n >= nativeTail;
      const batch: Array<[number, number | null]> = [];
      while (n < to && !needsOwnFrame(n) && (native || n < nativeTail)) {
        const y = track.offsets[n];
        batch.push([n / cfg.fps, Number.isNaN(y) ? null : y]);
        // 'jump' batches over movement-only recorded frames — keep the sprite
        // state machine honest so the park and any fade land where they would
        const p = track.pointer[n];
        if (p) {
          st.pointerAt = y;
          st.cursorShown = true;
          st.lastSprite = { x: p.x, y: p.y, down: p.down };
        }
        n++;
      }
      await walkBatch(worker, cfg, batch, native, drift);
      continue;
    }

    const capturing = n >= from;
    const y = track.offsets[n];
    const t = n / cfg.fps;
    for (const action of actions) {
      if (action.frame !== n) continue;
      // action.at, not y: the interaction fires from where the timeline
      // stood BEFORE it, which differs from this frame's offset whenever
      // the interaction navigates.
      const r = await performAction(worker.session, cfg, action.step as Step & { type: 'click' | 'hover' }, action.at, note, 'capture');
      st.pointerAt = action.at;
      if (walk === 'jump' && r.navigated && r.sameDocument) {
        // The route's fetch/mount runs on REAL time, which the exact walk's
        // per-frame rendering waits supply incidentally and the jump walk
        // doesn't — without this, the sample catches the route mid-mount.
        await waitForSoftNavigation(worker.session);
      }
      if (r.navigated && !r.sameDocument) {
        // brand-new document: fresh runtime, fresh animation state. A
        // soft navigation keeps the document — and must NOT re-arm: the
        // transition's animations are mid-flight on their birth times.
        await worker.session.eval(`window.__sr.beginCapture(${cfg.page.replayIntro})`).catch(() => {});
        // fresh document = fresh embed handshakes too (no-op without embeds)
        await worker.session.eval(`window.__sr.embedsReady(2000, ${t})`, true, 4_000).catch(() => {});
      }
    }

    // A recorded frame owns the mouse: scroll first so the hover
    // computation the events trigger sees THIS frame's layout (the same
    // order performAction uses), then the movement, then any button
    // edges at their own recorded points. No settling sleep — everything
    // asynchronous the handlers start belongs to the virtual clock and
    // is driven by the frame() eval that follows, which also
    // birth-stamps any transition these events just triggered.
    const ptr = track.pointer[n];
    let cursor: { x: number; y: number; down: boolean; alpha?: number } | null | undefined;
    if (ptr) {
      await worker.session.eval(`window.__sr.setScroll(${y})`);
      const hasUp = ptr.edges?.some((e) => e.kind === 'up') ?? false;
      let wasAt = '';
      if (hasUp) {
        // a recorded click may hit a link. A client-side route change is
        // filmable — the document survives and the frames that follow
        // were recorded on the destination view — but a document load is
        // not (the rest of the samples belong to the page that is now
        // gone), so detect which one happened
        await worker.session.eval('window.__srNavProbe = true').catch(() => {});
        wasAt = await worker.session.eval<string>('location.href').catch(() => '');
      }
      await worker.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(ptr.x),
        y: Math.round(ptr.y),
        button: 'none',
        buttons: ptr.down ? 1 : 0,
      });
      for (const edge of ptr.edges ?? []) {
        await worker.session.send('Input.dispatchMouseEvent', {
          type: edge.kind === 'down' ? 'mousePressed' : 'mouseReleased',
          x: Math.round(edge.x),
          y: Math.round(edge.y),
          button: 'left',
          clickCount: 1,
          buttons: edge.kind === 'down' ? 1 : 0,
        });
      }
      // Wait for the renderer to actually process the moves: the
      // dispatch above acks when the event is QUEUED, and mouse moves
      // are rAF-aligned and coalesced, so under capture load the :hover
      // update (and the mouseenter handlers pages hang off it) trails
      // the dispatch by whole frames — or a short hover coalesces away
      // entirely. The frame must not capture until the hover state
      // belongs to THIS frame's pointer, and any CSS transition it
      // triggers must exist before frame() birth-stamps animations.
      await worker.session.eval(`window.__sr.settlePointer(${Math.round(ptr.x)}, ${Math.round(ptr.y)})`, true, 5_000).catch(() => {});
      if (hasUp) {
        const sameDocument = await worker.session.eval<boolean>('window.__srNavProbe === true').catch(() => false);
        const nowAt = sameDocument ? await worker.session.eval<string>('location.href').catch(() => wasAt) : '';
        if (!sameDocument) {
          // normally caught while planning; reaching here means the page
          // behaved differently under the capture pass's virtual clock
          throw new Error(
            `a recorded click loaded a new document (frame ${n}) — the rest of the recording belongs ` +
              `to the page that just left, so it cannot replay. Split the recording at that click: ` +
              `a "click" step for the navigation, then a second recording on the destination ` +
              `(the extension does this automatically).`,
          );
        }
        if (nowAt !== wasAt) {
          // A client-side route change: the router's transition is
          // content, and the recorded frames that follow were captured on
          // the destination view — which the plan phase settled and
          // pre-warmed when it replayed this same click. Film straight
          // through; the virtual clock drives the transition per frame,
          // and the recorded scroll keeps imposing what the user's own
          // browser did during it. No beginCapture re-arm: the
          // transition's animations are mid-flight on their birth times,
          // same as a soft-navigating click step.
          note(`recorded click routed to ${nowAt} (frame ${n}) — filming the transition`);
          // jump walks supply no real time for the route's fetch/mount —
          // wait it in, same as a soft-navigating click step above
          if (walk === 'jump') await waitForSoftNavigation(worker.session);
        }
      }
      st.pointerAt = y;
      cursor = { x: ptr.x, y: ptr.y, down: ptr.down };
      if (alphas) cursor.alpha = alphas[n];
      st.cursorShown = true;
      st.lastSprite = { x: ptr.x, y: ptr.y, down: ptr.down };
    } else if (st.pointerAt !== null && (Number.isNaN(y) || y !== st.pointerAt)) {
      await parkPointer(worker.session);
      st.pointerAt = null;
      if (st.cursorShown) {
        cursor = null; // hide the drawn cursor along with the real one
        st.cursorShown = false;
      }
    } else if (alphas && st.cursorShown && st.lastSprite) {
      // The sprite is parked (a record step's hold) but its fade-out may
      // be running — keep re-drawing it with this frame's opacity.
      cursor = { ...st.lastSprite, alpha: alphas[n] };
    }
    let png: Buffer;
    try {
      png = await captureFrame(worker.session, y, t, cfg, cursor, capturing);
    } catch (e) {
      if (e instanceof ScrollDrift) {
        if (drift.length < 3) drift.push(`frame ${n}: ${e.message}`);
        // Re-assert and take the frame anyway — one drifted frame is better
        // than no render, and the note tells you it happened.
        await worker.session.eval(`window.__sr.setScroll(${y})`).catch(() => {});
        png = await captureFrame(worker.session, y, t, cfg, cursor, capturing).catch(() => Buffer.alloc(0));
        if (capturing && png.length === 0) throw e;
      } else throw e;
    }
    n++;
    if (!capturing) continue;
    await enc.write(png);
    opts.onCaptured?.();
  }
}

export async function render(cfg: Resolved, chromePath: string, progress: Progress = {}): Promise<{
  frames: number;
  seconds: number;
  outPath: string;
}> {
  const note = (s: string) => progress.onNote?.(s);

  // Worker 0 also does discovery: it resolves the anchors and owns the track, so
  // every shard renders from one identical set of offsets.
  const lead = await startWorker(cfg, chromePath);
  let track: Track;
  try {
    // Interactions are PERFORMED while the track is built — a click that
    // navigates (authored, or inside a recording) has to actually happen
    // before the anchors on the far side of it can resolve. The page is reset
    // before the capture pass below.
    track = await buildTrack(lead.session, cfg, {
      perform: (step, y) => performAction(lead.session, cfg, step, y, note),
      performGesture: (_step, rec) => performRecordedGesture(lead.session, cfg, rec, note),
    });
  } catch (e) {
    lead.conn.close();
    throw e;
  }

  const total = track.offsets.length;
  // Trim (and its degenerate case, single-frame sampling) narrows which frames
  // reach the output; it never changes what any frame CONTAINS. Frame indices
  // stay absolute, so everything time-seeked renders exactly as it would
  // untrimmed.
  let trimmed: { first: number; last: number };
  try {
    if (cfg.frame) {
      const idx = frameIndex(total, cfg.fps, cfg.frame);
      trimmed = { first: idx, last: idx + 1 };
    } else {
      trimmed = trimRange(total, cfg.fps, cfg.trim);
    }
  } catch (e) {
    lead.conn.close();
    throw e;
  }
  const { first: trimFirst, last: trimLast } = trimmed;
  const captureTotal = trimLast - trimFirst;
  const peak = peakStep(track, cfg.dpr);
  const metrics = await lead.session.eval<any>('window.__sr.metrics()').catch(() => null);
  const notes: string[] = [...lead.notes];
  const subs = cfg.page.substitute.length;
  if (subs > 0) notes.push(`substituting ${subs} URL pattern${subs === 1 ? '' : 's'}`);
  if (metrics) {
    const embedNote = (metrics.embeds ?? 0) > 0 ? `, ${metrics.embeds} embed${metrics.embeds === 1 ? '' : 's'}` : '';
    notes.push(`document ${metrics.docHeight}px, ${metrics.videos} video${metrics.videos === 1 ? '' : 's'}${embedNote}, ${metrics.animations} animation${metrics.animations === 1 ? '' : 's'}`);
  }
  // Probe one frame mid-timeline so video/embed problems surface before a long
  // render, not after it. A single-frame sample skips the probe: it costs a
  // full frame render, and the sample itself surfaces the same problems.
  const probeVideos = cfg.page.video === 'sync' && (metrics?.videos ?? 0) > 0;
  const probeEmbeds = cfg.page.embeds === 'sync' && (metrics?.embeds ?? 0) > 0;
  if ((probeVideos || probeEmbeds) && !cfg.frame) {
    try {
      await lead.session.eval(`window.__sr.frame(${track.offsets[0]}, 1, 800)`, true, 20_000);
      if (probeVideos) {
        const report = await lead.session.eval<any[]>('window.__sr.videoReport()');
        for (const v of report ?? []) {
          if (v.ok) continue;
          if (v.seekableRanges === 0) {
            notes.push(`video "${v.src}" reports no seekable range — it may be a live stream, DRM-protected, or still loading. It will show one frozen frame.`);
          } else {
            notes.push(
              `video "${v.src}" would not seek (asked ${Number(v.wanted).toFixed(3)}s, stayed at ${Number(v.currentTime).toFixed(3)}s). ` +
                `The usual cause is a server that ignores HTTP Range requests. Use --video freeze to accept a still frame.`,
            );
          }
        }
      }
      if (probeEmbeds) {
        const report = await lead.session.eval<any[]>('window.__sr.embedReport()');
        const timelineSec = total / cfg.fps;
        for (const e of report ?? []) {
          // A healthy embed shorter than the timeline is the quietest way for a
          // render to look broken: seeks clamp at its duration and it holds its
          // last frame, silently, for the rest of the video. Say so up front.
          if (e.ready && typeof e.duration === 'number' && e.duration > 0 && e.duration < timelineSec - 0.5) {
            notes.push(
              `embed "${e.src}" runs ${e.duration.toFixed(1)}s but the timeline runs ${timelineSec.toFixed(1)}s — ` +
                `it holds its last frame from there on (provider embeds don't loop).`,
            );
          }
          if (e.ok) continue;
          if (!e.controllable) {
            notes.push(`cross-origin iframe "${e.src}" is not a known video provider — it cannot be controlled and will free-run.`);
          } else if (!e.ready) {
            notes.push(`embed "${e.src}" never answered the player API handshake — it will free-run during the render. Use --embeds freeze to pause it.`);
          } else {
            notes.push(
              `embed "${e.src}" would not seek (asked ${Number(e.wanted).toFixed(3)}s, reports ${Number(e.currentTime).toFixed(3)}s) — ` +
                `provider seeking is keyframe-coarse and best-effort.`,
            );
          }
        }
      }
    } catch { /* the probe is advisory; never fail the render on it */ }
  }

  if (cfg.frame) {
    notes.push(
      `sampling frame ${trimFirst} (${(trimFirst / cfg.fps).toFixed(2)}s) of the ` +
        `${(total / cfg.fps).toFixed(2)}s timeline` +
        (cfg.trim.startMs > 0 || cfg.trim.endMs > 0 ? ' — trim does not apply to a sampled frame' : ''),
    );
  } else if (trimFirst > 0 || trimLast < total) {
    notes.push(
      `trim keeps ${(trimFirst / cfg.fps).toFixed(2)}s–${(trimLast / cfg.fps).toFixed(2)}s of the ` +
        `${(total / cfg.fps).toFixed(2)}s timeline (${captureTotal} of ${total} frames)`,
    );
  }

  // A single-frame sample at reduced accuracy: restart at the last
  // document-load boundary at or before the target instead of replaying the
  // timeline from the top. A document load destroys all in-page state, so the
  // destination document's state is URL + storage + cache — populated while
  // the plan was built — plus the actions after the load, which still replay.
  let boundary: ReturnType<typeof segmentStart> = null;
  let walkMode: 'exact' | 'jump' = 'exact';
  if (cfg.frame && cfg.frame.accuracy !== 'exact') {
    let accuracy = cfg.frame.accuracy;
    if (accuracy === 'jump' && cfg.prewarm.mode !== 'full') {
      notes.push(`frame accuracy "jump" needs prewarm "full" — reveal state depends on the scroll path there, so using "segment"`);
      accuracy = 'segment';
    }
    walkMode = accuracy === 'jump' ? 'jump' : 'exact';
    boundary = segmentStart(track, trimFirst);
    if (boundary) {
      notes.push(
        `accuracy ${accuracy}: restarting at ${boundary.url} (frame ${boundary.frame}) — ` +
          `the ${boundary.frame} frames before that document load are skipped`,
      );
    }
  }
  // A segment restart replaces the boundary click's navigation with a direct
  // load of its destination, so the click itself must not fire again.
  const eligibleActions = boundary ? track.actions.filter((_, i) => i !== boundary!.index) : track.actions;

  if (track.sequential) {
    const parts: string[] = [];
    if (track.actions.length > 0) {
      parts.push(`${track.actions.length} interaction${track.actions.length === 1 ? '' : 's'}`);
    }
    const recorded = track.pointer.filter((p) => p !== null).length;
    if (recorded > 0) parts.push(`${recorded} recorded pointer frame${recorded === 1 ? '' : 's'}`);
    notes.push(`timeline has ${parts.join(' and ')} — rendering sequentially`);
  }

  const strobeAt = strobeThreshold(cfg.height, cfg.fps, cfg.dpr);
  if (!cfg.frame && peak > strobeAt * 1.15) {
    notes.push(
      `peak motion ${Math.round(peak)} device px/frame (comfortable limit ~${Math.round(strobeAt)}) — ` +
        `this will read as strobing. Lengthen the fast segments, or raise --fps.`,
    );
  }
  // Provider embeds buffer per worker and seek keyframe-coarse, so a shard
  // boundary can land inside an embed on a different frame than a continuous
  // pass would — take the deterministic single worker over the parallelism.
  let jobs = Math.max(1, Math.min(cfg.jobs, Math.ceil(captureTotal / 15)));
  if (jobs > 1 && cfg.page.embeds === 'sync' && (metrics?.embeds ?? 0) > 0) {
    notes.push(
      `${metrics.embeds} provider embed${metrics.embeds === 1 ? '' : 's'} — rendering with a single worker so ` +
        `provider seeks stay seam-free (--embeds freeze or ignore restores parallelism)`,
    );
    jobs = 1;
  }

  progress.onPlan?.(track.plan, track, notes);

  // The build pass executed the interactions, so the page is wherever the last
  // click left it — reset to the configured URL (or, for a reduced-accuracy
  // frame sample, straight to its segment's document) for the capture pass.
  if (track.sequential) {
    note(boundary ? `resetting to ${boundary.url} for the capture pass` : 'resetting the page for the capture pass');
    for (const n of await resetPage(lead.session, cfg, boundary?.url)) note(n);
  }

  mkdirSync(dirname(cfg.outPath) || '.', { recursive: true });

  const tmp = join(tmpdir(), `tapeworm-${process.pid}`);
  mkdirSync(tmp, { recursive: true });

  const workers: Worker[] = [lead];
  if (jobs > 1) {
    note(`starting ${jobs - 1} more browser${jobs === 2 ? '' : 's'}`);
    const extra = await Promise.all(
      Array.from({ length: jobs - 1 }, () => startWorker(cfg, chromePath)),
    );
    workers.push(...extra);
  }

  // Contiguous ranges over the kept frames, so each shard's ffmpeg segment is
  // a valid clip on its own.
  const per = Math.ceil(captureTotal / jobs);
  const ranges = workers
    .map((_, i) => [trimFirst + i * per, Math.min(trimFirst + (i + 1) * per, trimLast)] as const)
    .filter(([a, b]) => a < b);

  // A path-dependent render (interactions, a recording, prewarm cache/none —
  // all single-job) can't jump straight to the first kept frame: frame N shows
  // what the frames before it did to the page. Its one shard walks the
  // trimmed-off head too — input dispatched, scroll imposed, virtual clock
  // advanced — and only skips the screenshot/encode there. (A segment restart
  // narrows the head to the boundary's document.)
  const pathDependent = track.sequential || cfg.prewarm.mode !== 'full';

  let done = 0;
  const started = Date.now();
  const segments: string[] = [];
  const drift: string[] = [];

  // Opt-in cursor fade: one opacity per frame, precomputed from the track so
  // it stays a pure function of the frame index like everything else.
  const fadeSec = cfg.page.cursor === false ? 0 : cfg.page.cursor.fade;
  const alphas = fadeSec > 0 ? cursorAlphas(track, cfg.fps, fadeSec) : null;

  try {
    await Promise.all(
      ranges.map(async ([from, to], shard) => {
        const worker = workers[shard];
        const isPng = cfg.codec === 'png';
        const segPath = join(tmp, `seg${String(shard).padStart(2, '0')}.mp4`);
        const enc: Encoder = cfg.frame
          ? createPngFileWriter(cfg.outPath) // one sampled frame = one file, not a sequence directory
          : isPng
            ? createPngWriter(cfg.outPath, from - trimFirst)
            : createEncoder(segPath, cfg);
        if (!isPng) segments[shard] = segPath;
        const walkFrom = shard === 0 && pathDependent ? (boundary ? boundary.frame : 0) : from;
        await worker.session.eval(`window.__sr.beginCapture(${cfg.page.replayIntro})`).catch(() => {});
        // Bounded wait for provider-embed handshakes plus one priming seek to
        // this shard's first CAPTURED frame (the walk no longer seeks embeds,
        // so the walked head shouldn't prime a stale time). Instant no-op when
        // the page has no embeds; the caps keep it far under captureFrame's
        // eval timeout.
        await worker.session.eval(`window.__sr.embedsReady(4000, ${from / cfg.fps})`, true, 8_000).catch(() => {});

        await captureRange(worker, {
          cfg,
          track,
          walkFrom,
          from,
          to,
          actions: eligibleActions,
          walk: walkMode,
          enc,
          alphas,
          note,
          drift,
          onCaptured: () => {
            done++;
            progress.onFrame?.(done, captureTotal);
          },
        });
        await enc.finish();
      }),
    );

    if (cfg.codec !== 'png') {
      await concatSegments(segments.filter(Boolean), cfg.outPath, tmp);
    }
  } finally {
    for (const w of workers) w.conn.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  for (const d of drift) note(d);
  if (drift.length) note('scroll drift usually means scroll-snap, scroll anchoring, or a smooth-scroll library — see README');

  return { frames: captureTotal, seconds: (Date.now() - started) / 1000, outPath: cfg.outPath };
}

export type FrameServer = {
  /** Render the frame at `spec` into cfg.outPath, reusing page state when it can. */
  render(spec: { sec?: number; pct?: number }): Promise<{ index: number; total: number; seconds: number }>;
  /** Tear down and rebuild against a changed config: new browser, new plan. */
  reload(next: Resolved): Promise<void>;
  close(): void;
};

/**
 * Watch mode's engine: keep Chrome and the built track alive so repeated
 * single-frame peeks stop repaying launch + navigate + prewarm + plan every
 * time. A peek AHEAD of the last one on the same document epoch walks forward
 * incrementally from where the page already stands; a peek behind (or after an
 * error, when the page state is unknown) resets — to the segment boundary when
 * the config's frame accuracy allows, else to the top. Frame accuracy and the
 * walk mode come from cfg.frame, exactly as a one-shot --frame render would
 * use them.
 */
export async function openFrameServer(cfg: Resolved, chromePath: string, progress: Progress = {}): Promise<FrameServer> {
  const note = (s: string) => progress.onNote?.(s);

  type Epoch = {
    cfg: Resolved;
    worker: Worker;
    track: Track;
    alphas: number[] | null;
    pathDependent: boolean;
    /** Frame the page currently embodies, or null when unknown (fresh, or after an error). */
    pos: number | null;
    /** Index of the boundary action the current document epoch withholds, or null. */
    excluded: number | null;
    st: RangeState;
    armed: boolean;
  };

  async function setUp(c: Resolved): Promise<Epoch> {
    const worker = await startWorker(c, chromePath);
    let track: Track;
    try {
      track = await buildTrack(worker.session, c, {
        perform: (step, y) => performAction(worker.session, c, step, y, note),
        performGesture: (_step, rec) => performRecordedGesture(worker.session, c, rec, note),
      });
    } catch (e) {
      worker.conn.close();
      throw e;
    }
    progress.onPlan?.(track.plan, track, [...worker.notes]);
    mkdirSync(dirname(c.outPath) || '.', { recursive: true });
    const fadeSec = c.page.cursor === false ? 0 : c.page.cursor.fade;
    return {
      cfg: c,
      worker,
      track,
      alphas: fadeSec > 0 ? cursorAlphas(track, c.fps, fadeSec) : null,
      pathDependent: track.sequential || c.prewarm.mode !== 'full',
      pos: null,
      excluded: null,
      st: freshRangeState(),
      armed: false,
    };
  }

  let ep = await setUp(cfg);

  async function renderFrame(spec: { sec?: number; pct?: number }): Promise<{ index: number; total: number; seconds: number }> {
    const c = ep.cfg;
    const started = Date.now();
    const total = ep.track.offsets.length;
    const idx = frameIndex(total, c.fps, spec);
    const accuracy = c.frame?.accuracy ?? 'exact';
    const drift: string[] = [];
    const enc = createPngFileWriter(c.outPath);

    try {
      let walkFrom = idx;
      let walk: 'exact' | 'jump' = 'exact';
      let actions = ep.track.actions;

      if (!ep.pathDependent) {
        // Frames are independent — every peek is a straight jump.
        if (!ep.armed) {
          await ep.worker.session.eval(`window.__sr.beginCapture(${c.page.replayIntro})`).catch(() => {});
          ep.armed = true;
        }
      } else {
        const boundary = accuracy !== 'exact' ? segmentStart(ep.track, idx) : null;
        // Forward on the same walk is cheapest; reset when going backwards,
        // when state is unknown, or when a document-load boundary lets the
        // walk skip further ahead than the page already is.
        const incremental = ep.pos !== null && idx > ep.pos && !(boundary && boundary.frame > ep.pos);
        if (incremental) {
          walkFrom = ep.pos! + 1;
        } else {
          note(boundary ? `resetting to ${boundary.url} (frame ${boundary.frame})` : 'resetting the page');
          for (const s of await resetPage(ep.worker.session, c, boundary?.url)) note(s);
          ep.st = freshRangeState();
          ep.excluded = boundary ? boundary.index : null;
          await ep.worker.session.eval(`window.__sr.beginCapture(${c.page.replayIntro})`).catch(() => {});
          walkFrom = boundary ? boundary.frame : 0;
        }
        walk = accuracy === 'jump' && c.prewarm.mode === 'full' ? 'jump' : 'exact';
        actions = ep.excluded !== null ? ep.track.actions.filter((_, i) => i !== ep.excluded) : ep.track.actions;
      }

      await ep.worker.session.eval(`window.__sr.embedsReady(4000, ${idx / c.fps})`, true, 8_000).catch(() => {});
      await captureRange(ep.worker, {
        cfg: c,
        track: ep.track,
        walkFrom,
        from: idx,
        to: idx + 1,
        actions,
        walk,
        enc,
        alphas: ep.alphas,
        note,
        drift,
        state: ep.st,
      });
      await enc.finish();
      if (ep.pathDependent) ep.pos = idx;
      for (const d of drift) note(d);
      return { index: idx, total, seconds: (Date.now() - started) / 1000 };
    } catch (e) {
      ep.pos = null; // page state is unknown now — the next peek resets first
      await enc.finish().catch(() => {});
      throw e;
    }
  }

  return {
    render: renderFrame,
    async reload(next) {
      ep.worker.conn.close();
      ep = await setUp(next);
    },
    close() {
      ep.worker.conn.close();
    },
  };
}
