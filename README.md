# Volume Boost

A Chromium-only extension for **per-tab volume control** with a lightweight speech-clarity chain and a draggable, on-page slider.

## Why This Project
I couldn’t find a **free volume enhancer** that was reliable, and I specifically wanted **different tabs at different volumes**. This extension solves both.

## Features
- **Per‑tab volume boost** with smooth auto‑gain (no pumping).
- **Speech Focus (🗣️)** for clarity using EQ + compression + limiter.
- **Limiter always engaged** for safe headroom and no clipping.
- **Draggable overlay** that works on any page.
- **Mute + Reset** controls with persistent settings.
- **Keyboard shortcuts** for quick control (customizable in `chrome://extensions/shortcuts`).

## Metrics (Harness)
From `testing/run_metrics.py` (DSP chain only):
- LUFS: **-18.1** (error **-0.1 LU**)
- dLUFS/sec variance: **1.354**
- STOI: **0.9655**
- Clipping: **0.0%**
- Latency: **4.75 ms**
- CPU (proc time/sec): **0.0154 s/sec**

> Note: The harness approximates the WebAudio chain with FFmpeg filters and a Python auto‑gain loop.

## How It Works
**Audio graph (Speech Focus ON):**
```
MediaElementSource → Gain → HPF → Low‑shelf → Presence EQ → Compressor → Limiter → Destination
```

**Audio graph (Speech Focus OFF):**
```
MediaElementSource → Gain → Limiter → Destination
```

**Auto‑gain:**
- Band‑limited RMS proxy (HPF ~120 Hz, LPF ~6 kHz).
- Slow control loop (400 ms window, 80 ms hop) with dB step limiting.
- Silence freeze to prevent gain creep during pauses.
- Output trim for LUFS centering.

## How To Use
1. Load the extension:
   - `chrome://extensions` → Developer mode → Load unpacked → `/Users/nandana/volumeboost`
2. Open any tab with audio.
3. Drag the floating bar anywhere.
4. Use the slider to boost, 🗣️ for clarity, 🔄 to reset, 🔇 to mute.

## Keyboard Shortcuts (Default)
- Toggle Speech Focus: `Ctrl+Shift+S`
- Toggle Mute: `Ctrl+Shift+M`
- Boost Up: `Ctrl+Shift+Up`
- Boost Down: `Ctrl+Shift+Down`

## Project Structure
- `content.js` — audio graph + overlay UI + messaging
- `testing/` — synthetic test harness and metrics
- `manifest.json` — MV3 config

## Notes
- Chromium‑only for now.
- Speech Focus defaults **ON**.
- Boost capped at **2.4x** for safety.
