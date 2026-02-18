# V2 ML Upgrade: DeepFilterNet2 vs DNS-Style

## Goal
Upgrade the speech enhancement stage for meetings with **higher-quality denoise + mild dereverb**, while staying real‑time in a browser.

## Comparison Summary
- **DeepFilterNet2**: Real‑time‑oriented architecture, smaller model footprint, and better suited for low‑latency in browser runtimes.
- **DNS‑style models**: Often heavier; may deliver strong denoise but typically at higher CPU/GPU cost and latency.

## Feasibility (WebGPU/WASM)
**Preferred runtime:** `onnxruntime-web` with WebGPU, WASM as fallback.

Target constraints:
- Keep per‑frame compute low enough for real‑time playback.
- Avoid >1 frame of algorithmic latency where possible.
- Budget for model size + initialization time in MV3.

## Fallback Strategy
If the ML model cannot load or runs too slow:
1. **Fallback to RNNoise** (current default ML).
2. Keep EQ/comp/limiter chain active for clarity.
3. Maintain limiter safety regardless of ML state.

## Next Steps
1. Add DeepFilterNet2 ONNX assets into `ml/dfn2/`. ✅
2. Integrate ONNX inference in a worker (WASM). ✅
3. Run A/B comparisons using `testing/v2_ml/compare_outputs.py`.

## Current Integration Notes
- Uses **ERB mask only** (deep filtering not yet applied).
- Runs in a **Worker + AudioWorklet** pipeline with fallback to RNNoise.
