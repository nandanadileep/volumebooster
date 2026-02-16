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
from scipy.signal import butter, lfilter

ROOT = Path(__file__).resolve().parent
AUDIO_DIR = ROOT / "audio"
CLEAN_AIFF = AUDIO_DIR / "clean.aiff"
CLEAN_WAV = AUDIO_DIR / "clean.wav"
PROCESSED_WAV = AUDIO_DIR / "processed.wav"
PROCESSED_AUTOGAIN_WAV = AUDIO_DIR / "processed_autogain.wav"
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
    # Approximate the WebAudio chain with ffmpeg filters.
    # Note: ffmpeg acompressor knee range is limited; we use 6 dB as a proxy for WebAudio's 24 dB knee.
    filters = (
        "highpass=f=90,"
        "lowshelf=f=250:g=-2.5,"
        "equalizer=f=3000:width_type=q:width=1.0:g=3.5,"
        "acompressor=threshold=-28dB:ratio=2.2:attack=20:release=400:knee=6,"
        "alimiter=limit=-6dB,"
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


def bandpass_for_measurement(signal, sr):
    # Simple band-limiting to approximate K-weighting focus band.
    hp_b, hp_a = butter(2, 120 / (sr / 2), btype="highpass")
    lp_b, lp_a = butter(2, 6000 / (sr / 2), btype="lowpass")
    filtered = lfilter(hp_b, hp_a, signal)
    filtered = lfilter(lp_b, lp_a, filtered)
    return filtered


def apply_auto_gain(processed, sr, target_db=-18.0):
    # Mirror the in-extension control loop: hop 50ms, window ~300ms, slow attack/release.
    hop = int(sr * 0.07)
    window = int(sr * 0.4)
    target_db = float(target_db)
    output_trim_db = 0.5
    output_trim_gain = math.pow(10, output_trim_db / 20)
    min_gain = 0.6
    max_gain = 2.4
    attack = 0.3
    release = 0.6
    silence_db = -52
    silence_hold_ms = 400
    silence_resume_ms = 150
    max_up_db = 0.2
    max_down_db = 0.4

    filtered = bandpass_for_measurement(processed, sr)
    gains = np.ones_like(processed, dtype=np.float32)

    auto_gain = 1.0
    below_gate_ms = 0.0
    above_gate_ms = 0.0
    allow_increase = True
    for start in range(0, len(processed), hop):
        end = min(len(processed), start + window)
        segment = filtered[start:end]
        if len(segment) == 0:
            continue
        rms = math.sqrt(float(np.mean(segment ** 2)) + 1e-12)
        rms_db = 20 * math.log10(rms + 1e-12)

        hop_ms = (hop / sr) * 1000
        if rms_db < silence_db:
            below_gate_ms += hop_ms
            above_gate_ms = 0.0
        else:
            above_gate_ms += hop_ms
            below_gate_ms = 0.0

        if below_gate_ms >= silence_hold_ms:
            allow_increase = False
        elif not allow_increase and above_gate_ms >= silence_resume_ms:
            allow_increase = True

        desired_linear = math.pow(10, (target_db - rms_db) / 20)
        desired = max(min_gain, min(max_gain, desired_linear))
        current_db = 20 * math.log10(auto_gain + 1e-9)
        desired_db = 20 * math.log10(desired + 1e-9)
        diff_db = desired_db - current_db
        tau = attack if diff_db > 0 else release
        coeff = 1 - math.exp(-(hop / sr) / tau)
        delta_db = diff_db * coeff
        if not allow_increase and delta_db > 0:
            delta_db = 0
        delta_db = max(-max_down_db, min(max_up_db, delta_db))
        next_db = current_db + delta_db
        auto_gain = math.pow(10, next_db / 20)
        auto_gain = max(min_gain, min(max_gain, auto_gain))

        gains[start:end] = auto_gain * output_trim_gain

    return processed * gains


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

    # Apply auto-gain envelope (approximation)
    processed = apply_auto_gain(processed, sr, target_lufs)
    sf.write(PROCESSED_AUTOGAIN_WAV, processed, sr)

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

    # LUFS error (measured on auto-gained output)
    lufs = get_lufs(PROCESSED_AUTOGAIN_WAV)
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

    start_metrics = time.perf_counter()
    metrics = compute_metrics(CLEAN_WAV, PROCESSED_WAV, target_lufs=args.target_lufs)
    metrics_time = time.perf_counter() - start_metrics
    metrics["processing_time_sec"] = processing_time
    metrics["metrics_time_sec"] = metrics_time
    metrics["processing_time_per_sec"] = float(
        metrics["processing_time_sec"] / max(metrics["duration_sec"], 1e-6)
    )

    METRICS_JSON.write_text(json.dumps(metrics, indent=2))
    print("Metrics saved to", METRICS_JSON)
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
