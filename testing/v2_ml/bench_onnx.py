#!/usr/bin/env python3
import argparse
import time

import numpy as np


def parse_shape(value):
    if not value:
        return None
    return [int(part.strip()) for part in value.split(",") if part.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--input-shape", default="")
    parser.add_argument("--frames", type=int, default=200)
    args = parser.parse_args()

    try:
        import onnxruntime as ort
    except Exception as exc:
        raise SystemExit(
            "onnxruntime not installed. Install with: pip install onnxruntime"
        ) from exc

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    input_meta = sess.get_inputs()[0]
    input_name = input_meta.name
    shape = parse_shape(args.input_shape)
    if not shape:
        shape = []
        for dim in input_meta.shape:
            if isinstance(dim, int):
                shape.append(dim)
            else:
                shape.append(1)
    dummy = np.random.randn(*shape).astype(np.float32)

    # Warmup
    for _ in range(5):
        sess.run(None, {input_name: dummy})

    start = time.perf_counter()
    for _ in range(args.frames):
        sess.run(None, {input_name: dummy})
    elapsed = time.perf_counter() - start

    ms_per_frame = (elapsed / args.frames) * 1000.0
    print(f"Mean CPU time per frame: {ms_per_frame:.2f} ms")


if __name__ == "__main__":
    main()
