/**
 * MV3 service worker. Deliberately near-stateless: workers get evicted without
 * warning, so everything that matters lives in chrome.storage.session (owned by
 * the side panel) or in the content script's own memory.
 *
 * The content scripts are injected ON DEMAND when the user clicks the action —
 * that's what keeps the permission list at activeTab instead of host permissions,
 * which is what keeps the Web Store review path open.
 */

const CONTENT_SCRIPTS = [
  'shared/easing-core.js',
  'shared/anchor-core.js',
  'shared/selector.js',
  'content/overlay.js',
  'content/bridge.js',
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Remember which tab is being authored so the side panel can address it.
  await chrome.storage.session.set({ authoringTabId: tab.id });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_SCRIPTS,
    });
  } catch (e) {
    // chrome:// pages, the Web Store, PDFs — nothing we can do there.
    await chrome.storage.session.set({ injectError: String(e && e.message || e) });
  }

  // Must happen in the user-gesture context of the click.
  await chrome.sidePanel.open({ tabId: tab.id });
});
