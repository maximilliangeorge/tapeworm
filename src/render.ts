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
import { openPage, prewarm } from './page.ts';
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

/** Capture one frame. Returns the PNG bytes. */
async function captureFrame(session: Session, y: number, tSec: number, cfg: Resolved): Promise<Buffer> {
  const result = await session.eval<any>(
    `window.__sr.frame(${y}, ${tSec}, ${cfg.prewarm.imageBudget})`,
    true,
    Math.max(20_000, cfg.prewarm.imageBudget + 15_000),
  );

  // Chrome stores scroll offsets on the device-pixel grid; anything beyond that is
  // the page fighting us (scroll anchoring, snap, a hijacker we missed).
  if (result && Math.abs(result.actual - result.requested) > 1 / cfg.dpr + 0.001) {
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
 */
async function performAction(session: Session, step: Step & { type: 'click' | 'hover' }, y: number): Promise<void> {
  await session.eval(`window.__sr.setScroll(${y})`);
  const target = step.target as { selector: string; nth?: number };
  const pt = await session.eval<{ found: boolean; x: number; y: number; visible: boolean }>(
    `window.__sr.actionPoint(${JSON.stringify(target)})`,
  );
  if (!pt?.found) {
    throw new Error(`cannot ${step.type} "${target.selector}": selector matched nothing at that point in the timeline`);
  }
  const at = { x: Math.round(pt.x), y: Math.round(pt.y) };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  if (step.type === 'click') {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
  }
  // give the page's handlers a beat of real time; the animations they start are
  // then driven per-frame by the virtual clock like everything else
  await new Promise((r) => setTimeout(r, 80));
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
    track = await buildTrack(lead.session, cfg);
  } catch (e) {
    lead.conn.close();
    throw e;
  }

  const total = track.offsets.length;
  const peak = peakStep(track, cfg.dpr);
  const metrics = await lead.session.eval<any>('window.__sr.metrics()').catch(() => null);
  const notes: string[] = [...lead.notes];
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
    notes.push(`timeline has ${track.actions.length} interaction${track.actions.length === 1 ? '' : 's'} — rendering sequentially`);
  }

  const strobeAt = strobeThreshold(cfg.height, cfg.fps, cfg.dpr);
  if (peak > strobeAt * 1.15) {
    notes.push(
      `peak motion ${Math.round(peak)} device px/frame (comfortable limit ~${Math.round(strobeAt)}) — ` +
        `this will read as strobing. Lengthen the fast segments, or raise --fps.`,
    );
  }
  progress.onPlan?.(track.plan, track, notes);

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

        for (let n = from; n < to; n++) {
          const y = track.offsets[n];
          const t = n / cfg.fps;
          for (const action of track.actions) {
            if (action.frame !== n) continue;
            await performAction(worker.session, action.step as Step & { type: 'click' | 'hover' }, y);
          }
          let png: Buffer;
          try {
            png = await captureFrame(worker.session, y, t, cfg);
          } catch (e) {
            if (e instanceof ScrollDrift) {
              if (drift.length < 3) drift.push(`frame ${n}: ${e.message}`);
              // Re-assert and take the frame anyway — one drifted frame is better
              // than no render, and the note tells you it happened.
              await worker.session.eval(`window.__sr.setScroll(${y})`).catch(() => {});
              png = await captureFrame(worker.session, y, t, cfg).catch(() => Buffer.alloc(0));
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
