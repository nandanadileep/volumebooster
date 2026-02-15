const slider = document.getElementById("boost");
const valueLabel = document.getElementById("boost-value");
const status = document.getElementById("status");

function updateLabel() {
  valueLabel.textContent = `${slider.value}x`;
}

slider.addEventListener("input", () => {
  updateLabel();
  status.textContent = "";
});

document.addEventListener("DOMContentLoaded", () => {
  updateLabel();
});
