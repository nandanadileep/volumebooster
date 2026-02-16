import { createRNNWasmModule } from "./rnnoise.js";

const FRAME_SIZE = 480;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.enabled = true;
    this.supported = sampleRate === 48000;
    this.module = null;
    this.state = [];
    this.inBuffer = [];
    this.inIndex = [];
    this.outBuffer = [];
    this.outIndex = [];
    this.outAvailable = [];
    this.inPtr = 0;
    this.outPtr = 0;
    this.inHeap = null;
    this.outHeap = null;

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

    if (!this.supported) {
      this.port.postMessage({ type: "rnnoise-unsupported", sampleRate });
    }
  }

  async init(wasmUrl) {
    if (this.ready || !this.supported) return;
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
      this.port.postMessage({ type: "rnnoise-ready" });
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
      this.outBuffer[channel] = new Float32Array(FRAME_SIZE);
      this.outIndex[channel] = 0;
      this.outAvailable[channel] = false;
    }
    if (!this.state[channel] && this.module) {
      this.state[channel] = this.module._rnnoise_create();
    }
  }

  resetBuffers() {
    for (let i = 0; i < this.inBuffer.length; i += 1) {
      this.inIndex[i] = 0;
      this.outIndex[i] = 0;
      this.outAvailable[i] = false;
    }
  }

  processChannel(input, output, channel) {
    this.ensureChannel(channel);
    const inBuffer = this.inBuffer[channel];
    const outBuffer = this.outBuffer[channel];
    let inIndex = this.inIndex[channel];
    let outIndex = this.outIndex[channel];
    let outAvailable = this.outAvailable[channel];

    for (let i = 0; i < input.length; i += 1) {
      inBuffer[inIndex++] = input[i];

      if (outAvailable) {
        output[i] = outBuffer[outIndex++];
        if (outIndex >= FRAME_SIZE) {
          outIndex = 0;
          outAvailable = false;
        }
      } else {
        output[i] = input[i];
      }

      if (inIndex >= FRAME_SIZE) {
        this.inHeap.set(inBuffer);
        this.module._rnnoise_process_frame(this.state[channel], this.outPtr, this.inPtr);
        outBuffer.set(this.outHeap);
        inIndex = 0;
        outIndex = 0;
        outAvailable = true;
      }
    }

    this.inIndex[channel] = inIndex;
    this.outIndex[channel] = outIndex;
    this.outAvailable[channel] = outAvailable;
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
      if (!this.supported || !this.enabled || !this.ready) {
        outCh.set(inCh);
      } else {
        this.processChannel(inCh, outCh, c);
      }
    }
    return true;
  }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
