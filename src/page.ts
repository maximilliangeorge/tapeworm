/** Opening a page and getting it into a state worth filming. */

import type { Connection, Session } from './cdp.ts';
import { newPage } from './cdp.ts';
import { runtimeSource } from './runtime.ts';
import { fulfillFromFile, isUrl, wildcardToRegExp } from './substitute.ts';
import type { Resolved } from './types.ts';

export type OpenResult = { session: Session; notes: string[] };

/**
 * Asset substitution via the Fetch domain — what DevTools "local overrides"
 * uses. A remote replacement is a continueRequest with a rewritten URL: Chrome
 * re-issues the request (Range headers intact, which video seeking needs) and
 * the page can't observe the switch. A local file is a fulfillRequest served
 * from disk — a URL rewrite can't work there, because Chrome refuses the
 * secure→insecure downgrade any https page → local http server rewrite would
 * be. Fetch.enable is per-session and survives navigation, so the prewarm
 * sweep, 'cache'-mode reloads, and navigating clicks all stay covered.
 * Substitution is a pure function of the URL — no wall-clock or frame-order
 * dependence — so it doesn't break sharding.
 */
async function enableSubstitution(session: Session, subs: Resolved['page']['substitute']): Promise<void> {
  const rules = subs.map((s) => ({ re: wildcardToRegExp(s.from), to: s.to, local: !isUrl(s.to) }));
  session.on('Fetch.requestPaused', (p: { requestId: string; request: { url: string; headers: Record<string, string> } }) => {
    // fire-and-forget throughout: awaiting would serialise paused requests behind us
    const send = (method: string, params: object) => session.send(method, params).catch(() => {});
    const hit = rules.find((r) => r.re.test(p.request.url));
    if (!hit) {
      send('Fetch.continueRequest', { requestId: p.requestId });
    } else if (!hit.local) {
      send('Fetch.continueRequest', { requestId: p.requestId, url: hit.to });
    } else {
      const range = Object.entries(p.request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      fulfillFromFile(hit.to, range).then(
        (f) => send('Fetch.fulfillRequest', { requestId: p.requestId, ...f }),
        // unreadable file (deleted since config time?) — let the real asset through
        () => send('Fetch.continueRequest', { requestId: p.requestId }),
      );
    }
  });
  await session.send('Fetch.enable', { patterns: subs.map((s) => ({ urlPattern: s.from })) });
}

export async function openPage(conn: Connection, cfg: Resolved): Promise<OpenResult> {
  const session = await newPage(conn);
  const notes: string[] = [];

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
  if (cfg.page.substitute.length > 0) await enableSubstitution(session, cfg.page.substitute);

  // deviceScaleFactor here sizes the screenshots (Page.captureScreenshot honours
  // the emulation override). The launch flag --force-device-scale-factor carries
  // the SAME value — the window's real scale must match the emulated one, or
  // Chrome's hover re-evaluation on layout change hit-tests the stored mouse
  // position across the two scales and hovers the wrong element (see launch()).
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: cfg.dpr,
    mobile: false,
  });
  await session.send('Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // Default to no-preference: emulating 'reduce' also kills the scroll reveals and
  // parallax you're usually trying to film.
  await session
    .send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    .catch(() => {});

  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: runtimeSource(cfg) });
  if (cfg.page.script) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: cfg.page.script });
  }

  await navigate(session, cfg.url);
  if (cfg.page.settle > 0) await sleep(cfg.page.settle);

  if (cfg.page.waitForIntro > 0) {
    const waited = await waitForAnimationsIdle(session, cfg.page.waitForIntro);
    if (waited.ms > 400) {
      notes.push(
        waited.idle
          ? `waited ${(waited.ms / 1000).toFixed(1)}s for intro animations to finish`
          : `intro animations still running after ${(waited.ms / 1000).toFixed(1)}s — filming anyway (raise page.waitForIntro, or they may be infinite)`,
      );
    }
  }

  await session.eval('window.__sr && window.__sr.setMode("live")').catch(() => {});

  if (cfg.page.dismissConsent) {
    // Banners often arrive a beat after load, so try twice.
    for (const wait of [0, 700]) {
      if (wait) await sleep(wait);
      const hit = await session.eval<boolean>('window.__sr.dismissConsent()').catch(() => false);
      if (hit) { notes.push('dismissed a consent dialog'); break; }
    }
  }

  if (cfg.page.unlockIntro.enabled) {
    const un = await unlockScroll(session, cfg);
    if (un.ticks > 0) {
      notes.push(
        un.unlocked
          ? `unlocked a scroll-gated intro with ${un.ticks} wheel ticks (document went ${un.before}px -> ${un.after}px)`
          : `document still not scrollable after ${un.ticks} wheel ticks — the page may hijack scrolling entirely`,
      );
    }
  }

  const hijackers = await session.eval<string[]>('window.__sr.neutraliseHijackers()').catch(() => []);
  if (hijackers?.length) notes.push(`neutralised ${hijackers.join(', ')}`);

  return { session, notes };
}

/**
 * The parts of openPage that must re-run whenever the DOCUMENT changes — after
 * a click that navigates, or after resetting for the capture pass. The injected
 * runtime re-arrives on its own (Page.addScriptToEvaluateOnNewDocument), but
 * intros, consent, scroll gates, and hijackers are all per-document state.
 */
export async function settleNewDocument(session: Session, cfg: Resolved): Promise<string[]> {
  const notes: string[] = [];
  if (cfg.page.settle > 0) await sleep(cfg.page.settle);
  if (cfg.page.waitForIntro > 0) await waitForAnimationsIdle(session, cfg.page.waitForIntro);
  await session.eval('window.__sr && window.__sr.setMode("live")').catch(() => {});
  if (cfg.page.dismissConsent) {
    const hit = await session.eval<boolean>('window.__sr.dismissConsent()').catch(() => false);
    if (hit) notes.push('dismissed a consent dialog');
  }
  if (cfg.page.unlockIntro.enabled) await unlockScroll(session, cfg).catch(() => null);
  const hijackers = await session.eval<string[]>('window.__sr.neutraliseHijackers()').catch(() => []);
  if (hijackers?.length) notes.push(`neutralised ${hijackers.join(', ')}`);
  return notes;
}

/** Poll until the (possibly brand-new) document is loaded and the runtime answers. */
export async function waitForDocumentReady(session: Session, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await session
      .eval<boolean>('document.readyState === "complete" && !!window.__sr')
      .catch(() => false); // context torn down mid-navigation — keep polling
    if (ready) return;
    await sleep(200);
  }
}

/**
 * Wait out a soft navigation — a router swapping the view with the History API
 * rather than loading a document.
 *
 * There is no lifecycle event to wait on and readyState is already 'complete',
 * so the only signal that the destination has arrived is the DOM going quiet.
 * Routers commonly animate the outgoing view out, sit still for a beat, and
 * only then mount the new one, so a short quiet threshold returns *during* that
 * gap — before the content the next anchor needs exists. 750ms clears the gaps
 * seen in the wild and still costs less than the settle that follows.
 *
 * Mutations are counted in the page but timed HERE: the injected runtime owns
 * `performance.now`/`Date`, and during the capture pass those are frozen at the
 * current frame, so page-side elapsed time would never advance.
 */
export const SOFT_NAV_QUIET_MS = 750;

export async function waitForSoftNavigation(session: Session, timeoutMs = 15_000): Promise<number> {
  const poll = 150;
  const needed = SOFT_NAV_QUIET_MS / poll;
  await session.eval(`(() => {
    if (window.__srQuiet) window.__srQuiet.stop();
    const state = { n: 0 };
    const obs = new MutationObserver((rs) => { state.n += rs.length; });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    state.stop = () => obs.disconnect();
    window.__srQuiet = state;
  })()`).catch(() => {});

  const started = Date.now();
  let last = -1;
  let quiet = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(poll);
    const n = await session.eval<number>('window.__srQuiet ? window.__srQuiet.n : -1').catch(() => -1);
    if (n >= 0 && n === last) {
      if (++quiet >= needed) break;
    } else {
      quiet = 0;
    }
    last = n;
  }
  await session.eval('window.__srQuiet && window.__srQuiet.stop()').catch(() => {});
  return Date.now() - started;
}

/**
 * Return to the configured URL — or a segment boundary a reduced-accuracy
 * frame sample restarts from — and get the page back into a filmable state.
 */
export async function resetPage(session: Session, cfg: Resolved, url = cfg.url): Promise<string[]> {
  await navigate(session, url);
  const notes = await settleNewDocument(session, cfg);
  notes.push(...(await prewarm(session, cfg)));
  return notes;
}

export async function navigate(session: Session, url: string): Promise<void> {
  const idle = waitForLifecycle(session, 'networkIdle', 20_000);
  await session.send('Page.navigate', { url });
  await idle.catch(() => { /* some pages never go fully idle; carry on */ });
  await session
    .eval('document.fonts ? document.fonts.ready.then(()=>true) : true', true, 10_000)
    .catch(() => {});
}

/**
 * Some sites gate the page behind an intro that advances on SCROLL rather than time
 * — until you scroll through it, document.scrollHeight equals the viewport and there
 * is nothing to film. Waiting doesn't help; the page needs real input.
 *
 * `window.scrollTo` won't do it either: these intros listen for wheel events, which
 * a CSSOM scroll never produces. So we dispatch real wheel events through CDP, which
 * enter Chrome's actual input pipeline, until the document becomes scrollable.
 */
export async function unlockScroll(
  session: Session,
  cfg: Resolved,
): Promise<{ ticks: number; unlocked: boolean; before: number; after: number }> {
  const heightOf = () => session.eval<number>('document.scrollingElement.scrollHeight').catch(() => 0);
  const maxOf = () => session.eval<number>('window.__sr.maxScroll()').catch(() => 0);

  const before = await heightOf();
  if ((await maxOf()) > 8) return { ticks: 0, unlocked: true, before, after: before };

  const { maxTicks, deltaY } = cfg.page.unlockIntro;
  let ticks = 0;
  for (let i = 0; i < maxTicks; i++) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(cfg.width / 2),
      y: Math.round(cfg.height / 2),
      deltaX: 0,
      deltaY,
    }).catch(() => {});
    ticks++;
    await sleep(140);
    if ((await maxOf()) > 8) break;
  }

  const after = await heightOf();
  const unlocked = (await maxOf()) > 8;
  if (unlocked) {
    // Back to the top so the timeline starts where the author expects. Verified safe
    // on the sites this was built for: unlocking is one-way, returning doesn't re-lock.
    await session.eval('window.__sr.setScroll(0)').catch(() => {});
    await sleep(400);
  }
  return { ticks, unlocked, before, after };
}

/**
 * Poll until no finite animation is running. Intro/preloader animations are the
 * reason this exists: filming through one produces a video that starts mid-splash.
 */
export async function waitForAnimationsIdle(
  session: Session,
  maxMs: number,
): Promise<{ ms: number; idle: boolean }> {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < maxMs) {
    const busy = await session.eval<number>('window.__sr.busyAnimations()').catch(() => 0);
    if (busy === 0) {
      quiet++;
      if (quiet >= 2) return { ms: Date.now() - started, idle: true };
    } else {
      quiet = 0;
    }
    await sleep(200);
  }
  return { ms: Date.now() - started, idle: false };
}

export function waitForLifecycle(session: Session, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} within ${timeoutMs}ms`)), timeoutMs);
    session.on('Page.lifecycleEvent', (p: any) => {
      if (p.name === name) { clearTimeout(timer); resolve(); }
    });
  });
}

/**
 * Step through the whole page so lazy images load, IntersectionObserver reveals
 * fire, and the document height stops moving. One big jump doesn't work — many
 * loaders only trigger when an element actually passes through the viewport.
 */
export async function prewarm(session: Session, cfg: Resolved): Promise<string[]> {
  const notes: string[] = [];
  if (cfg.prewarm.mode === 'none') {
    notes.push('no pre-warm: filming a cold page');
    await session.eval('window.__sr.snapshotAnimations()').catch(() => {});
    return notes;
  }

  const started = Date.now();
  const step = Math.round(cfg.height * 0.8);
  let stable = 0;
  let lastHeight = -1;
  let y = 0;
  let steps = 0;

  while (Date.now() - started < cfg.prewarm.timeout) {
    const m = await session.eval<any>(
      `(() => { window.__sr.eagerize(); window.__sr.setScroll(${y}); return window.__sr.metrics(); })()`,
    );
    if (m.docHeight > cfg.prewarm.maxHeight) { notes.push(`stopped pre-warm at ${m.docHeight}px (maxHeight)`); break; }
    await sleep(140);
    steps++;

    if (m.docHeight === lastHeight) stable++; else stable = 0;
    lastHeight = m.docHeight;

    if (y >= m.max) {
      if (stable >= 3) break;
    } else {
      y = Math.min(y + step, m.max);
    }
    if (steps > 400) { notes.push('stopped pre-warm at 400 steps'); break; }
  }

  if (cfg.page.hideOverlays) {
    const n = await session.eval<number>('window.__sr.hideOverlays()').catch(() => 0);
    if (n > 0) notes.push(`hid ${n} overlay${n === 1 ? '' : 's'}`);
  }

  await session.eval('window.__sr.setScroll(0)');
  await sleep(250);

  if (cfg.prewarm.mode === 'cache') {
    await navigate(session, cfg.url);
    await sleep(400);
    await session.eval('window.__sr && window.__sr.setMode("live")').catch(() => {});
    if (cfg.page.dismissConsent) await session.eval('window.__sr.dismissConsent()').catch(() => {});
    if (cfg.page.hideOverlays) await session.eval('window.__sr.hideOverlays()').catch(() => {});
    notes.push('warmed the cache then reloaded — reveals will animate on camera');
  }

  // Freeze the reference point for animation positions BEFORE anything renders a frame.
  await session.eval('window.__sr.snapshotAnimations()').catch(() => {});

  notes.push(`pre-warmed in ${steps} steps (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return notes;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
