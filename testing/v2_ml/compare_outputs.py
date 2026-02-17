#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from pystoi import stoi


def get_lufs(path):
    import subprocess

    result = subprocess.run(
        [
            "ffmpeg",
            "-i",
            str(path),
            "-filter_complex",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)

    integrated = None
    for line in result.stderr.splitlines():
        if "I:" in line and "LUFS" in line:
            try:
                parts = line.split("I:")[-1].split("LUFS")[0].strip()
                integrated = float(parts)
            except Exception:
                continue
    if integrated is None:
        raise RuntimeError("Could not parse LUFS from ffmpeg output")
    return integrated


def compute_metrics(clean_path, enhanced_path, target_lufs=-18.0):
    clean, sr = sf.read(clean_path)
    enhanced, sr2 = sf.read(enhanced_path)
    if sr != sr2:
        raise ValueError("Sample rate mismatch")

    if clean.ndim > 1:
        clean = clean.mean(axis=1)
    if enhanced.ndim > 1:
        enhanced = enhanced.mean(axis=1)

    min_len = min(len(clean), len(enhanced))
    clean = clean[:min_len]
    enhanced = enhanced[:min_len]

    # Clipping percentage
    clip_threshold = 0.999
    clipping = float(np.mean(np.abs(enhanced) >= clip_threshold) * 100)

    # STOI
    stoi_score = float(stoi(clean, enhanced, sr, extended=False))

    # Latency estimate via cross-correlation
    corr = np.correlate(enhanced, clean, mode="full")
    lag = int(np.argmax(corr) - (len(clean) - 1))
    latency_ms = float((lag / sr) * 1000.0)

    # dLUFS/sec variance (approx using per-second RMS in dBFS)
    block = sr
    num_blocks = max(1, len(enhanced) // block)
    rms_values = []
    for i in range(num_blocks):
        segment = enhanced[i * block : (i + 1) * block]
        if len(segment) == 0:
            continue
        rms = math.sqrt(float(np.mean(segment ** 2)) + 1e-12)
        db = 20 * math.log10(rms + 1e-12)
        rms_values.append(db)
    rms_values = np.array(rms_values)
    if len(rms_values) > 1:
        diffs = np.diff(rms_values)
        dlufs_var = float(np.var(diffs))
    else:
        dlufs_var = 0.0

    # LUFS error (measured on enhanced output)
    lufs = get_lufs(enhanced_path)
    lufs_error = float(lufs - target_lufs)

    duration = len(enhanced) / sr

    return {
        "lufs": lufs,
        "lufs_error": lufs_error,
        "dlufs_sec_variance": dlufs_var,
        "stoi": stoi_score,
        "clipping_percent": clipping,
        "latency_ms": latency_ms,
        "duration_sec": duration,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", required=True)
    parser.add_argument("--a", required=True)
    parser.add_argument("--b", required=True)
    parser.add_argument("--label-a", default="ModelA")
    parser.add_argument("--label-b", default="ModelB")
    parser.add_argument("--target-lufs", type=float, default=-18.0)
    parser.add_argument("--out")
    args = parser.parse_args()

    metrics_a = compute_metrics(args.clean, args.a, target_lufs=args.target_lufs)
    metrics_b = compute_metrics(args.clean, args.b, target_lufs=args.target_lufs)

    payload = {
        "target_lufs": args.target_lufs,
        args.label_a: metrics_a,
        args.label_b: metrics_b,
    }

    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2))
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
