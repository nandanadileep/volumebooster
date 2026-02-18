const RNNOISE_RATE = 48000;
const HOP_SIZE = 480;

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

class DFN2Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.ready = false;
    this.workerPort = null;
    this.useResample = sampleRate !== RNNOISE_RATE;
    this.upResampler = new LinearResampler(sampleRate, RNNOISE_RATE);
    this.downResampler = new LinearResampler(RNNOISE_RATE, sampleRate);
    this.inputQueue = new SampleQueue();
    this.outputQueue = new SampleQueue();
    this.pending = [];
    this.nextId = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "connect") {
        this.workerPort = data.port;
        this.workerPort.onmessage = (msg) => {
          const payload = msg.data || {};
          if (payload.type === "processed") {
            this.outputQueue.pushArray(payload.samples);
          }
          if (payload.type === "dfn2-ready") {
            this.ready = true;
            this.port.postMessage({ type: "dfn2-ready" });
          }
          if (payload.type === "dfn2-error") {
            this.ready = false;
            this.port.postMessage({ type: "dfn2-error", message: payload.message });
          }
        };
      }
      if (data.type === "enable") {
        this.enabled = Boolean(data.enabled);
        if (!this.enabled) {
          this.inputQueue.clear();
          this.outputQueue.clear();
          this.upResampler.reset();
          this.downResampler.reset();
        }
      }
    };
  }

  sendToWorker(chunk) {
    if (!this.workerPort) return;
    const id = this.nextId++;
    this.workerPort.postMessage({ type: "process", id, samples: chunk }, [chunk.buffer]);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const inCh = input[0];
    const outCh = output[0];

    if (!this.enabled || !this.ready || !this.workerPort) {
      for (let c = 0; c < output.length; c += 1) {
        output[c].set(input[c] || inCh);
      }
      return true;
    }

    const mono = new Float32Array(inCh.length);
    if (input.length === 1) {
      mono.set(inCh);
    } else {
      for (let i = 0; i < mono.length; i += 1) {
        let sum = 0;
        for (let c = 0; c < input.length; c += 1) {
          sum += input[c][i];
        }
        mono[i] = sum / input.length;
      }
    }

    const resampled = this.useResample ? this.upResampler.process(mono) : mono;
    this.inputQueue.pushArray(resampled);

    while (this.inputQueue.length >= HOP_SIZE) {
      const chunk = new Float32Array(HOP_SIZE);
      this.inputQueue.shiftInto(chunk);
      this.sendToWorker(chunk);
    }

    const processed = new Float32Array(outCh.length);
    let written = this.outputQueue.shiftInto(processed);
    if (written < processed.length) {
      processed.set(mono.subarray(written), written);
    }
    const down = this.useResample ? this.downResampler.process(processed) : processed;

    for (let c = 0; c < output.length; c += 1) {
      const channelOut = output[c];
      if (down.length === channelOut.length) {
        channelOut.set(down);
      } else {
        const min = Math.min(channelOut.length, down.length);
        channelOut.set(down.subarray(0, min));
        if (min < channelOut.length) {
          channelOut.fill(0, min);
        }
      }
    }

    return true;
  }
}

registerProcessor("dfn2-processor", DFN2Processor);
