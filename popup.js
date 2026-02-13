const slider = document.getElementById("boost");
const valueLabel = document.getElementById("boost-value");
const status = document.getElementById("status");
const resetBtn = document.getElementById("reset");

function setLabel(value) {
  valueLabel.textContent = `${value}x`;
}

async function load() {
  const data = await chrome.storage.sync.get("boost");
  const boost = typeof data.boost === "number" ? data.boost : 1.0;
  slider.value = String(boost);
  setLabel(boost);
}

async function apply(value) {
  const numeric = Number(value);
  setLabel(numeric);
  await chrome.storage.sync.set({ boost: numeric });

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) {
    status.textContent = "No active tab";
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SET_BOOST", value: numeric });
    status.textContent = "Applied";
  } catch (err) {
    status.textContent = "Reload tab to apply";
  }
}

slider.addEventListener("input", (e) => {
  setLabel(e.target.value);
});

slider.addEventListener("change", (e) => {
  apply(e.target.value);
});

resetBtn.addEventListener("click", () => {
  slider.value = "1.0";
  apply(1.0);
});

document.addEventListener("DOMContentLoaded", load);
