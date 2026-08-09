/**
 * Chrome glue for the overlay: the ONLY content-script file that touches
 * chrome.* APIs. Everything real lives in overlay.js so `tapeworm author` can
 * host the identical overlay without an extension.
 */
(() => {
'use strict';
if (globalThis.__tapewormBridge) return;
globalThis.__tapewormBridge = true;

const O = globalThis.TapewormOverlay;

// Events travel over sendMessage rather than the lifeline port so the initial
// mount works before the panel has connected.
const emitToPanel = (type, data) => {
  try { chrome.runtime.sendMessage({ from: 'tapeworm-overlay', type, data }); } catch (e) {}
};

O.mount(emitToPanel);

// MV3 has no "side panel closed" event, so the panel holds a lifeline Port
// open for its whole lifetime (chrome.tabs.connect in panel.js) — the port
// dropping IS the close signal, and the overlay unmounts instead of haunting
// the page. A reopened panel connects again and remounts. A Set, not a flag:
// the new panel's connect can land before the old port's disconnect fires.
const lifelines = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tapeworm-lifeline') return;
  lifelines.add(port);
  O.mount(emitToPanel);
  port.onDisconnect.addListener(() => {
    lifelines.delete(port);
    if (lifelines.size === 0) O.destroy();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.to !== 'tapeworm-overlay') return false;
  const d = msg.data || {};
  if (msg.type === 'prepare') {
    O.prepare().then(sendResponse);
    return true; // async response
  }
  let result = null;
  switch (msg.type) {
    case 'settings': result = O.setSettings(d); break;
    case 'info': result = O.pageInfo(); break;
    case 'picker:start': O.startPicker(d.mode); break;
    case 'picker:stop': O.stopPicker(); break;
    case 'record:start': result = O.startRecording(); break;
    case 'record:stop': O.stopRecording(); break;
    case 'preview:play': result = O.play(d.steps, d.from); break;
    case 'preview:seek': result = O.seek(d.steps, d.t); break;
    case 'preview:stop': O.stopPreview(); break;
    case 'jump': result = O.jump(d.anchor); break;
    case 'duration': result = O.duration(d.steps); break;
    case 'assets': result = O.assets(); break;
  }
  sendResponse(result);
  return false;
});
})();
