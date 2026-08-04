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

O.mount((type, data) => {
  try { chrome.runtime.sendMessage({ from: 'tapeworm-overlay', type, data }); } catch (e) {}
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
    case 'preview:play': result = O.play(d.steps); break;
    case 'preview:seek': result = O.seek(d.steps, d.t); break;
    case 'preview:stop': O.stopPreview(); break;
    case 'jump': result = O.jump(d.anchor); break;
    case 'duration': result = O.duration(d.steps); break;
  }
  sendResponse(result);
  return false;
});
})();
