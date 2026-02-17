# V2 ML Evaluation

This folder supports **model comparison** for V2 speech enhancement (DeepFilterNet2 vs DNS‑style).
You provide enhanced outputs, and the script reports comparable metrics.

## Layout
```
testing/v2_ml/
  models/          # Optional: ONNX models if you want to benchmark inference
  outputs/         # Enhanced audio outputs (wav)
  compare_outputs.py
  bench_onnx.py
```

## Compare Model Outputs
1. Produce two enhanced WAV files from the same clean input:
   - Example: `outputs/deepfilternet2.wav`, `outputs/dns_style.wav`
2. Run:
   ```
   python3 testing/v2_ml/compare_outputs.py \
     --clean testing/audio/clean.wav \
     --a testing/v2_ml/outputs/deepfilternet2.wav \
     --b testing/v2_ml/outputs/dns_style.wav \
     --label-a DeepFilterNet2 \
     --label-b DNS-Style
   ```

The script prints metrics for each model (LUFS, STOI, dLUFS/sec variance, clipping, latency).

## Inference Feasibility (ONNX CPU Baseline)
If you have an ONNX model file and want a rough baseline:
```
python3 testing/v2_ml/bench_onnx.py \
  --model testing/v2_ml/models/model.onnx \
  --input-shape 1,480 \
  --frames 200
```

This is **not WebGPU**, but gives a rough CPU bound. Use it to compare model sizes and
estimate whether WebGPU/WASM is likely to meet real‑time targets.
