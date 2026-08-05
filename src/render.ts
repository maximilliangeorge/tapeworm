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
import { concatSegments, createEncoder, createPngWriter, type Encoder } from './encode.ts';
import { openPage, prewarm, resetPage, settleNewDocument, waitForDocumentReady, waitForSoftNavigation } from './page.ts';
import { strobeThreshold } from './easing.ts';
import { buildTrack, peakStep, type Track } from './timeline.ts';
import type { Resolved, Step } from './types.ts';

export type Progress = {
  onPlan?(plan: string[], track: Track, notes: string[]): void;
  onFrame?(done: number, total: number): void;
  onNote?(note: string): void;
};

type Worker = { conn: Connection; session: Session; notes: string[] };

async function startWorker(cfg: Resolved, chromePath: string): Promise<Worker> {
  const conn = launch({ chromePath, headful: cfg.headful });
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
 */
async function captureFrame(
  session: Session,
  y: number,
  tSec: number,
  cfg: Resolved,
  cursor?: { x: number; y: number; down: boolean } | null,
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
): Promise<{ navigated: boolean; sameDocument: boolean; waitedMs?: number }> {
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
  if (sameDocument) {
    waitedMs = await waitForSoftNavigation(session);
    note(
      `${step.type} on ${target.selector} routed to ${nowAt} without a page load ` +
        `(waited ${(waitedMs / 1000).toFixed(1)}s for the new view) — settling and pre-warming`,
    );
  } else {
    await waitForDocumentReady(session);
    const where = await session.eval<string>('location.href').catch(() => '(unknown)');
    note(`${step.type} on ${target.selector} navigated to ${where} — settling and pre-warming`);
  }
  for (const n of await settleNewDocument(session, cfg)) note(n);
  for (const n of await prewarm(session, cfg)) note(n);
  return { navigated: true, sameDocument, waitedMs };
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
    // navigates has to actually happen before the anchors on the far side of
    // it can resolve. The page is reset before the capture pass below.
    track = await buildTrack(lead.session, cfg, {
      perform: (step, y) => performAction(lead.session, cfg, step, y, note),
    });
  } catch (e) {
    lead.conn.close();
    throw e;
  }

  const total = track.offsets.length;
  const peak = peakStep(track, cfg.dpr);
  const metrics = await lead.session.eval<any>('window.__sr.metrics()').catch(() => null);
  const notes: string[] = [...lead.notes];
  const subs = cfg.page.substitute.length;
  if (subs > 0) notes.push(`substituting ${subs} URL pattern${subs === 1 ? '' : 's'}`);
  if (metrics) {
    notes.push(`document ${metrics.docHeight}px, ${metrics.videos} video${metrics.videos === 1 ? '' : 's'}, ${metrics.animations} animation${metrics.animations === 1 ? '' : 's'}`);
  }
  // Probe one frame mid-timeline so video problems surface before a long render,
  // not after it.
  if (cfg.page.video === 'sync' && (metrics?.videos ?? 0) > 0) {
    try {
      await lead.session.eval(`window.__sr.frame(${track.offsets[0]}, 1, 800)`, true, 20_000);
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
    } catch { /* the probe is advisory; never fail the render on it */ }
  }

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
  if (peak > strobeAt * 1.15) {
    notes.push(
      `peak motion ${Math.round(peak)} device px/frame (comfortable limit ~${Math.round(strobeAt)}) — ` +
        `this will read as strobing. Lengthen the fast segments, or raise --fps.`,
    );
  }
  progress.onPlan?.(track.plan, track, notes);

  // The build pass executed the interactions, so the page is wherever the last
  // click left it — reset to the configured URL for the capture pass.
  if (track.sequential) {
    note('resetting the page for the capture pass');
    for (const n of await resetPage(lead.session, cfg)) note(n);
  }

  const jobs = Math.max(1, Math.min(cfg.jobs, Math.ceil(total / 15)));
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

  // Contiguous ranges, so each shard's ffmpeg segment is a valid clip on its own.
  const per = Math.ceil(total / jobs);
  const ranges = workers.map((_, i) => [i * per, Math.min((i + 1) * per, total)] as const).filter(([a, b]) => a < b);

  let done = 0;
  const started = Date.now();
  const segments: string[] = [];
  const drift: string[] = [];

  try {
    await Promise.all(
      ranges.map(async ([from, to], shard) => {
        const worker = workers[shard];
        const isPng = cfg.codec === 'png';
        const segPath = join(tmp, `seg${String(shard).padStart(2, '0')}.mp4`);
        const enc: Encoder = isPng
          ? createPngWriter(cfg.outPath, from)
          : createEncoder(segPath, cfg);
        if (!isPng) segments[shard] = segPath;
        await worker.session.eval(`window.__sr.beginCapture(${cfg.page.replayIntro})`).catch(() => {});

        // Scroll offset the pointer is sitting at after an interaction or a
        // recorded frame, or null when it's parked. The pointer stays put
        // while the offset holds (its hover/active state on the target is part
        // of the shot) and is parked the moment the scroll moves — including
        // onto free frames, where the router sweeps the page under it
        // mid-transition. Chrome re-computes :hover from the last pointer
        // position on every scroll, so a stale point would smear hover states
        // across whatever passes under it.
        let pointerAt: number | null = null;
        let cursorShown = false;
        for (let n = from; n < to; n++) {
          const y = track.offsets[n];
          const t = n / cfg.fps;
          for (const action of track.actions) {
            if (action.frame !== n) continue;
            // action.at, not y: the interaction fires from where the timeline
            // stood BEFORE it, which differs from this frame's offset whenever
            // the interaction navigates.
            const r = await performAction(worker.session, cfg, action.step as Step & { type: 'click' | 'hover' }, action.at, note, 'capture');
            pointerAt = action.at;
            if (r.navigated && !r.sameDocument) {
              // brand-new document: fresh runtime, fresh animation state. A
              // soft navigation keeps the document — and must NOT re-arm: the
              // transition's animations are mid-flight on their birth times.
              await worker.session.eval(`window.__sr.beginCapture(${cfg.page.replayIntro})`).catch(() => {});
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
          let cursor: { x: number; y: number; down: boolean } | null | undefined;
          if (ptr) {
            await worker.session.eval(`window.__sr.setScroll(${y})`);
            const hasUp = ptr.edges?.some((e) => e.kind === 'up') ?? false;
            let wasAt = '';
            if (hasUp) {
              // a recorded click may hit a link; navigation mid-recording is
              // not replayable (the rest of the samples belong to the page
              // that is now gone), so detect it and say what to do instead
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
            // Force a style recalc NOW, so any CSS transition the input just
            // triggered (:hover in or out) exists before frame() birth-stamps
            // animations — otherwise its creation races the first
            // seekAnimations and the birth can land a frame late.
            await worker.session.eval('void (document.body && document.body.offsetHeight)').catch(() => {});
            if (hasUp) {
              const sameDocument = await worker.session.eval<boolean>('window.__srNavProbe === true').catch(() => false);
              const nowAt = sameDocument ? await worker.session.eval<string>('location.href').catch(() => wasAt) : '';
              if (!sameDocument || nowAt !== wasAt) {
                throw new Error(
                  `a recorded click navigated (frame ${n}) — recorded clicks that navigate aren't replayable, ` +
                    `because the rest of the recording belongs to the page that just left. ` +
                    `Use a "click" step for the navigation, then record on the destination.`,
                );
              }
            }
            pointerAt = y;
            cursor = { x: ptr.x, y: ptr.y, down: ptr.down };
            cursorShown = true;
          } else if (pointerAt !== null && (Number.isNaN(y) || y !== pointerAt)) {
            await parkPointer(worker.session);
            pointerAt = null;
            if (cursorShown) {
              cursor = null; // hide the drawn cursor along with the real one
              cursorShown = false;
            }
          }
          let png: Buffer;
          try {
            png = await captureFrame(worker.session, y, t, cfg, cursor);
          } catch (e) {
            if (e instanceof ScrollDrift) {
              if (drift.length < 3) drift.push(`frame ${n}: ${e.message}`);
              // Re-assert and take the frame anyway — one drifted frame is better
              // than no render, and the note tells you it happened.
              await worker.session.eval(`window.__sr.setScroll(${y})`).catch(() => {});
              png = await captureFrame(worker.session, y, t, cfg, cursor).catch(() => Buffer.alloc(0));
              if (png.length === 0) throw e;
            } else throw e;
          }
          await enc.write(png);
          done++;
          progress.onFrame?.(done, total);
        }
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

  return { frames: total, seconds: (Date.now() - started) / 1000, outPath: cfg.outPath };
}
