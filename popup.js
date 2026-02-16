const slider = document.getElementById("boost");
const valueLabel = document.getElementById("boost-value");
const status = document.getElementById("status");
const clarityToggle = document.getElementById("clarity");
const resetBtn = document.getElementById("reset");
const muteBtn = document.getElementById("mute");

function updateLabel(value) {
  const numeric = Number(value);
  valueLabel.textContent = `${numeric.toFixed(1)}x`;
}

function setStatus(message) {
  status.textContent = message || "";
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendToActiveTab(payload) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus("No active tab");
    return { ok: false };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, payload);
    return response || { ok: true };
  } catch (err) {
    setStatus("Reload tab to apply");
    return { ok: false };
  }
}

async function loadDefaults() {
  const data = await chrome.storage.local.get({ boost: 1.0, clarity: false });
  slider.value = String(data.boost);
  updateLabel(data.boost);
  clarityToggle.checked = Boolean(data.clarity);
}

async function loadState() {
  const state = await sendToActiveTab({ type: "GET_STATE" });
  if (state && state.ok) {
    slider.value = String(state.boost ?? 1.0);
    updateLabel(slider.value);
    clarityToggle.checked = Boolean(state.clarity);
    setStatus(state.hooked ? "Applied" : "Not hooked");
    return;
  }
  await loadDefaults();
}

async function applyBoost(value) {
  const numeric = Number(value) || 1.0;
  updateLabel(numeric);
  await chrome.storage.local.set({ boost: numeric });
  const result = await sendToActiveTab({ type: "SET_BOOST", value: numeric });
  if (result.ok) setStatus("Applied");
}

async function applyClarity(enabled) {
  await chrome.storage.local.set({ clarity: Boolean(enabled) });
  const result = await sendToActiveTab({ type: "SET_CLARITY", enabled });
  if (result.ok) setStatus("Applied");
}

slider.addEventListener("input", (e) => {
  updateLabel(e.target.value);
  setStatus("");
});

slider.addEventListener("change", (e) => {
  applyBoost(e.target.value);
});

clarityToggle.addEventListener("change", (e) => {
  applyClarity(e.target.checked);
});

resetBtn.addEventListener("click", () => {
  slider.value = "1.0";
  applyBoost(1.0);
});

muteBtn.addEventListener("click", () => {
  setStatus("Mute not implemented");
});

document.addEventListener("DOMContentLoaded", () => {
  loadState();
});
