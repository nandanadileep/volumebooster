async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function tryPing(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" });
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureOverlay() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    window.close();
    return;
  }

  const ok = await tryPing(tab.id);
  if (!ok) {
    chrome.tabs.reload(tab.id);
  }
  window.close();
}

document.addEventListener("DOMContentLoaded", ensureOverlay);
