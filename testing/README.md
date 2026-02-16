# Testing Harness

This folder contains a small harness to generate a speech sample, run the
current audio processing chain (approximation via ffmpeg filters), and compute
metrics:

- LUFS error (vs target)
- dLUFS/sec variance (approx using per-second RMS in dBFS)
- STOI
- Clipping %
- Latency (cross-correlation estimate)
- CPU (processing time per second of audio)

## Requirements (macOS)
- `say` and `afconvert` (built-in macOS)
- `ffmpeg`
- Python packages: `numpy`, `soundfile`, `pystoi`

## Run

```bash
python3 testing/run_metrics.py
```

Outputs results to `testing/metrics.json` and prints a summary.

## Notes
- The processing chain is an ffmpeg approximation of the extension DSP chain.
- dLUFS/sec variance is computed from per-second RMS (dBFS), not true LUFS.
