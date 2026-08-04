/**
 * MV3 service worker. Two hard-won ordering rules live here:
 *
 * 1. chrome.sidePanel.open() must be the FIRST call in the click handler —
 *    any await before it spends the user gesture and the panel silently
 *    never opens.
 * 2. The click must be handled HERE, not via setPanelBehavior's
 *    openPanelOnActionClick: when Chrome opens the panel itself, the click
 *    does not reliably grant activeTab, and injection then fails with
 *    "Extension manifest must request permission to access the respective
 *    host". With action.onClicked the grant is certain, so the worker also
 *    does the injection.
 *
 * Otherwise stateless: MV3 workers are evicted without warning, so state
 * lives in chrome.storage.session, owned by the side panel.
 */

const CONTENT_SCRIPTS = [
  'shared/easing-core.js',
  'shared/anchor-core.js',
  'shared/selector.js',
  'content/overlay.js',
  'content/bridge.js',
];

// Undo any previously persisted openPanelOnActionClick, or onClicked won't fire.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.open({ tabId: tab.id }); // first — while the gesture is live
  chrome.storage.session.set({ authoringTabId: tab.id });
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS })
    .then(() => chrome.storage.session.remove('injectError'))
    .catch((e) => chrome.storage.session.set({ injectError: String((e && e.message) || e) }));
});
