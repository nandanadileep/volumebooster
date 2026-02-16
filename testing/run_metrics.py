#!/usr/bin/env python3
import argparse
import json
import math
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from pystoi import stoi

ROOT = Path(__file__).resolve().parent
AUDIO_DIR = ROOT / "audio"
CLEAN_AIFF = AUDIO_DIR / "clean.aiff"
CLEAN_WAV = AUDIO_DIR / "clean.wav"
PROCESSED_WAV = AUDIO_DIR / "processed.wav"
METRICS_JSON = ROOT / "metrics.json"

DEFAULT_TEXT = (
    "This is a sample speech clip for testing the volume booster. "
    "We are measuring clarity, loudness stability, and clipping."
)


def run(cmd):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result


def ensure_audio_dir():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def synthesize_speech(text, sample_rate=16000):
    if CLEAN_WAV.exists():
        return
    ensure_audio_dir()
    run(["say", "-o", str(CLEAN_AIFF), text])
    run([
        "afconvert",
        "-f",
        "WAVE",
        "-d",
        f"LEI16@{sample_rate}",
        str(CLEAN_AIFF),
        str(CLEAN_WAV),
    ])


def process_audio():
    ensure_audio_dir()
    if not CLEAN_WAV.exists():
        raise FileNotFoundError("clean.wav not found; run synthesize step first.")
    filters = (
        "highpass=f=90,"
        "lowshelf=f=250:g=-2.5,"
        "equalizer=f=3000:width_type=q:width=1.0:g=3.5,"
        "acompressor=threshold=-22dB:ratio=3:attack=3:release=250:knee=6,"
        "alimiter=limit=-1dB,"
        "volume=1.0"
    )
    start = time.perf_counter()
    run([
        "ffmpeg",
        "-y",
        "-i",
        str(CLEAN_WAV),
        "-filter_complex",
        filters,
        str(PROCESSED_WAV),
    ])
    elapsed = time.perf_counter() - start
    return elapsed


def get_lufs(path):
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


def compute_metrics(clean_path, processed_path, target_lufs=-18.0):
    clean, sr = sf.read(clean_path)
    processed, sr2 = sf.read(processed_path)
    if sr != sr2:
        raise ValueError("Sample rate mismatch")

    if clean.ndim > 1:
        clean = clean.mean(axis=1)
    if processed.ndim > 1:
        processed = processed.mean(axis=1)

    min_len = min(len(clean), len(processed))
    clean = clean[:min_len]
    processed = processed[:min_len]

    # Clipping percentage
    clip_threshold = 0.999
    clipping = float(np.mean(np.abs(processed) >= clip_threshold) * 100)

    # STOI
    stoi_score = float(stoi(clean, processed, sr, extended=False))

    # Latency estimate via cross-correlation
    corr = np.correlate(processed, clean, mode="full")
    lag = int(np.argmax(corr) - (len(clean) - 1))
    latency_ms = float((lag / sr) * 1000.0)

    # dLUFS/sec variance (approx using per-second RMS in dBFS)
    block = sr
    num_blocks = max(1, len(processed) // block)
    rms_values = []
    for i in range(num_blocks):
        segment = processed[i * block : (i + 1) * block]
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

    # LUFS error
    lufs = get_lufs(processed_path)
    lufs_error = float(lufs - target_lufs)

    duration = len(processed) / sr

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
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--target-lufs", type=float, default=-18.0)
    args = parser.parse_args()

    synthesize_speech(args.text)
    processing_time = process_audio()

    metrics = compute_metrics(CLEAN_WAV, PROCESSED_WAV, target_lufs=args.target_lufs)
    metrics["processing_time_sec"] = processing_time
    metrics["processing_time_per_sec"] = float(
        metrics["processing_time_sec"] / max(metrics["duration_sec"], 1e-6)
    )

    METRICS_JSON.write_text(json.dumps(metrics, indent=2))
    print("Metrics saved to", METRICS_JSON)
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
