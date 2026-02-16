import { createRNNWasmModule } from "./rnnoise.js";

const FRAME_SIZE = 480;
const RNNOISE_RATE = 48000;

class SampleQueue {
  constructor(capacity = 8192) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.length = 0;
  }

  clear() {
    this.head = 0;
    this.tail = 0;
    this.length = 0;
  }

  ensureCapacity(extra) {
    if (this.length + extra <= this.capacity) return;
    let newCapacity = this.capacity;
    while (newCapacity < this.length + extra) newCapacity *= 2;
    const next = new Float32Array(newCapacity);
    for (let i = 0; i < this.length; i += 1) {
      next[i] = this.buffer[(this.head + i) % this.capacity];
    }
    this.buffer = next;
    this.capacity = newCapacity;
    this.head = 0;
    this.tail = this.length;
  }

  pushArray(values) {
    this.ensureCapacity(values.length);
    for (let i = 0; i < values.length; i += 1) {
      this.buffer[this.tail] = values[i];
      this.tail = (this.tail + 1) % this.capacity;
      this.length += 1;
    }
  }

  shiftInto(output) {
    let count = 0;
    for (; count < output.length && this.length > 0; count += 1) {
      output[count] = this.buffer[this.head];
      this.head = (this.head + 1) % this.capacity;
      this.length -= 1;
    }
    return count;
  }
}

class LinearResampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.buffer = new Float32Array(0);
    this.length = 0;
    this.pos = 0;
  }

  reset() {
    this.length = 0;
    this.pos = 0;
  }

  append(input) {
    if (!input || input.length === 0) return;
    const needed = this.length + input.length;
    if (this.buffer.length < needed) {
      const next = new Float32Array(Math.max(needed, this.buffer.length * 2 || 1024));
      if (this.length > 0) {
        next.set(this.buffer.subarray(0, this.length), 0);
      }
      this.buffer = next;
    }
    this.buffer.set(input, this.length);
    this.length += input.length;
  }

  process(input) {
    this.append(input);
    const output = [];
    while (this.pos + 1 < this.length) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const a = this.buffer[idx];
      const b = this.buffer[idx + 1];
      output.push(a + (b - a) * frac);
      this.pos += this.ratio;
    }
    const consumed = Math.floor(this.pos);
    if (consumed > 0) {
      if (consumed < this.length) {
        this.buffer.copyWithin(0, consumed, this.length);
      }
      this.length -= consumed;
      this.pos -= consumed;
    }
    return new Float32Array(output);
  }
}

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.enabled = true;
    this.module = null;
    this.state = [];
    this.inBuffer = [];
    this.inIndex = [];
    this.outputQueue = [];
    this.upResampler = [];
    this.downResampler = [];
    this.inPtr = 0;
    this.outPtr = 0;
    this.inHeap = null;
    this.outHeap = null;
    this.useResample = sampleRate !== RNNOISE_RATE;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "init") {
        this.init(data.wasmUrl);
      }
      if (data.type === "enable") {
        this.enabled = Boolean(data.enabled);
        if (!this.enabled) {
          this.resetBuffers();
        }
      }
    };
  }

  async init(wasmUrl) {
    if (this.ready) return;
    try {
      const response = await fetch(wasmUrl);
      const wasmBinary = await response.arrayBuffer();
      this.module = await createRNNWasmModule({ wasmBinary });
      this.inPtr = this.module._malloc(FRAME_SIZE * 4);
      this.outPtr = this.module._malloc(FRAME_SIZE * 4);
      this.inHeap = this.module.HEAPF32.subarray(
        this.inPtr / 4,
        this.inPtr / 4 + FRAME_SIZE
      );
      this.outHeap = this.module.HEAPF32.subarray(
        this.outPtr / 4,
        this.outPtr / 4 + FRAME_SIZE
      );
      this.ready = true;
      this.port.postMessage({ type: "rnnoise-ready", sampleRate });
    } catch (err) {
      this.port.postMessage({
        type: "rnnoise-error",
        message: String(err && err.message ? err.message : err),
      });
    }
  }

  ensureChannel(channel) {
    if (!this.inBuffer[channel]) {
      this.inBuffer[channel] = new Float32Array(FRAME_SIZE);
      this.inIndex[channel] = 0;
      this.outputQueue[channel] = new SampleQueue();
      if (this.useResample) {
        this.upResampler[channel] = new LinearResampler(sampleRate, RNNOISE_RATE);
        this.downResampler[channel] = new LinearResampler(RNNOISE_RATE, sampleRate);
      }
    }
    if (!this.state[channel] && this.module) {
      this.state[channel] = this.module._rnnoise_create();
    }
  }

  resetBuffers() {
    for (let i = 0; i < this.inBuffer.length; i += 1) {
      if (this.inIndex[i] !== undefined) this.inIndex[i] = 0;
      if (this.outputQueue[i]) this.outputQueue[i].clear();
      if (this.upResampler[i]) this.upResampler[i].reset();
      if (this.downResampler[i]) this.downResampler[i].reset();
    }
  }

  processChannel(input, output, channel) {
    this.ensureChannel(channel);
    const inBuffer = this.inBuffer[channel];
    let inIndex = this.inIndex[channel];
    const outQueue = this.outputQueue[channel];
    const upSamples = this.useResample
      ? this.upResampler[channel].process(input)
      : input;

    for (let i = 0; i < upSamples.length; i += 1) {
      inBuffer[inIndex++] = upSamples[i];
      if (inIndex >= FRAME_SIZE) {
        this.inHeap.set(inBuffer);
        this.module._rnnoise_process_frame(this.state[channel], this.outPtr, this.inPtr);
        if (this.useResample) {
          const down = this.downResampler[channel].process(this.outHeap);
          outQueue.pushArray(down);
        } else {
          outQueue.pushArray(this.outHeap);
        }
        inIndex = 0;
      }
    }

    this.inIndex[channel] = inIndex;
    const written = outQueue.shiftInto(output);
    if (written < output.length) {
      output.set(input.subarray(written), written);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    const channels = Math.min(input.length, output.length);
    for (let c = 0; c < channels; c += 1) {
      const inCh = input[c];
      const outCh = output[c];
      if (!this.enabled || !this.ready) {
        outCh.set(inCh);
      } else {
        this.processChannel(inCh, outCh, c);
      }
    }
    return true;
  }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
