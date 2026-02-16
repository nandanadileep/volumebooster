const slider = document.getElementById("boost");
const valueLabel = document.getElementById("boost-value");
const status = document.getElementById("status");
const clarityToggle = document.getElementById("clarity");
const resetBtn = document.getElementById("reset");
const muteBtn = document.getElementById("mute");
const sliderWrap = document.getElementById("boost-slider");
const panel = document.querySelector(".panel");
let muted = false;
let clarityEnabled = false;

function updateSliderUI(value) {
  const numeric = Number(value);
  if (!sliderWrap) return;
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 1;
  const percent = ((numeric - min) / (max - min)) * 100;
  sliderWrap.style.setProperty("--percent", `${percent}%`);
}

function updateLabel(value) {
  const numeric = Number(value);
  valueLabel.textContent = `${numeric.toFixed(1)}x`;
  updateSliderUI(numeric);
}

function setStatus(message, state = "error") {
  status.textContent = message || "";
  if (!message || !panel) return;
  panel.dataset.status = state;
}

function updateMuteUI(isMuted) {
  muted = isMuted;
  if (!muteBtn) return;
  muteBtn.textContent = muted ? "🔇" : "🔊";
  muteBtn.classList.toggle("is-active", muted);
  muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
}

function updateClarityUI(enabled) {
  clarityEnabled = enabled;
  if (!clarityToggle) return;
  clarityToggle.classList.toggle("is-active", clarityEnabled);
  clarityToggle.setAttribute("aria-label", clarityEnabled ? "Speech Focused On" : "Speech Focused Off");
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
  const data = await chrome.storage.local.get({ boost: 1.0, clarity: false, muted: false });
  slider.value = String(data.boost);
  updateLabel(data.boost);
  updateClarityUI(Boolean(data.clarity));
  updateMuteUI(Boolean(data.muted));
}

async function loadState() {
  const state = await sendToActiveTab({ type: "GET_STATE" });
  if (state && state.ok) {
    slider.value = String(state.boost ?? 1.0);
    updateLabel(slider.value);
    updateClarityUI(Boolean(state.clarity));
    updateMuteUI(Boolean(state.muted));
    if (state.blocked) {
      setStatus("Blocked", "error");
    } else if (state.audioState === "suspended") {
      setStatus("Click page to enable audio", "error");
    } else if (!state.hooked) {
      setStatus("Not hooked", "error");
    } else {
      const sources = state.sources ? ` • ${state.sources} source${state.sources === 1 ? "" : "s"}` : "";
      setStatus(`Applied${sources}`, "applied");
    }
    return;
  }
  await loadDefaults();
}

async function applyBoost(value) {
  const numeric = Number(value) || 1.0;
  updateLabel(numeric);
  await chrome.storage.local.set({ boost: numeric });
  const result = await sendToActiveTab({ type: "SET_BOOST", value: numeric });
  if (result.ok) await loadState();
}

async function applyClarity(enabled) {
  await chrome.storage.local.set({ clarity: Boolean(enabled) });
  const result = await sendToActiveTab({ type: "SET_CLARITY", enabled });
  if (result.ok) await loadState();
}

async function applyMute(nextMuted) {
  updateMuteUI(nextMuted);
  await chrome.storage.local.set({ muted: Boolean(nextMuted) });
  const result = await sendToActiveTab({ type: "SET_MUTE", muted: Boolean(nextMuted) });
  if (result.ok) await loadState();
}

slider.addEventListener("input", (e) => {
  updateLabel(e.target.value);
  setStatus("");
});

slider.addEventListener("pointerdown", () => {
  sliderWrap?.classList.add("dragging");
});

const stopDragging = () => {
  sliderWrap?.classList.remove("dragging");
};

slider.addEventListener("pointerup", stopDragging);
slider.addEventListener("pointerleave", stopDragging);

slider.addEventListener("change", (e) => {
  applyBoost(e.target.value);
});

clarityToggle.addEventListener("click", () => {
  applyClarity(!clarityEnabled);
});

resetBtn.addEventListener("click", () => {
  slider.value = "1.0";
  applyBoost(1.0);
});

muteBtn.addEventListener("click", () => {
  applyMute(!muted);
});

document.addEventListener("DOMContentLoaded", () => {
  loadState();
});
