/**
 * MV3 service worker — deliberately almost empty.
 *
 * The side panel is opened by Chrome itself on action click (setPanelBehavior),
 * because chrome.sidePanel.open() only works in the synchronous context of a
 * user gesture — any await before it and the gesture is spent, and the panel
 * silently never opens. Content-script injection happens from the panel's own
 * boot (the action click grants activeTab, which the panel inherits), which
 * also keeps this worker stateless — MV3 workers are evicted without warning.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
