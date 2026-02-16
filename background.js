const COMMANDS = {
  TOGGLE_SPEECH: "toggle_speech_focus",
  TOGGLE_MUTE: "toggle_mute",
  BOOST_UP: "boost_up",
  BOOST_DOWN: "boost_down",
  RESET_BOOST: "reset_boost",
};

function withActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    cb(tab.id);
  });
}

chrome.commands.onCommand.addListener((command) => {
  withActiveTab((tabId) => {
    switch (command) {
      case COMMANDS.TOGGLE_SPEECH:
        chrome.tabs.sendMessage(tabId, { type: "TOGGLE_CLARITY" });
        break;
      case COMMANDS.TOGGLE_MUTE:
        chrome.tabs.sendMessage(tabId, { type: "TOGGLE_MUTE" });
        break;
      case COMMANDS.BOOST_UP:
        chrome.tabs.sendMessage(tabId, { type: "ADJUST_BOOST", delta: 0.1 });
        break;
      case COMMANDS.BOOST_DOWN:
        chrome.tabs.sendMessage(tabId, { type: "ADJUST_BOOST", delta: -0.1 });
        break;
      case COMMANDS.RESET_BOOST:
        chrome.tabs.sendMessage(tabId, { type: "RESET_BOOST" });
        break;
      default:
        break;
    }
  });
});
