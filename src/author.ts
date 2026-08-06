/**
 * `tapeworm author` — headful Chrome with the render's exact flags, viewport,
 * and injected runtime, hosting the SAME overlay files the extension ships.
 *
 * This is the WYSIWYG reference: the page is in precisely the state a render
 * would see (emulated viewport, runtime hygiene, intro handling), so when the
 * extension's picker and the renderer disagree, this says which is right.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { launch } from './browser.ts';
import type { Session } from './cdp.ts';
import { openPage, prewarm, settleNewDocument, waitForDocumentReady } from './page.ts';
import type { Config, Resolved, Step } from './types.ts';

type PickedEvent = {
  anchor: { selector: string; nth?: number; fallbackText?: string };
  quality: 'id' | 'data' | 'class' | 'structural';
  unique: boolean;
  resolvedY: number | null;
};

export type AuthorCallbacks = {
  onNote?(note: string): void;
  onPicked?(step: Step, ev: PickedEvent): void;
};

const OVERLAY_PATH = new URL('../extension/content/overlay.js', import.meta.url);

export async function author(
  cfg: Resolved,
  chromePath: string,
  outPath: string | null,
  cb: AuthorCallbacks = {},
): Promise<{ config: Config; outPath: string | null }> {
  const note = (s: string) => cb.onNote?.(s);

  const conn = launch({ chromePath, headful: true });
  const steps: Step[] = [{ type: 'start', at: 'top', hold: 0.8 }];
  let resumeRecording = false; // a navigation split a take — restart on the new document

  try {
    const { session, notes } = await openPage(conn, cfg);
    for (const n of notes) note(n);

    // Prewarm exactly as the render does. Without it, elements sit where their
    // un-fired reveal transforms put them, and every anchor resolves to a page
    // state the render will never see.
    for (const n of await prewarm(session, cfg)) note(n);

    await session.send('Runtime.addBinding', { name: '__twAuthor' });
    session.on('Runtime.bindingCalled', (p: any) => {
      if (p.name !== '__twAuthor') return;
      let msg: { type: string; data: any };
      try { msg = JSON.parse(p.payload); } catch { return; }
      if (msg.type === 'picker:picked') {
        const ev = msg.data as PickedEvent;
        const step: Step = { type: 'move', to: ev.anchor, ease: 'natural' };
        steps.push(step);
        cb.onPicked?.(step, ev);
      }
      if (msg.type === 'picker:stopped') note('picker paused (press p to resume)');
      if (msg.type === 'record:done') {
        const d = msg.data;
        const step: Step = { type: 'record', samples: d.samples, viewport: d.viewport };
        if (d.buttons?.length) step.buttons = d.buttons;
        steps.push(step);
        note(`recorded ${(d.durationMs / 1000).toFixed(1)}s of interaction (${d.samples.t.length} samples)`);
      }
      if (msg.type === 'record:split') {
        // A recorded click loaded a new document. The overlay split the take
        // at that click; land it as record → click, and let the load handler
        // below resume the recording on the destination.
        const d = msg.data;
        if (d.take) {
          const step: Step = { type: 'record', samples: d.take.samples, viewport: d.take.viewport };
          if (d.take.buttons?.length) step.buttons = d.take.buttons;
          steps.push(step);
        }
        steps.push({ type: 'click', target: d.click.anchor });
        resumeRecording = true;
        note('a recorded click navigated — split the take at the click; recording resumes on the destination');
      }
      if (msg.type === 'record:cancelled') note('recording cancelled (nothing captured)');
      if (msg.type === 'page:info' && msg.data?.scrollGated) {
        note('this page gates scrolling behind an intro — scroll manually in the window to unlock it');
      }
    });

    // The shared core is already in the page (the runtime injects it); add the
    // overlay on top and wire its events to the binding.
    const overlaySrc = readFileSync(OVERLAY_PATH, 'utf8');
    const bootOverlay = `
      TapewormOverlay.mount((type, data) => __twAuthor(JSON.stringify({ type, data })));
      TapewormOverlay.setSettings(${JSON.stringify({ width: cfg.width, height: cfg.height, dpr: cfg.dpr, fps: cfg.fps })});
    `;
    await session.eval(overlaySrc);
    await session.eval(bootOverlay + 'TapewormOverlay.startPicker();');

    // A navigation during authoring (a recorded click, or plain browsing)
    // tears the overlay down with the document — put it back on the new one.
    // A recording the navigation just split resumes immediately, before the
    // user's pointer goes cold; otherwise the destination is settled and
    // pre-warmed like a render would, and the picker returns.
    let reattaching = false; // prewarm 'cache' reloads mid-reattach — don't recurse on its load event
    session.on('Page.loadEventFired', () => {
      if (reattaching) return;
      reattaching = true;
      void (async () => {
        await waitForDocumentReady(session);
        const resume = resumeRecording;
        resumeRecording = false;
        if (!resume) {
          for (const n of await settleNewDocument(session, cfg)) note(n);
          for (const n of await prewarm(session, cfg)) note(n);
        }
        await session.eval(overlaySrc);
        await session.eval(bootOverlay);
        if (resume) {
          await session.eval('TapewormOverlay.startRecording()');
          note('recording resumed on the destination — press ESC in the browser window to stop');
        } else {
          await session.eval('TapewormOverlay.startPicker()');
        }
      })()
        .catch(() => { /* the window may have closed mid-flight */ })
        .finally(() => { reattaching = false; });
    });

    note('pick elements in the browser window. p = toggle picker, r = record until ESC, u = undo last, w = write config, q = quit');

    await interact(session, steps, note, () => writeConfig(cfg, steps, outPath, note));
  } finally {
    conn.close();
  }

  return { config: buildConfig(cfg, steps), outPath };
}

function buildConfig(cfg: Resolved, steps: Step[]): Config {
  return {
    url: cfg.url,
    viewport: { width: cfg.width, height: cfg.height, dpr: cfg.dpr },
    fps: cfg.fps,
    timeline: steps,
    meta: {
      authoredWith: 'tapeworm-author/0.1.0',
      authoredAt: new Date().toISOString(),
      authoredViewport: { width: cfg.width, height: cfg.height, dpr: cfg.dpr },
      url: cfg.url,
    },
  };
}

function writeConfig(cfg: Resolved, steps: Step[], outPath: string | null, note: (s: string) => void): void {
  const json = JSON.stringify(buildConfig(cfg, steps), null, 2) + '\n';
  if (outPath) {
    writeFileSync(outPath, json);
    note(`wrote ${outPath} (${steps.length} steps)`);
  } else {
    process.stdout.write('\n' + json);
  }
}

/**
 * Terminal loop: keys drive the session, and the browser window closing (or q,
 * or Ctrl+C) ends it. The config is written on every change of heart — w — and
 * once at the end.
 */
function interact(
  session: Session,
  steps: Step[],
  note: (s: string) => void,
  write: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let pickerOn = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      write();
      resolve();
    };

    const onKey = (chunk: Buffer) => {
      const k = chunk.toString();
      if (k === 'q' || k === '' /* Ctrl+C */) { finish(); return; }
      if (k === 'w') { write(); return; }
      if (k === 'u') {
        if (steps.length > 1) {
          const dropped = steps.pop() as Step;
          note(`removed ${dropped.type === 'move' ? describeTarget(dropped) : dropped.type}`);
        }
        return;
      }
      if (k === 'p') {
        pickerOn = !pickerOn;
        session.eval(`TapewormOverlay.${pickerOn ? 'startPicker' : 'stopPicker'}()`).catch(() => {});
        note(pickerOn ? 'picker on' : 'picker off');
      }
      if (k === 'r') {
        // startRecording stops the picker itself; ESC in the BROWSER window ends it
        pickerOn = false;
        session.eval('TapewormOverlay.startRecording()').catch(() => {});
        note('recording — interact with the page, press ESC in the browser window to stop');
      }
    };

    const hadRaw = process.stdin.isTTY && process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    session.conn.on('disconnected', finish);
    process.on('SIGINT', finish);

    function cleanup() {
      process.stdin.off('data', onKey);
      if (process.stdin.isTTY && !hadRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.off('SIGINT', finish);
    }
  });
}

function describeTarget(step: Step & { type: 'move' }): string {
  const t = step.to;
  return typeof t === 'object' ? t.selector : String(t);
}
