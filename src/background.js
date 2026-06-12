// Service worker. The popup is opened directly by the toolbar action and the
// keyboard command (_execute_action), so the worker only handles first-run
// setup — it opens the options page once so the user can add or import apps.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
