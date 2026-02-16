# Volume Boost

A Chromium-only extension that boosts per-tab audio and adds **speech-focused clarity** for meetings, with a draggable overlay UI.

## Features
- **Per-tab volume boost** with a smooth, low‑pumping auto-gain controller.
- **Speech Focus (🗣️)** toggle for clarity: RNNoise ML denoise + EQ/comp/limiter chain.
- **Limiter always engaged** for safe headroom and no clipping.
- **Draggable overlay** bar that works on any page.
- **Mute + Reset** controls with persistent settings.

## How It Works
**Audio graph (Speech Focus ON):**
```
MediaElementSource → RNNoise (WASM, AudioWorklet) → Gain → HPF → Low‑shelf → Presence EQ → Compressor → Limiter → Destination
```

**Audio graph (Speech Focus OFF):**
```
MediaElementSource → RNNoise (OFF) → Gain → Limiter → Destination
```

**Auto-gain:**
- Band‑limited RMS proxy (HPF ~120 Hz, LPF ~6 kHz).
- Slow control loop (400 ms window, 80 ms hop) with dB step limiting.
- Silence freeze to prevent gain creep during pauses.
- Output trim for LUFS centering.

**RNNoise ML:**
- Vendored locally (`ml/`) to comply with MV3 (no remote code).
- Runs in an AudioWorklet for low‑latency.
- **Resampling** added so it works at **44.1 kHz or 48 kHz** system output.

## Current Metrics (Harness)
From `testing/run_metrics.py` (DSP chain only; RNNoise not modeled in harness):
- LUFS: **-18.1** (error **-0.1 LU**)
- dLUFS/sec variance: **1.354**
- STOI: **0.9655**
- Clipping: **0.0%**
- Latency: **4.75 ms**
- CPU (proc time/sec): **0.0154 s/sec**

> Note: The harness approximates the WebAudio chain with FFmpeg filters and a Python auto‑gain loop. RNNoise (WASM) is not included in those metrics; evaluate ML impact by A/B listening in a noisy video.

## Manual Testing
1. Load extension:
   - `chrome://extensions` → Developer mode → Load unpacked → `/Users/nandana/volumeboost`
2. Open a noisy speech video (YouTube works well).
3. Toggle **🗣️ Speech Focus** and listen for reduced background noise + clearer voice.
4. Adjust boost and verify limiter keeps audio clean.

## Challenges & Mitigations
**1) ML in MV3 (no remote code)**
- **Challenge:** MV3 disallows loading remote JS/WASM.
- **Mitigation:** Vendored RNNoise assets into `ml/` and registered via `web_accessible_resources`.

**2) Sample‑rate mismatch (44.1 kHz vs 48 kHz)**
- **Challenge:** RNNoise expects 48 kHz frames.
- **Mitigation:** Added linear resampling in the AudioWorklet (upsample → RNNoise → downsample).

**3) Loudness wobble / pumping**
- **Challenge:** Fast gain changes create audible pumping.
- **Mitigation:** Slower control loop, dB step limiting, silence freeze, and limiter always engaged.

**4) Overlay usability**
- **Challenge:** Overlay could get clipped on resize.
- **Mitigation:** Clamp overlay position to viewport on window resize.

## Project Structure
- `content.js` — audio graph + overlay UI + messaging
- `ml/` — RNNoise WASM + worklet
- `testing/` — synthetic test harness and metrics
- `manifest.json` — MV3 config

## Notes
- Chromium‑only for now.
- Speech Focus defaults **ON**.
- Boost capped at **2.4x** for safety.
