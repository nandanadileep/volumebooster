(() => {
  // Baseline content script scaffold.
  chrome.runtime.onMessage.addListener((_msg, _sender, sendResponse) => {
    sendResponse({ ok: true });
  });
})();
