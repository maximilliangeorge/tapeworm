/**
 * The side-panel editor. Owns the timeline being authored; the content-script
 * overlay owns the page. All state lives here + chrome.storage.session (MV3
 * service workers get evicted, so nothing may live in the background worker).
 */
'use strict';

const EASES = ['linear', ...Object.keys(globalThis.TapewormEasing.NAMED)];
const $ = (id) => document.getElementById(id);

let tabId = null;
let state = {
  url: '',
  title: '',
  settings: { width: 1280, height: 800, dpr: 2, fps: 60 },
  steps: [{ type: 'start', at: 'top', hold: 0.8 }],
};
let totalSec = 0;
let playing = false;
let picking = null; // null | 'move' | 'click' | 'hover'

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
  if (msg.type === 'preview:time') onPreviewTime(d);
  if (msg.type === 'preview:ended') { playing = false; $('play').textContent = '▶ Preview'; }
  if (msg.type === 'page:info') onPageInfo(d);
});

// ---------------------------------------------------------------- state
async function saveState() {
  await chrome.storage.session.set({ ['doc:' + tabId]: state });
}

async function loadState() {
  const got = await chrome.storage.session.get('doc:' + tabId);
  if (got['doc:' + tabId]) state = got['doc:' + tabId];
}

function stripInternal(step) {
  const out = {};
  for (const k of Object.keys(step)) if (!k.startsWith('_') && step[k] !== undefined) out[k] = step[k];
  return out;
}

// ---------------------------------------------------------------- events from the page
function onPicked(d) {
  if (d.mode === 'click' || d.mode === 'hover') {
    state.steps.push({ type: d.mode, target: d.anchor, _quality: d.quality });
    setPicking(null); // interactions arm for ONE pick — back to normal after
    send('picker:stop');
  } else {
    state.steps.push({ type: 'move', to: d.anchor, ease: 'inOutCubic', _quality: d.quality });
  }
  saveState();
  renderSteps();
  refreshDuration();
}

function onPageInfo(d) {
  state.url = d.url || state.url;
  state.title = d.title || state.title;
  $('page-title').textContent = state.title || state.url;
  $('gate-note').hidden = !d.scrollGated;
  if (d.window) {
    const s = $('vp-status');
    if (d.viewportMatched) {
      s.className = 'ok';
      s.textContent = d.window.width + '×' + d.window.height + ' ✓';
    } else {
      s.className = 'bad';
      s.textContent = d.window.width + '×' + d.window.height + ' ✗';
    }
  }
  saveState();
}

/**
 * The render always captures the full viewport at the configured size, and CSS
 * breakpoints mean a page laid out in a bigger window is a DIFFERENT page. So:
 * resize the browser window until the page viewport equals the render target.
 * Two passes, because window chrome (tab strip, bookmarks bar) is only
 * measurable as the outer/inner difference after the first resize.
 */
async function fitWindow() {
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
  if (info) {
    onPageInfo(info);
    if (!info.viewportMatched) {
      $('vp-status').textContent += ' — screen too small for ' +
        state.settings.width + '×' + state.settings.height;
    }
  }
}

function onPreviewTime(d) {
  totalSec = d.total;
  $('scrub').value = String(Math.round((d.t / d.total) * 1000));
  $('time').textContent = d.t.toFixed(1) + 's / ' + d.total.toFixed(1) + 's';
}

// ---------------------------------------------------------------- steps UI
function anchorLabel(a) {
  if (typeof a === 'string') return a;
  if (typeof a === 'number') return a + 'px';
  return a.selector + (a.nth ? ' [' + a.nth + ']' : '');
}

function renderSteps() {
  const ol = $('steps');
  ol.innerHTML = '';
  state.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    if (step.type === 'start') {
      li.append(row(
        span('sel', 'start at ' + anchorLabel(step.at)),
        field('hold s', numInput(step.hold, 0.8, (v) => { step.hold = v; commit(); })),
      ));
    } else if (step.type === 'hold') {
      li.append(row(
        span('sel', 'hold'),
        field('seconds', numInput(step.seconds, 1, (v) => { step.seconds = v == null ? 1 : v; commit(); })),
        icons(i),
      ));
    } else if (step.type === 'move') {
      const sel = span('sel', anchorLabel(step.to));
      sel.title = 'Jump the page to this anchor';
      sel.addEventListener('click', () => send('jump', { anchor: step.to }));
      const badges = [];
      if (step._quality) badges.push(badge(step._quality));
      if (typeof step.to === 'object' && step.to.fallbackText) sel.title += '\n"' + step.to.fallbackText + '"';
      li.append(row(sel, ...badges, icons(i)));
      const align = selectInput(['top', 'center', 'bottom'], (typeof step.to === 'object' && step.to.align) || 'top', (v) => {
        if (typeof step.to === 'object') { if (v === 'top') delete step.to.align; else step.to.align = v; commit(); }
      });
      const offset = numInput(typeof step.to === 'object' ? step.to.offset : undefined, 0, (v) => {
        if (typeof step.to === 'object') { if (v == null || v === 0) delete step.to.offset; else step.to.offset = v; commit(); }
      });
      li.append(row(
        field('align', align),
        field('offset px', offset),
        field('duration s (auto)', numInput(step.duration, '', (v) => { step.duration = v == null ? undefined : v; commit(); })),
        field('ease', selectInput(EASES, step.ease || 'inOutCubic', (v) => { step.ease = v; commit(); })),
        field('hold s', numInput(step.hold, '', (v) => { step.hold = v == null ? undefined : v; commit(); })),
      ));
    } else if (step.type === 'click' || step.type === 'hover') {
      const sel = span('sel', (step.type === 'click' ? '⊕ click ' : '⊙ hover ') + anchorLabel(step.target));
      sel.title = 'Jump the page to this element';
      sel.addEventListener('click', () => send('jump', { anchor: step.target }));
      const badges = step._quality ? [badge(step._quality)] : [];
      li.append(row(sel, ...badges, icons(i)));
      li.append(row(
        field('settle s', numInput(step.settle, '0.6', (v) => { step.settle = v == null ? undefined : v; commit(); })),
        span('sel', step.type === 'hover'
          ? 'emulated in preview; real input in render'
          : 'emulated in preview (effects persist — reload to reset); real input in render'),
      ));
    } else {
      li.append(row(span('sel', step.type + ' (not executable yet)'), badge('warn'), icons(i)));
    }
    ol.appendChild(li);
  });

  function row(...kids) { const d = document.createElement('div'); d.className = 'row'; d.append(...kids); return d; }
  function span(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
  function badge(q) { const b = document.createElement('span'); b.className = 'badge ' + q; b.textContent = q === 'structural' ? 'fragile' : q; return b; }
  function field(label, input) {
    const w = document.createElement('label'); w.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    w.append(t, input); return w;
  }
  function numInput(value, placeholder, onChange) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.className = 'num';
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
  function icons(i) {
    const wrap = document.createElement('span');
    wrap.style.marginLeft = 'auto';
    wrap.append(
      iconBtn('↑', 'Move up', () => { if (i > 1) { swap(i, i - 1); } }),
      iconBtn('↓', 'Move down', () => { if (i < state.steps.length - 1) { swap(i, i + 1); } }),
      iconBtn('✕', 'Remove', () => { state.steps.splice(i, 1); commit(); }),
    );
    return wrap;
  }
  function iconBtn(txt, title, fn) {
    const b = document.createElement('button');
    b.className = 'icon'; b.textContent = txt; b.title = title;
    b.addEventListener('click', fn);
    return b;
  }
  function swap(a, b) { const t = state.steps[a]; state.steps[a] = state.steps[b]; state.steps[b] = t; commit(); }
}

function commit() {
  saveState();
  renderSteps();
  refreshDuration();
}

async function refreshDuration() {
  const r = await send('duration', { steps: state.steps.map(stripInternal) });
  if (r && typeof r.total === 'number') {
    totalSec = r.total;
    $('time').textContent = '0.0s / ' + r.total.toFixed(1) + 's';
    $('scrub').disabled = state.steps.length < 2;
  }
}

// ---------------------------------------------------------------- toolbar
function setPicking(mode) {
  picking = mode;
  $('pick').classList.toggle('active', mode === 'move');
  $('pick').textContent = mode === 'move' ? '✕ Stop picking (Esc)' : '＋ Pick element';
  $('arm-click').classList.toggle('active', mode === 'click');
  $('arm-hover').classList.toggle('active', mode === 'hover');
}

async function armPicker(mode) {
  if (picking === mode) {
    setPicking(null);
    await send('picker:stop');
    return;
  }
  setPicking(mode);
  await send('picker:start', { mode });
}

$('pick').addEventListener('click', () => armPicker('move'));
$('arm-click').addEventListener('click', () => armPicker('click'));
$('arm-hover').addEventListener('click', () => armPicker('hover'));

$('fit').addEventListener('click', fitWindow);

$('preset').addEventListener('change', async () => {
  const v = $('preset').value;
  if (!v) return;
  const [w, h] = v.split('x').map(Number);
  state.settings.width = w;
  state.settings.height = h;
  $('s-width').value = String(w);
  $('s-height').value = String(h);
  await saveState();
  await send('settings', state.settings);
  await fitWindow();
  $('preset').value = '';
});

$('prepare').addEventListener('click', async () => {
  $('prepare').disabled = true;
  $('prepare').textContent = '⟳ Preparing…';
  await send('prepare');
  $('prepare').disabled = false;
  $('prepare').textContent = '⟳ Prepare page';
});

$('add-hold').addEventListener('click', () => {
  state.steps.push({ type: 'hold', seconds: 1 });
  commit();
});

$('play').addEventListener('click', async () => {
  if (playing) {
    playing = false;
    $('play').textContent = '▶ Preview';
    await send('preview:stop');
    return;
  }
  const r = await send('preview:play', { steps: state.steps.map(stripInternal) });
  if (r) { playing = true; $('play').textContent = '■ Stop'; }
});

$('scrub').addEventListener('input', async () => {
  if (playing) { playing = false; $('play').textContent = '▶ Preview'; }
  const t = (Number($('scrub').value) / 1000) * totalSec;
  const r = await send('preview:seek', { steps: state.steps.map(stripInternal), t });
  if (r) $('time').textContent = r.t.toFixed(1) + 's / ' + r.total.toFixed(1) + 's';
});

for (const [id, key] of [['s-width', 'width'], ['s-height', 'height'], ['s-dpr', 'dpr'], ['s-fps', 'fps']]) {
  $(id).addEventListener('change', async () => {
    state.settings[key] = Number($(id).value);
    await saveState();
    await send('settings', state.settings);
    const info = await send('info');
    if (info) onPageInfo(info);
  });
}

// ---------------------------------------------------------------- export
async function buildConfig() {
  const info = await send('info');
  const url = (info && info.url) || state.url;
  return {
    url,
    viewport: { width: state.settings.width, height: state.settings.height, dpr: state.settings.dpr },
    fps: state.settings.fps,
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

$('export').addEventListener('click', async () => {
  const cfg = await buildConfig();
  const blob = new Blob([JSON.stringify(cfg, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportBasename(cfg.url) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('copy-cmd').addEventListener('click', async () => {
  const cfg = await buildConfig();
  const base = exportBasename(cfg.url);
  // Self-contained: the config rides along on stdin via a heredoc, so nothing
  // needs to exist on disk. The quoted delimiter keeps the shell's hands off
  // the JSON. node bin/…, not npx: the package isn't published yet.
  const cmd =
    `node bin/tapeworm.ts - --out ${base}.mp4 <<'TAPEWORM'\n` +
    JSON.stringify(cfg, null, 2) +
    `\nTAPEWORM`;
  await navigator.clipboard.writeText(cmd);
  $('copy-cmd').textContent = 'Copied ✓';
  setTimeout(() => { $('copy-cmd').textContent = 'Copy command'; }, 1200);
});

$('copy').addEventListener('click', async () => {
  const cfg = await buildConfig();
  await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2) + '\n');
  $('copy').textContent = 'Copied ✓';
  setTimeout(() => { $('copy').textContent = 'Copy JSON'; }, 1200);
});

$('clear').addEventListener('click', () => {
  state.steps = [{ type: 'start', at: 'top', hold: 0.8 }];
  commit();
});

// ---------------------------------------------------------------- boot
const CONTENT_SCRIPTS = [
  'shared/easing-core.js',
  'shared/anchor-core.js',
  'shared/selector.js',
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
      'Switch to the page you want to film and click the tapeworm toolbar icon there ' +
      '(that grants access to that tab), or try the button below.';
    if (url.startsWith('file:')) {
      hint = 'This is a file:// page: enable "Allow access to file URLs" for this extension in chrome://extensions, then attach again.';
    }
    msgEl.textContent = 'Couldn\'t attach to this page. ' + hint + ' (' + err + ')';
    noteEl.hidden = false;
    return false;
  }
}

async function syncPage() {
  await loadState();
  for (const [id, key] of [['s-width', 'width'], ['s-height', 'height'], ['s-dpr', 'dpr'], ['s-fps', 'fps']]) {
    $(id).value = String(state.settings[key]);
  }
  renderSteps();
  const info = await send('info');
  if (info) onPageInfo(info);
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
        'you want to film and click the tapeworm toolbar icon there.';
      $('inject-note').hidden = false;
    } else {
      await attach(); // no worker error recorded — likely a stale panel; try directly
    }
  }
  await syncPage();
})();
