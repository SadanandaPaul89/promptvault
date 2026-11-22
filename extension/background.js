// Clicking the toolbar icon opens the side panel. Nothing else runs in the
// background: the extension only reads a page when the user clicks Analyze.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
