/**
 * The side-panel editor. Owns the timeline being authored; the content-script
 * overlay owns the page. Working state lives here + chrome.storage.session
 * (MV3 service workers get evicted, so nothing may live in the background
 * worker); the saves library and the per-site autosave live in
 * chrome.storage.local, which survives browser restarts and extension
 * updates.
 *
 * Structure mirrors the authoring sequence the renderer needs: readiness chips
 * (viewport match / warm-up / scroll gate) answer "will the render match what
 * I'm seeing?", setup is a stage that collapses once the viewport fits, and
 * the timeline area is a duration ruler (which doubles as the scrubber) over
 * collapsed step rows that expand to edit.
 */
'use strict';

const EASES = ['linear', 'natural', ...Object.keys(globalThis.TapewormEasing.NAMED)];
const SETTING_INPUTS = [['s-width', 'width'], ['s-height', 'height'], ['s-dpr', 'dpr'], ['s-fps', 'fps'], ['s-fade', 'cursorFade']];
const $ = (id) => document.getElementById(id);

let tabId = null;
let state = {
  url: '',
  title: '',
  settings: { width: 1280, height: 800, dpr: 2, fps: 60, cursorFade: 0 },
  steps: [{ type: 'start', at: 'top', hold: 0.8 }],
  codec: 'h264',
};
let totalSec = 0;
let playing = false;
let lastPreviewT = 0;   // where playback last reported being — the resume point after a mid-preview navigation
let picking = null; // null | 'move' | 'click' | 'hover' | 'record'
let currentPageUrl = ''; // where the tab is NOW — the timeline's url is pinned on the start step
let lastInfo = null;     // most recent page:info payload
let lastSpans = [];      // per-step {index, type, t0, t1} from the overlay's geometry
let warmed = false;      // per-panel-lifetime; page reloads silently reset the page, so stay honest
let expandedIndex = null; // which step row shows its editor
let prevMatched = false; // for the collapse-setup-on-first-match transition

// ---------------------------------------------------------------- messaging
async function send(type, data) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { to: 'tapeworm-overlay', type, data });
  } catch (e) {
    return null; // page navigated / not injected — surfaced via inject-note
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== 'tapeworm-overlay') return;
  const d = msg.data || {};
  if (msg.type === 'picker:picked') onPicked(d);
  if (msg.type === 'picker:stopped') setPicking(null);
  if (msg.type === 'record:done') onRecorded(d);
  if (msg.type === 'record:split') onRecordSplit(d);
  if (msg.type === 'record:cancelled') setPicking(null);
  if (msg.type === 'preview:time') onPreviewTime(d);
  if (msg.type === 'preview:ended') { playing = false; $('play').textContent = '▶ Preview'; $('arm-record').disabled = false; }
  if (msg.type === 'page:info') onPageInfo(d);
});

// ---------------------------------------------------------------- state
async function saveState() {
  await chrome.storage.session.set({ ['doc:' + tabId]: state });
  // Mirror authored work into chrome.storage.local under the page's domain:
  // session storage dies with the browser, local survives restarts and
  // extension updates. A fresh timeline isn't worth mirroring — and writing
  // one would clobber the autosave syncPage is about to restore.
  const dom = docDomain();
  if (dom && state.steps.length > 1) {
    try { await chrome.storage.local.set({ ['wip:' + dom]: state }); } catch (e) {} // quota — the session copy still stands
  }
}

async function loadState() {
  const got = await chrome.storage.session.get('doc:' + tabId);
  if (got['doc:' + tabId]) state = got['doc:' + tabId];
  state.settings.cursorFade ??= 0; // states saved before the setting existed
}

/** The site a timeline belongs to: its pinned start url's domain, else the page's. */
function docDomain() {
  const start = state.steps[0];
  const url = (start && start.type === 'start' && start.url) || currentPageUrl;
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function stripInternal(step) {
  const out = {};
  for (const k of Object.keys(step)) if (!k.startsWith('_') && step[k] !== undefined) out[k] = step[k];
  return out;
}

// ---------------------------------------------------------------- events from the page
/**
 * The first keyframe (or recording) pins the timeline to the page it was
 * authored on. Navigating later (a recorded click, or just browsing) must not
 * re-point the config — the early selectors only exist back there. The url
 * comes stamped on the pick/record event itself: the panel's cached
 * currentPageUrl was read when it attached, and SPA route changes never
 * refresh it.
 */
function pinStartUrl(url) {
  const start = state.steps[0];
  if (start && start.type === 'start' && !start.url && url) start.url = url;
}

function onPicked(d) {
  pinStartUrl(d.url || currentPageUrl);
  if (d.mode === 'click' || d.mode === 'hover') {
    state.steps.push({ type: d.mode, target: d.anchor, _quality: d.quality });
    setPicking(null); // interactions arm for ONE pick — back to normal after
    send('picker:stop');
  } else {
    state.steps.push({ type: 'move', to: d.anchor, ease: 'natural', _quality: d.quality });
  }
  expandedIndex = state.steps.length - 1;
  commit();
}

function onRecorded(d) {
  pinStartUrl(d.url || currentPageUrl); // the recording belongs to the page it STARTED on
  const step = { type: 'record', samples: d.samples, viewport: d.viewport };
  if (d.buttons && d.buttons.length) step.buttons = d.buttons;
  state.steps.push(step);
  setPicking(null);
  expandedIndex = state.steps.length - 1;
  commit();
}

/**
 * A recorded click loaded a new document. The overlay split the take at that
 * click (overlay.js onRecPageHide): everything before it arrives here as a
 * finished take, the click itself as a picked target. Land both as steps —
 * record, then click — and follow the navigation: re-inject on the
 * destination and resume recording, so one continuous performance becomes
 * record → click → record without re-arming anything. ESC (which disarms
 * `picking` before this resumes) still ends the whole take.
 */
async function onRecordSplit(d) {
  pinStartUrl(d.url || currentPageUrl);
  if (d.take) {
    const step = { type: 'record', samples: d.take.samples, viewport: d.take.viewport };
    if (d.take.buttons && d.take.buttons.length) step.buttons = d.take.buttons;
    state.steps.push(step);
  }
  state.steps.push({ type: 'click', target: d.click.anchor, _quality: d.click.quality });
  expandedIndex = state.steps.length - 1;
  commit();

  $('arm-record').textContent = '● following the navigation…';
  await waitForTabComplete(20000);
  if (picking !== 'record') return; // disarmed (ESC) while the page was loading
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
  } catch (e) {
    setPicking(null);
    $('inject-msg').textContent = 'The recording followed a navigation but couldn\'t re-attach: ' +
      String((e && e.message) || e) + ' — likely a cross-origin page. The take so far is kept; ' +
      'click the Tapeworm toolbar icon on the destination to keep authoring there.';
    $('inject-note').hidden = false;
    return;
  }
  setWarmed(false); // fresh document: reveals and lazy content are untriggered again
  await syncPage();
  if (picking !== 'record') return;
  const r = await send('record:start');
  if (!r || r.error) { setPicking(null); return; }
  setPicking('record'); // restore the armed label over the "following…" text
}

/**
 * Resolve when the tab reports 'complete' — checking the current status
 * first, because a fast load may already be done by the time the split event
 * crosses the extension. The timeout keeps an endless spinner from wedging
 * the resume; injection is then attempted anyway, like returnToStart does.
 */
function waitForTabComplete(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(bail);
      setTimeout(resolve, 150); // let the new document actually commit its scripts
    };
    const onUpdated = (id, changed) => {
      if (id === tabId && changed.status === 'complete') finish();
    };
    const bail = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') finish();
    }).catch(finish);
  });
}

function onPageInfo(d) {
  lastInfo = d;
  currentPageUrl = d.url || currentPageUrl;
  state.title = d.title || state.title;
  $('page-title').textContent = state.title || currentPageUrl;

  const gated = !!d.scrollGated;
  $('chip-gate').hidden = !gated;
  $('gate-note').hidden = !gated;

  if (d.window) {
    const chip = $('chip-vp');
    if (d.viewportMatched) {
      chip.className = 'chip ok';
      chip.textContent = d.window.width + '×' + d.window.height + ' ✓' + (emulating ? ' (emulated)' : '');
      if (!prevMatched) $('setup').open = false; // setup got you here; give the timeline the space
      prevMatched = true;
    } else {
      chip.className = 'chip warn';
      chip.textContent = d.window.width + '×' + d.window.height + ' ✗ — ' +
        (d.target ? 'fit to ' + d.target.width + '×' + d.target.height : 'fit window');
      if (prevMatched) $('setup').open = true; // it broke — send them back to setup
      prevMatched = false;
    }
  }
  renderSetupSum();
  renderEmpty();
  saveState();
}

/**
 * The render always captures the full viewport at the configured size, and CSS
 * breakpoints mean a page laid out in a bigger window is a DIFFERENT page. So:
 * resize the browser window until the page viewport equals the render target.
 * Two passes, because window chrome (tab strip, bookmarks bar) is only
 * measurable as the outer/inner difference after the first resize.
 *
 * When no window reaches the target — the phone and portrait-iPad presets are
 * taller than most screens, and chrome.windows.update just clamps to the work
 * area — fall back to what the renderer itself does (page.ts, `tapeworm
 * author`): Emulation.setDeviceMetricsOverride, over chrome.debugger. The page
 * then lays out and reports innerWidth/innerHeight at the exact target while
 * Chrome scales it to fit the real window, DevTools-device-mode style — real
 * input keeps working, remapped through the scale.
 */
async function fitWindow() {
  await stopEmulating(); // a live override pins the viewport — measure the real window first
  // Sizes knowably out of range skip the window thrashing and go straight
  // to emulation.
  if (!resizeCanReach()) {
    if (await emulateViewport()) {
      const info = await send('info');
      if (info) onPageInfo(info);
      return;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const info = await send('info');
    if (!info || !info.window) return;
    const dw = state.settings.width - info.window.width;
    const dh = state.settings.height - info.window.height;
    if (dw === 0 && dh === 0) { onPageInfo(info); return; }
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(win.id, {
      state: 'normal',
      width: (win.width || 0) + dw,
      height: (win.height || 0) + dh,
    });
    await new Promise((r) => setTimeout(r, 150));
  }
  const info = await send('info');
  if (!info) return;
  onPageInfo(info);
  if (info.viewportMatched) return;
  if (await emulateViewport()) {
    const after = await send('info');
    if (after) onPageInfo(after);
  }
}

// ---------------------------------------------------------------- viewport emulation
/**
 * Needs the `debugger` permission, which must be install-time: Chrome
 * forbids it in optional_permissions, so it can't be requested on demand.
 * deviceScaleFactor 0 keeps the display's real scale: authoring never
 * emulates dpr (the render applies it), and a real/emulated mismatch makes
 * Chrome's hover re-evaluation hit-test the stored pointer across the two
 * scales on any layout change (see src/browser.ts). mobile:false matches the
 * render's own override — same layout mode, wheel scrolling intact.
 */
let emulating = false;    // this panel holds a device-metrics override on the tab
let detachHooked = false; // the emulation listeners are registered

/**
 * Bounds no window resize can cross, knowable up front: Chrome won't shrink
 * a window's web contents below ~500 CSS px of width (less the side panel —
 * ~435 observed), and the OS work area caps how tall it can grow (~88px is
 * the slimmest tab-strip + toolbar). The margins are deliberately loose —
 * a wrong "reachable" guess still ends in emulateViewport() after the
 * resize passes fail; it just thrashes the window on the way.
 */
function resizeCanReach() {
  const s = state.settings;
  return s.width >= 500 &&
    s.height + 88 <= screen.availHeight &&
    s.width + 8 <= screen.availWidth;
}

async function emulateViewport() {
  const chip = $('chip-vp');
  if (!detachHooked) {
    detachHooked = true;
    // Cancel on Chrome's debugging infobar (or anything else detaching us)
    // silently drops the override — reflect the real viewport again.
    chrome.debugger.onDetach.addListener((source) => {
      if (!source || source.tabId !== tabId) return;
      emulating = false;
      send('info').then((info) => { if (info) onPageInfo(info); });
    });
    // Best-effort: closing the panel shouldn't leave the tab emulated.
    window.addEventListener('pagehide', () => {
      if (emulating) try { chrome.debugger.detach({ tabId }); } catch (e) {}
    });
  }
  try {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // A previous panel's attachment can survive a reopen — if the session is
      // ours the override below just works; if it's DevTools, sendCommand throws.
      if (!/already attached/i.test(String((e && e.message) || e))) throw e;
    }
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: state.settings.width,
      height: state.settings.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    emulating = true;
    return true;
  } catch (e) {
    chip.textContent += ' — couldn\'t emulate: ' + String((e && e.message) || e) +
      ' (close DevTools on this tab, then Fit window again)';
    return false;
  }
}

/** Detaching clears every override this session set — the page reflows to the real window. */
async function stopEmulating() {
  if (!emulating) return;
  emulating = false;
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  await new Promise((r) => setTimeout(r, 150)); // the debugging infobar leaves; let the window settle
}

function onPreviewTime(d) {
  totalSec = d.total;
  lastPreviewT = d.t;
  setPlayhead(d.t, d.total);
}

// ---------------------------------------------------------------- readiness + stages
function renderSetupSum() {
  const s = state.settings;
  $('setup-sum').textContent = s.width + '×' + s.height + ' @' + s.dpr + 'x · ' + s.fps + ' fps' +
    (s.cursorFade > 0 ? ' · cursor fade ' + s.cursorFade + 's' : '');
}

function setWarmed(v) {
  warmed = v;
  const chip = $('chip-warm');
  chip.className = v ? 'chip ok' : 'chip warn';
  chip.textContent = v ? 'warmed ✓' : 'not warmed';
  renderEmpty();
}

function renderEmpty() {
  const fresh = state.steps.length <= 1;
  $('empty').hidden = !fresh;
  if (!fresh) return;
  check($('e-fit'), !!(lastInfo && lastInfo.viewportMatched), '1');
  check($('e-warm'), warmed, '2');
  check($('e-pick'), false, '3');
  function check(el, done, n) {
    el.className = done ? 'chip ok' : 'chip';
    el.textContent = done ? '✓' : n;
  }
}

// ---------------------------------------------------------------- duration ruler
function spanFor(i) {
  return lastSpans.find((s) => s.index === i) || null;
}

function renderRuler() {
  const wrap = $('ruler-wrap');
  const authored = state.steps.length > 1 && totalSec > 0;
  wrap.hidden = !authored;
  $('tl-sum').textContent = state.steps.length > 1
    ? state.steps.length + ' steps · ' + totalSec.toFixed(1) + 's'
    : '';
  if (!authored) return;

  const ruler = $('ruler');
  ruler.innerHTML = '';
  const track = document.createElement('div');
  track.id = 'ruler-track';
  ruler.appendChild(track);
  const ordered = [...lastSpans].sort((a, b) => a.t0 - b.t0);
  for (const s of ordered) {
    const seg = document.createElement('div');
    const secs = s.t1 - s.t0;
    if (s.type === 'click' || s.type === 'hover') {
      seg.className = 'seg act';
      seg.textContent = s.type === 'click' ? '⊕' : '⊙';
    } else if (s.type === 'record') {
      seg.className = 'seg rec';
      seg.style.flexGrow = String(secs);
      seg.textContent = '● ' + secs.toFixed(1);
    } else if (s.type === 'move') {
      seg.className = 'seg';
      seg.style.flexGrow = String(secs);
      seg.textContent = secs.toFixed(1);
    } else { // start, hold
      seg.className = 'seg hold';
      seg.style.flexGrow = String(secs);
      seg.textContent = secs.toFixed(1);
    }
    seg.title = 'step ' + (s.index + 1) + ' — ' + secs.toFixed(1) + 's';
    track.appendChild(seg);
  }
  const ph = document.createElement('div');
  ph.id = 'playhead';
  ruler.appendChild(ph);
  $('total').textContent = totalSec.toFixed(1) + 's';
}

function setPlayhead(t, total) {
  const ph = document.getElementById('playhead');
  if (ph && total > 0) ph.style.left = 'calc(' + ((t / total) * 100).toFixed(2) + '% - 1px)';
  $('time').textContent = t.toFixed(1) + 's';
}

// scrubbing: dragging the ruler IS seeking — reading and driving the timeline
// are the same surface
let scrubBusy = false;
function rulerSeek(ev) {
  const r = $('ruler').getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const t = frac * totalSec;
  setPlayhead(t, totalSec); // optimistic — the overlay confirms via the response
  if (scrubBusy) return;
  scrubBusy = true;
  send('preview:seek', { steps: state.steps.map(stripInternal), t }).then((res) => {
    scrubBusy = false;
    if (res) setPlayhead(res.t, res.total);
  });
}

$('ruler').addEventListener('pointerdown', (ev) => {
  if (state.steps.length < 2) return;
  if (playing) { playing = false; $('play').textContent = '▶ Preview'; }
  $('ruler').setPointerCapture(ev.pointerId);
  rulerSeek(ev);
});
$('ruler').addEventListener('pointermove', (ev) => {
  if (ev.buttons & 1) rulerSeek(ev);
});

// ---------------------------------------------------------------- steps UI
function shortUrl(u) {
  try { const p = new URL(u); return p.hostname + (p.pathname === '/' ? '' : p.pathname); } catch { return u; }
}

function anchorLabel(a) {
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return a + 'px';
  return a.selector + (a.nth ? ' [' + a.nth + ']' : '');
}

/** A drawn easing curve — designers read curves faster than the word "inOutQuint". */
function easeSvg(ease) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'easecurve');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 22 14');
  let fn;
  try { fn = globalThis.TapewormEasing.resolveEase(ease || 'natural', 1.5); } catch (e) { fn = (t) => t; }
  let d = 'M 1 13';
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    d += ' L ' + (1 + 20 * t).toFixed(1) + ' ' + (13 - 12 * fn(t)).toFixed(1);
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', '1.5');
  svg.appendChild(path);
  const title = document.createElementNS(NS, 'title');
  title.textContent = ease || 'natural';
  svg.appendChild(title);
  return svg;
}

function recDuration(step) {
  const t = step.samples.t;
  return t.length ? t[t.length - 1] / 1000 : 0;
}

// The smoothing select's labels ↔ the config's strength values. `true` is the
// config shorthand for strength 0.5, so it reads back as 'medium'.
const SMOOTHING_STRENGTHS = { light: 0.25, medium: 0.5, strong: 0.85 };

function smoothingLabel(sm) {
  if (!sm) return 'off';
  const k = typeof sm === 'object' && typeof sm.strength === 'number' ? sm.strength : 0.5;
  return k <= 0.35 ? 'light' : k <= 0.65 ? 'medium' : 'strong';
}

function durLabel(step, i) {
  const s = spanFor(i);
  if (step.type === 'start') return 'hold ' + (step.hold != null ? step.hold : 0.8).toFixed(1) + 's';
  if (step.type === 'hold') return (step.seconds != null ? step.seconds : 1).toFixed(1) + 's';
  if (step.type === 'click' || step.type === 'hover') {
    return 'settle ' + (step.settle != null ? step.settle : 0.6).toFixed(1) + 's';
  }
  if (step.type === 'record') return recDuration(step).toFixed(1) + 's';
  return s ? (s.t1 - s.t0).toFixed(1) + 's' : '…'; // move: its full slice, implicit hold included
}

function renderSteps() {
  const ol = $('steps');
  ol.innerHTML = '';
  state.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'step' + (expandedIndex === i ? ' open' : '');

    const row1 = div('row1');
    // The start step is pinned first — it gets a blank grip purely for column
    // alignment. Rows are only draggable while the pointer is on the grip, so
    // text selection and row-click-to-expand keep working everywhere else.
    const grip = span('grip' + (i === 0 ? ' off' : ''), '⠿');
    if (i > 0) {
      grip.title = 'Drag to reorder';
      grip.addEventListener('click', (ev) => ev.stopPropagation());
      grip.addEventListener('pointerdown', () => { li.draggable = true; });
      grip.addEventListener('pointerup', () => { li.draggable = false; });
      li.addEventListener('dragstart', (ev) => {
        dragIndex = i;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(i));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => {
        li.draggable = false;
        li.classList.remove('dragging');
        dragIndex = null;
        clearDropMarks();
      });
    }
    row1.append(grip);
    row1.append(span('idx', step.type === 'start' ? 'S' : String(i)));

    if (step.type === 'start') {
      const label = span('sel muted', 'start at ' + anchorLabel(step.at) +
        (step.url ? ' — ' + shortUrl(step.url) : ' (url pinned by the first keyframe)'));
      if (step.url) label.title = step.url;
      row1.append(label);
    } else if (step.type === 'hold') {
      row1.append(span('sel muted', 'hold'));
    } else if (step.type === 'move') {
      const sel = span('sel', anchorLabel(step.to));
      if (typeof step.to === 'object' && step.to.fallbackText) sel.title = '"' + step.to.fallbackText + '"';
      row1.append(sel);
      if (step._quality) row1.append(badge(step._quality));
      row1.append(easeSvg(step.ease));
    } else if (step.type === 'click' || step.type === 'hover') {
      row1.append(span('sel', (step.type === 'click' ? '⊕ ' : '⊙ ') + anchorLabel(step.target)));
      if (step._quality) row1.append(badge(step._quality));
    } else if (step.type === 'record') {
      const clicks = (step.buttons || []).filter((b) => b.action === 'down').length;
      row1.append(span('sel', '● recording — ' + recDuration(step).toFixed(1) + 's · ' +
        step.samples.t.length + ' samples' + (clicks ? ' · ' + clicks + ' click' + (clicks === 1 ? '' : 's') : '') +
        (step.smoothing ? ' · smoothed' : '')));
    } else {
      row1.append(span('sel', step.type + ' (not executable yet)'), badge('warn'));
    }

    const dur = span('dur', durLabel(step, i));
    dur.dataset.dur = String(i);
    row1.append(dur);
    row1.addEventListener('click', () => {
      expandedIndex = expandedIndex === i ? null : i;
      renderSteps();
    });
    li.append(row1);

    if (expandedIndex === i) li.append(editor(step, i));
    ol.appendChild(li);
  });

  renderEmpty();
  $('play').disabled = state.steps.length < 2;

  function editor(step, i) {
    const ed = div('editor');
    ed.addEventListener('click', (ev) => ev.stopPropagation());
    if (step.type === 'start') {
      ed.append(field('hold s', numInput(step.hold, 0.8, (v) => { step.hold = v == null ? undefined : v; commit(); })));
      const t = div('tools');
      const note = noteLine(step.url ? 'starts at ' + shortUrl(step.url) : 'url not pinned yet — set by the first keyframe or recording');
      if (step.url) note.title = step.url;
      t.append(note);
      const pin = document.createElement('button');
      pin.textContent = '⌖ Pin this page';
      pin.title = 'Reset the starting URL to the page the tab is on now — the render and preview will begin there';
      pin.addEventListener('click', async () => {
        // ask the page itself first (the live URL); the tab record covers a
        // navigated-away tab whose content scripts are gone
        const info = await send('info');
        let url = (info && info.url) || '';
        if (!url) { try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) {} }
        if (!url) url = currentPageUrl;
        if (!url) return;
        step.url = url;
        commit();
      });
      t.append(pin);
      ed.append(t);
    } else if (step.type === 'hold') {
      ed.append(field('seconds', numInput(step.seconds, 1, (v) => { step.seconds = v == null ? 1 : v; commit(); })));
      ed.append(tools(i));
    } else if (step.type === 'move') {
      ed.append(
        field('align', selectInput(['top', 'center', 'bottom'], (typeof step.to === 'object' && step.to.align) || 'top', (v) => {
          if (typeof step.to === 'object') { if (v === 'top') delete step.to.align; else step.to.align = v; commit(); }
        })),
        field('offset px', numInput(typeof step.to === 'object' ? step.to.offset : undefined, 0, (v) => {
          if (typeof step.to === 'object') { if (v == null || v === 0) delete step.to.offset; else step.to.offset = v; commit(); }
        })),
        field('duration s', numInput(step.duration, 'auto', (v) => { step.duration = v == null ? undefined : v; commit(); })),
        field('ease', selectInput(EASES, step.ease || 'natural', (v) => { step.ease = v; commit(); })),
        field('hold s', numInput(step.hold, '', (v) => { step.hold = v == null ? undefined : v; commit(); })),
      );
      ed.append(tools(i, step.to));
    } else if (step.type === 'click' || step.type === 'hover') {
      ed.append(field('settle s', numInput(step.settle, '0.6', (v) => { step.settle = v == null ? undefined : v; commit(); })));
      const t = tools(i, step.target);
      t.prepend(noteLine(step.type === 'hover'
        ? 'emulated in preview; real input in render'
        : 'emulated in preview (effects persist — reload to reset); real input in render'));
      ed.append(t);
    } else if (step.type === 'record') {
      ed.append(
        field('smoothing', selectInput(['off', 'light', 'medium', 'strong'], smoothingLabel(step.smoothing), (v) => {
          if (v === 'off') delete step.smoothing;
          else step.smoothing = { mode: 'denoise', strength: SMOOTHING_STRENGTHS[v] };
          commit();
        })),
        field('hold s', numInput(step.hold, '0', (v) => { step.hold = v == null ? undefined : v; commit(); })),
      );
      const t = tools(i);
      t.prepend(noteLine('replays your real pointer, clicks and scroll in the render; preview emulates the hover and clicks (effects persist — reload to reset) — drags render-only · smoothing eases the cursor path; clicks and drag endpoints stay put'));
      ed.append(t);
    } else {
      ed.append(tools(i));
    }
    return ed;
  }

  function tools(i, jumpAnchor) {
    const t = div('tools');
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    t.append(spacer);
    if (jumpAnchor) t.append(iconBtn('⌖', 'Jump the page to this element', () => send('jump', { anchor: jumpAnchor })));
    t.append(
      iconBtn('↑', 'Move up', () => { if (i > 1) swap(i, i - 1); }),
      iconBtn('↓', 'Move down', () => { if (i < state.steps.length - 1) swap(i, i + 1); }),
      iconBtn('✕', 'Remove', () => {
        state.steps.splice(i, 1);
        if (expandedIndex === i) expandedIndex = null;
        else if (expandedIndex != null && expandedIndex > i) expandedIndex--;
        commit();
      }),
    );
    return t;
  }

  function noteLine(text) { const s = span('note-line', text); return s; }
  function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
  function span(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
  function badge(q) { const b = document.createElement('span'); b.className = 'qbadge ' + q; b.textContent = q === 'structural' ? 'fragile' : q; return b; }
  function field(label, input) {
    const w = document.createElement('label'); w.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    w.append(t, input); return w;
  }
  function numInput(value, placeholder, onChange) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1';
    inp.placeholder = String(placeholder);
    if (value !== undefined && value !== null) inp.value = String(value);
    inp.addEventListener('change', () => onChange(inp.value === '' ? null : Number(inp.value)));
    return inp;
  }
  function selectInput(options, value, onChange) {
    const s = document.createElement('select');
    for (const o of options) { const opt = document.createElement('option'); opt.textContent = o; s.append(opt); }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function iconBtn(txt, title, fn) {
    const b = document.createElement('button');
    b.className = 'icon'; b.textContent = txt; b.title = title;
    b.addEventListener('click', fn);
    return b;
  }
  function swap(a, b) {
    const t = state.steps[a]; state.steps[a] = state.steps[b]; state.steps[b] = t;
    if (expandedIndex === a) expandedIndex = b;
    else if (expandedIndex === b) expandedIndex = a;
    commit();
  }
}

// ---------------------------------------------------------------- drag to reorder
let dragIndex = null; // index of the step being dragged, null when idle

/** Move a step so it lands at `insertAt` (an index into the pre-removal array). */
function moveStep(from, insertAt) {
  insertAt = Math.max(1, Math.min(insertAt, state.steps.length)); // never before start
  if (insertAt === from || insertAt === from + 1) return; // dropped where it already sits
  const expanded = expandedIndex != null ? state.steps[expandedIndex] : null;
  const [step] = state.steps.splice(from, 1);
  state.steps.splice(insertAt > from ? insertAt - 1 : insertAt, 0, step);
  expandedIndex = expanded ? state.steps.indexOf(expanded) : null;
  commit();
}

function clearDropMarks() {
  for (const el of $('steps').querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

/** Insertion index for a drop at this pointer position: before the first row
 *  whose midpoint the cursor is above, clamped past the pinned start step. */
function dropIndexFrom(ev) {
  const rows = [...$('steps').children];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (ev.clientY < r.top + r.height / 2) return Math.max(1, i);
  }
  return rows.length;
}

$('steps').addEventListener('dragover', (ev) => {
  if (dragIndex == null) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const at = dropIndexFrom(ev);
  clearDropMarks();
  const rows = $('steps').children;
  if (at < rows.length) rows[at].classList.add('drop-before');
  else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
});

$('steps').addEventListener('drop', (ev) => {
  if (dragIndex == null) return;
  ev.preventDefault();
  const from = dragIndex;
  dragIndex = null;
  clearDropMarks();
  moveStep(from, dropIndexFrom(ev));
});

function commit() {
  saveState();
  renderSteps();
  refreshDuration();
}

async function refreshDuration() {
  const r = await send('duration', { steps: state.steps.map(stripInternal) });
  if (r && typeof r.total === 'number') {
    totalSec = r.total;
    lastSpans = r.spans || [];
    renderRuler();
    setPlayhead(0, totalSec);
    // durations changed under the rows (auto-duration is page geometry) —
    // update labels in place rather than re-rendering over live inputs
    for (const el of document.querySelectorAll('[data-dur]')) {
      const i = Number(el.dataset.dur);
      if (state.steps[i]) el.textContent = durLabel(state.steps[i], i);
    }
  }
}

// ---------------------------------------------------------------- toolbar
function setPicking(mode) {
  picking = mode;
  $('pick').classList.toggle('active', mode === 'move');
  $('pick').textContent = mode === 'move' ? '✕ Stop (Esc)' : '＋ Scroll to';
  $('arm-click').classList.toggle('active', mode === 'click');
  $('arm-hover').classList.toggle('active', mode === 'hover');
  $('arm-record').classList.toggle('active', mode === 'record');
  $('arm-record').textContent = mode === 'record' ? '● Recording… (ESC)' : '● Record';
}

async function armPicker(mode) {
  if (picking === mode) {
    setPicking(null);
    // stopping a recording KEEPS what was captured (record:done follows) —
    // losing a take is worse than deleting an unwanted row
    await send(mode === 'record' ? 'record:stop' : 'picker:stop');
    return;
  }
  setPicking(mode);
  if (mode === 'record') {
    const r = await send('record:start');
    if (!r || r.error) setPicking(null); // preview playing, or the page went away
  } else {
    await send('picker:start', { mode });
  }
}

$('pick').addEventListener('click', () => armPicker('move'));
$('arm-click').addEventListener('click', () => armPicker('click'));
$('arm-hover').addEventListener('click', () => armPicker('hover'));
$('arm-record').addEventListener('click', () => armPicker('record'));

// ESC goes to whichever document has FOCUS — and after clicking an arm button
// that's this panel, not the page. The overlay's own ESC handler only hears
// keys once the page is focused, which recording never guarantees (clicking
// the page to focus it would be captured as part of the take). So the panel
// disarms too: for a recording that finishes and keeps the take, same as ESC
// on the page.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && picking) {
    ev.preventDefault();
    armPicker(picking); // toggles the armed mode off
  }
});

$('fit').addEventListener('click', fitWindow);

$('preset').addEventListener('change', async () => {
  const v = $('preset').value;
  if (!v) return;
  const [w, h] = v.split('x').map(Number);
  state.settings.width = w;
  state.settings.height = h;
  $('s-width').value = String(w);
  $('s-height').value = String(h);
  renderSetupSum();
  await saveState();
  await send('settings', state.settings);
  await fitWindow();
  $('preset').value = '';
});

$('prepare').addEventListener('click', async () => {
  $('prepare').disabled = true;
  $('prepare').textContent = '⟳ Warming…';
  await send('prepare');
  $('prepare').disabled = false;
  $('prepare').textContent = '⟳ Warm up';
  setWarmed(true);
});

$('add-hold').addEventListener('click', () => {
  state.steps.push({ type: 'hold', seconds: 1 });
  expandedIndex = state.steps.length - 1;
  commit();
});

/** Same document to load — a hash-only difference doesn't warrant a reload. */
function samePage(a, b) {
  try {
    const ua = new URL(a); ua.hash = '';
    const ub = new URL(b); ub.hash = '';
    return ua.href === ub.href;
  } catch (e) { return a === b; }
}

/**
 * The render starts from the start step's pinned url, so the preview must too.
 * Authoring can navigate the tab away (trying out a click that navigates, or
 * plain browsing) — bring it back before playing. The navigation destroys the
 * content scripts, so re-inject and resync after; returning to the authored
 * page is a same-origin navigation, which the activeTab grant survives.
 */
async function returnToStart() {
  const start = state.steps[0];
  const startUrl = (start && start.type === 'start' && start.url) || '';
  if (!startUrl) return true; // nothing pinned yet — play where we are
  const info = await send('info');
  const here = (info && info.url) || currentPageUrl;
  if (here && samePage(here, startUrl)) return true;

  $('play').disabled = true;
  $('play').textContent = '⟳ Returning…';
  try {
    await new Promise((resolve) => {
      const onUpdated = (id, changed) => {
        if (id !== tabId || changed.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(bail);
        resolve();
      };
      // a page that never reaches 'complete' (endless spinner) must not wedge
      // the Preview button — give up waiting and let the injection try anyway
      const bail = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 20000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.update(tabId, { url: startUrl }).catch(() => {});
    });
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    } catch (e) {
      $('inject-msg').textContent = 'Couldn\'t re-attach after returning to ' + shortUrl(startUrl) +
        ': ' + String((e && e.message) || e) + ' — click the Tapeworm toolbar icon to re-grant access, then Preview again.';
      $('inject-note').hidden = false;
      return false;
    }
    setWarmed(false); // fresh load: reveals and lazy content are untriggered again
    await syncPage();
    return true;
  } finally {
    $('play').disabled = state.steps.length < 2;
    $('play').textContent = '▶ Preview';
  }
}

$('play').addEventListener('click', async () => {
  if (picking === 'record') return; // the overlay refuses too — recording owns the page
  if (playing) {
    playing = false;
    $('play').textContent = '▶ Preview';
    $('arm-record').disabled = false;
    await send('preview:stop');
    return;
  }
  if (!(await returnToStart())) return;
  lastPreviewT = 0;
  const r = await send('preview:play', { steps: state.steps.map(stripInternal) });
  if (r) { playing = true; $('play').textContent = '■ Stop'; $('arm-record').disabled = true; }
});

/**
 * A click step that loads a NEW document mid-preview takes the content
 * scripts — and the playback — down with the page, leaving every step
 * recorded on the destination unplayed. So the panel does for the preview
 * what onRecordSplit does for recording: when the tab starts loading a
 * document while a preview plays, wait the load in, re-inject, and resume
 * playback where it left off (the overlay dwells at the destination's top
 * through the rest of the click's settle, matching how the render films a
 * navigating click). Client-side route changes never arrive here — the
 * document, and with it the preview, survives those.
 */
let followingNav = false;
chrome.tabs.onUpdated.addListener((id, changed) => {
  if (id !== tabId || changed.status !== 'loading' || !playing || followingNav) return;
  followingNav = true;
  void (async () => {
    const resumeT = lastPreviewT;
    $('play').textContent = '⟳ Following…';
    await waitForTabComplete(20000);
    if (!playing) return; // stopped while the destination loaded
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    } catch (e) {
      playing = false;
      $('play').textContent = '▶ Preview';
      $('arm-record').disabled = false;
      $('inject-msg').textContent = 'The preview followed a navigation but couldn\'t re-attach: ' +
        String((e && e.message) || e) + ' — likely a cross-origin page. Click the Tapeworm toolbar ' +
        'icon on the destination to re-grant access, then Preview again.';
      $('inject-note').hidden = false;
      return;
    }
    setWarmed(false); // fresh document: reveals and lazy content are untriggered again
    await syncPage();
    if (!playing) return;
    const r = await send('preview:play', { steps: state.steps.map(stripInternal), from: resumeT });
    if (r) $('play').textContent = '■ Stop';
    else { playing = false; $('play').textContent = '▶ Preview'; $('arm-record').disabled = false; }
  })().finally(() => { followingNav = false; });
});

for (const [id, key] of SETTING_INPUTS) {
  $(id).addEventListener('change', async () => {
    state.settings[key] = Number($(id).value);
    renderSetupSum();
    await saveState();
    await send('settings', state.settings);
    const info = await send('info');
    if (info) onPageInfo(info);
  });
}

// ---------------------------------------------------------------- export
async function buildConfig() {
  const info = await send('info');
  // The start step's pinned url wins — the tab may have navigated since.
  const start = state.steps[0];
  const url = (start && start.type === 'start' && start.url) || (info && info.url) || currentPageUrl;
  const cursorFade = Number(state.settings.cursorFade) || 0;
  return {
    url,
    viewport: { width: state.settings.width, height: state.settings.height, dpr: state.settings.dpr },
    fps: state.settings.fps,
    // only when opted in — a fade-less config stays byte-identical to before
    ...(cursorFade > 0 ? { page: { cursor: { fade: cursorFade } } } : {}),
    timeline: state.steps.map(stripInternal),
    meta: {
      authoredWith: 'tapeworm-extension/0.1.0',
      authoredAt: new Date().toISOString(),
      authoredViewport: info ? info.window : null,
      url,
    },
  };
}

function exportBasename(url) {
  try { return new URL(url).hostname || 'tapeworm'; } catch { return 'tapeworm'; }
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('export').addEventListener('click', async () => {
  const cfg = await buildConfig();
  downloadJson(cfg, exportBasename(cfg.url) + '.json');
});

// The asset record: everything the CURRENT document has fetched (the overlay's
// Resource Timing collector), for writing page.substitute rules against. Not
// part of the config export — substitution rules live in the config by hand;
// this is the reference list you write them from.
$('export-assets').addEventListener('click', async () => {
  $('more').open = false;
  const r = await send('assets');
  if (!r) return; // page navigated / not injected — surfaced via inject-note
  downloadJson(
    { url: r.url, recordedAt: new Date().toISOString(), assets: r.assets },
    exportBasename(r.url) + '.assets.json',
  );
});

// The --out extension is what selects the codec CLI-side (.png = a frame
// sequence; the CLI turns "base.png" into a directory called "base").
const CODEC_EXT = { h264: '.mp4', prores: '.mov', png: '.png' };

$('codec').addEventListener('change', async () => {
  state.codec = $('codec').value;
  await saveState();
});

$('copy-cmd').addEventListener('click', async () => {
  const cfg = await buildConfig();
  const base = exportBasename(cfg.url);
  const ext = CODEC_EXT[state.codec] || '.mp4';
  // Self-contained: the config rides along on stdin via a heredoc, so nothing
  // needs to exist on disk. The quoted delimiter keeps the shell's hands off
  // the JSON. node bin/…, not npx: the package isn't published yet.
  const cmd =
    `node bin/tapeworm.ts - --out ${base}${ext} <<'TAPEWORM'\n` +
    JSON.stringify(cfg, null, 2) +
    `\nTAPEWORM`;
  await navigator.clipboard.writeText(cmd);
  $('copy-cmd').textContent = 'Copied ✓';
  setTimeout(() => { $('copy-cmd').textContent = 'Copy command'; }, 1200);
});

$('copy').addEventListener('click', async () => {
  const cfg = await buildConfig();
  await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2) + '\n');
  $('more').open = false;
});

$('clear').addEventListener('click', () => {
  $('more').open = false;
  if (!confirm('Start over? This deletes the whole timeline.')) return;
  const dom = docDomain(); // before the reset — the pinned url lives on the start step
  if (dom) chrome.storage.local.remove('wip:' + dom); // else the autosave restores it right back
  state.steps = [{ type: 'start', at: 'top', hold: 0.8 }];
  expandedIndex = null;
  commit();
});

// ---------------------------------------------------------------- library
/**
 * Saved timelines — chrome.storage.local, so they survive browser restarts,
 * extension reloads and updates; only uninstalling clears them (and the
 * pinned manifest key keeps the extension ID, and with it this storage,
 * stable across re-clones). The index is its own small key so listing the
 * menu never loads the payloads — record steps carry sample arrays that run
 * to hundreds of KB. Saves are immutable snapshots: loading one copies it
 * into the working doc, and saving again makes a new entry.
 */
async function libIndex() {
  const got = await chrome.storage.local.get('library:index');
  return got['library:index'] || [];
}

async function librarySave() {
  const entry = {
    id: crypto.randomUUID(),
    name: state.title || docDomain() || 'untitled',
    domain: docDomain(),
    savedAt: Date.now(),
    steps: state.steps.length - 1, // the pinned start step isn't authored
    seconds: totalSec,
  };
  await chrome.storage.local.set({
    ['library:doc:' + entry.id]: state,
    'library:index': [entry, ...(await libIndex())],
  });
}

async function libraryLoad(id) {
  const got = await chrome.storage.local.get('library:doc:' + id);
  if (!got['library:doc:' + id]) return false;
  state = got['library:doc:' + id];
  state.settings.cursorFade ??= 0; // saves from before the setting existed
  expandedIndex = null;
  for (const [inputId, key] of SETTING_INPUTS) $(inputId).value = String(state.settings[key]);
  $('codec').value = state.codec || 'h264';
  renderSetupSum();
  await send('settings', state.settings);
  commit();
  return true;
}

async function libraryDelete(id) {
  await chrome.storage.local.set({ 'library:index': (await libIndex()).filter((e) => e.id !== id) });
  await chrome.storage.local.remove('library:doc:' + id);
}

async function renderLibrary() {
  const wrap = $('lib-items');
  wrap.innerHTML = '';
  const save = document.createElement('button');
  save.textContent = '＋ Save timeline';
  save.disabled = state.steps.length < 2;
  save.title = save.disabled ? 'Nothing to save yet — pick a first keyframe'
    : 'Snapshot the current timeline into the library';
  save.addEventListener('click', async () => {
    try { await librarySave(); } catch (e) {
      wrap.prepend(libLine('lib-empty', 'Couldn\'t save — storage is full. Delete old saves first. (' +
        String((e && e.message) || e) + ')'));
      return;
    }
    renderLibrary();
  });
  wrap.append(save);
  const index = await libIndex();
  if (!index.length) { wrap.append(libLine('lib-empty', 'Nothing saved yet.')); return; }
  const dom = docDomain();
  const here = index.filter((e) => e.domain === dom);
  const elsewhere = index.filter((e) => e.domain !== dom);
  if (dom && !here.length) wrap.append(libLine('lib-empty', 'Nothing saved for ' + dom + ' yet.'));
  for (const e of here) wrap.append(libRow(e, false));
  if (elsewhere.length) {
    wrap.append(libLine('lib-divider', 'other sites'));
    for (const e of elsewhere) wrap.append(libRow(e, true));
  }
}

function libRow(entry, elsewhere) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  const load = document.createElement('button');
  load.className = 'lib-load';
  load.title = 'Load this timeline' + (elsewhere ? ' (its start step points back at ' + entry.domain + ')' : '');
  const when = new Date(entry.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  load.append(
    libLine('lib-name', entry.name),
    libLine('lib-meta', (elsewhere ? entry.domain + ' · ' : '') + entry.seconds.toFixed(1) + 's · ' +
      entry.steps + (entry.steps === 1 ? ' step · ' : ' steps · ') + when),
  );
  load.addEventListener('click', async () => {
    if (state.steps.length > 1 &&
        !confirm('Replace the current timeline with "' + entry.name + '"? Save it first if you want it back.')) return;
    if (await libraryLoad(entry.id)) $('lib').open = false;
    else { await libraryDelete(entry.id); renderLibrary(); } // payload gone — prune the orphaned row
  });
  const del = document.createElement('button');
  del.className = 'icon';
  del.textContent = '✕';
  del.title = 'Delete this save';
  del.addEventListener('click', async () => {
    if (!confirm('Delete "' + entry.name + '"?')) return;
    await libraryDelete(entry.id);
    renderLibrary();
  });
  row.append(load, del);
  return row;
}

function libLine(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

// rebuilt on every open — another panel (or Start over) may have changed the library
$('lib').addEventListener('toggle', () => { if ($('lib').open) renderLibrary(); });

// the footer menus are <details>: close them when a click lands anywhere outside
document.addEventListener('click', (ev) => {
  for (const menu of document.querySelectorAll('details.menu')) {
    if (menu.open && !menu.contains(ev.target)) menu.open = false;
  }
});

// ---------------------------------------------------------------- boot
const CONTENT_SCRIPTS = [
  'shared/easing-core.js',
  'shared/anchor-core.js',
  'shared/selector.js',
  'shared/gesture-core.js',
  'content/overlay.js',
  'content/bridge.js',
];

/**
 * Fallback injection from the panel — the primary injection happens in the
 * service worker on action click, where the activeTab grant is certain.
 * This exists for the "Attach to current tab" button; it works whenever a
 * grant for that tab is live, and explains itself when one isn't.
 */
async function attach() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  await chrome.storage.session.set({ authoringTabId: tabId });

  const noteEl = $('inject-note');
  const msgEl = $('inject-msg');
  if (tabId == null) {
    msgEl.textContent = 'No active tab found.';
    noteEl.hidden = false;
    return false;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    noteEl.hidden = true;
    return true;
  } catch (e) {
    const err = String((e && e.message) || e);
    const url = tab.url || '';
    let hint = 'Extension pages (chrome://), the Web Store, and PDFs can\'t be authored. ' +
      'Switch to the page you want to film and click the Tapeworm toolbar icon there ' +
      '(that grants access to that tab), or try the button below.';
    if (url.startsWith('file:')) {
      hint = 'This is a file:// page: enable "Allow access to file URLs" for this extension in chrome://extensions, then attach again.';
    }
    msgEl.textContent = 'Couldn\'t attach to this page. ' + hint + ' (' + err + ')';
    noteEl.hidden = false;
    return false;
  }
}

/**
 * The overlay stays in the page only while this port is open: bridge.js
 * destroys it on disconnect, which is what cleans the page up when the panel
 * closes (MV3 offers no panel-close event — the port dropping is the signal).
 * Connecting again after the overlay was destroyed remounts it.
 */
let lifeline = null;
function connectLifeline() {
  if (tabId == null) return;
  if (lifeline) { try { lifeline.disconnect(); } catch (e) {} }
  try {
    lifeline = chrome.tabs.connect(tabId, { name: 'tapeworm-lifeline' });
    lifeline.onDisconnect.addListener(() => { lifeline = null; }); // page navigated or tab closed
  } catch (e) {
    lifeline = null;
  }
}

async function syncPage() {
  connectLifeline();
  await loadState();
  const info = await send('info');
  if (info) onPageInfo(info); // also sets currentPageUrl — the autosave key below
  // A fresh doc adopts the site's autosaved timeline: the session copy died
  // with the browser, but the last thing authored here lives on in
  // chrome.storage.local. Start over… is how you decline the restore.
  if (state.steps.length <= 1) {
    const dom = docDomain();
    const got = dom ? await chrome.storage.local.get('wip:' + dom) : {};
    if (got['wip:' + dom]) { state = got['wip:' + dom]; await saveState(); }
  }
  for (const [id, key] of SETTING_INPUTS) $(id).value = String(state.settings[key]);
  $('codec').value = state.codec || 'h264'; // pre-codec saved states lack the field
  renderSetupSum();
  setWarmed(warmed);
  renderSteps();
  await send('settings', state.settings);
  refreshDuration();
}

$('reattach').addEventListener('click', async () => {
  if (await attach()) await syncPage();
});

(async function boot() {
  // The worker injects on the same click that opened this panel — wait for the
  // overlay to answer rather than racing it with a second injection.
  const got = await chrome.storage.session.get('authoringTabId');
  tabId = got.authoringTabId ?? null;
  let up = false;
  for (let i = 0; i < 10 && !up; i++) {
    if (await send('info')) up = true;
    else await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) {
    const { injectError } = await chrome.storage.session.get('injectError');
    if (injectError) {
      $('inject-msg').textContent =
        'Couldn\'t attach to this page: ' + injectError + ' — extension pages (chrome://), ' +
        'the Web Store, and PDFs can\'t be authored, and file:// pages need ' +
        '"Allow access to file URLs" enabled in chrome://extensions. Switch to the page ' +
        'you want to film and click the Tapeworm toolbar icon there.';
      $('inject-note').hidden = false;
    } else {
      await attach(); // no worker error recorded — likely a stale panel; try directly
    }
  }
  await syncPage();
})();
