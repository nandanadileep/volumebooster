/* global ort */

let ortReady = false;
let encSession = null;
let erbSession = null;
let dfSession = null;
let modelBaseUrl = "";
let wasmBaseUrl = "";
let config = {
  sr: 48000,
  fftSize: 960,
  hopSize: 480,
  nbErb: 32,
};
let windowTable = null;
let cosTable = null;
let sinTable = null;
let erbFilters = null;
let erbWeightSum = null;
let frameBuffer = null;
let olaBuffer = null;
let workletPort = null;
let processing = false;
const queue = [];

function buildHannWindow(size) {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return win;
}

function buildTwiddles(size) {
  const cos = new Float32Array(size * size);
  const sin = new Float32Array(size * size);
  for (let k = 0; k < size; k += 1) {
    for (let n = 0; n < size; n += 1) {
      const angle = (2 * Math.PI * k * n) / size;
      cos[k * size + n] = Math.cos(angle);
      sin[k * size + n] = Math.sin(angle);
    }
  }
  return { cos, sin };
}

function erbScale(freq) {
  return 21.4 * Math.log10(1 + 0.00437 * freq);
}

function erbScaleInv(erb) {
  return (Math.pow(10, erb / 21.4) - 1) / 0.00437;
}

function buildErbFilterbank(sr, fftSize, nbErb) {
  const nBins = Math.floor(fftSize / 2) + 1;
  const erbMin = erbScale(0);
  const erbMax = erbScale(sr / 2);
  const erbPoints = new Float32Array(nbErb + 2);
  for (let i = 0; i < erbPoints.length; i += 1) {
    erbPoints[i] = erbMin + ((erbMax - erbMin) * i) / (nbErb + 1);
  }
  const hzPoints = Array.from(erbPoints, (erb) => erbScaleInv(erb));
  const filters = Array.from({ length: nbErb }, () => new Float32Array(nBins));
  const weightSum = new Float32Array(nBins);
  for (let band = 0; band < nbErb; band += 1) {
    const left = hzPoints[band];
    const center = hzPoints[band + 1];
    const right = hzPoints[band + 2];
    for (let bin = 0; bin < nBins; bin += 1) {
      const freq = (bin * sr) / fftSize;
      let weight = 0;
      if (freq >= left && freq <= center) {
        weight = (freq - left) / (center - left + 1e-8);
      } else if (freq > center && freq <= right) {
        weight = (right - freq) / (right - center + 1e-8);
      }
      if (weight > 0) {
        filters[band][bin] = weight;
        weightSum[bin] += weight;
      }
    }
  }
  return { filters, weightSum };
}

function dft(input, cos, sin) {
  const size = input.length;
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  for (let k = 0; k < size; k += 1) {
    let sumRe = 0;
    let sumIm = 0;
    const base = k * size;
    for (let n = 0; n < size; n += 1) {
      const sample = input[n];
      sumRe += sample * cos[base + n];
      sumIm -= sample * sin[base + n];
    }
    real[k] = sumRe;
    imag[k] = sumIm;
  }
  return { real, imag };
}

function idft(real, imag, cos, sin) {
  const size = real.length;
  const output = new Float32Array(size);
  for (let n = 0; n < size; n += 1) {
    let sum = 0;
    for (let k = 0; k < size; k += 1) {
      const base = k * size;
      sum += real[k] * cos[base + n] - imag[k] * sin[base + n];
    }
    output[n] = sum / size;
  }
  return output;
}

function buildSpecFeatures(real, imag) {
  const nBins = Math.floor(real.length / 2) + 1;
  const mag = new Float32Array(nBins);
  let energy = 0;
  for (let i = 0; i < nBins; i += 1) {
    const re = real[i];
    const im = imag[i];
    const m = Math.sqrt(re * re + im * im);
    mag[i] = m;
    energy += m * m;
  }
  const norm = Math.sqrt(energy / nBins) + 1e-8;
  const specData = new Float32Array(nBins * 2);
  for (let i = 0; i < nBins; i += 1) {
    specData[i] = real[i] / norm;
    specData[i + nBins] = imag[i] / norm;
  }
  return { mag, specData };
}

function buildErbFeatures(mag, filters) {
  const nbErb = filters.length;
  const feat = new Float32Array(nbErb);
  for (let band = 0; band < nbErb; band += 1) {
    let sum = 0;
    const weights = filters[band];
    for (let bin = 0; bin < mag.length; bin += 1) {
      const w = weights[bin];
      if (w > 0) sum += w * mag[bin] * mag[bin];
    }
    feat[band] = Math.log10(sum + 1e-8);
  }
  return feat;
}

function expandErbMask(maskErb, filters, weightSum) {
  const nBins = weightSum.length;
  const mask = new Float32Array(nBins);
  for (let bin = 0; bin < nBins; bin += 1) {
    let sum = 0;
    for (let band = 0; band < filters.length; band += 1) {
      const w = filters[band][bin];
      if (w > 0) sum += w * maskErb[band];
    }
    const denom = weightSum[bin] || 1e-6;
    mask[bin] = sum / denom;
  }
  return mask;
}

async function initOrt() {
  if (ortReady) return;
  importScripts(`${wasmBaseUrl}ort.min.js`);
  ort.env.wasm.wasmPaths = {
    "ort-wasm.wasm": `${wasmBaseUrl}ort-wasm.wasm`,
    "ort-wasm-simd.wasm": `${wasmBaseUrl}ort-wasm-simd.wasm`,
  };
  encSession = await ort.InferenceSession.create(`${modelBaseUrl}enc.onnx`, {
    executionProviders: ["wasm"],
  });
  erbSession = await ort.InferenceSession.create(`${modelBaseUrl}erb_dec.onnx`, {
    executionProviders: ["wasm"],
  });
  dfSession = await ort.InferenceSession.create(`${modelBaseUrl}df_dec.onnx`, {
    executionProviders: ["wasm"],
  });
  windowTable = buildHannWindow(config.fftSize);
  const twiddles = buildTwiddles(config.fftSize);
  cosTable = twiddles.cos;
  sinTable = twiddles.sin;
  const erb = buildErbFilterbank(config.sr, config.fftSize, config.nbErb);
  erbFilters = erb.filters;
  erbWeightSum = erb.weightSum;
  frameBuffer = new Float32Array(config.fftSize);
  olaBuffer = new Float32Array(config.fftSize);
  ortReady = true;
}

function pickOutput(result, session, hint) {
  const names = session.outputNames || Object.keys(result);
  const byHint = names.find((name) => name.includes(hint));
  return result[byHint || names[0]];
}

async function processFrame(frame) {
  const windowed = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    windowed[i] = frame[i] * windowTable[i];
  }
  const { real, imag } = dft(windowed, cosTable, sinTable);
  const { mag, specData } = buildSpecFeatures(real, imag);
  const erbFeat = buildErbFeatures(mag, erbFilters);

  const nBins = mag.length;
  const featErb = new ort.Tensor("float32", erbFeat, [1, 1, 1, config.nbErb]);
  const featSpec = new ort.Tensor("float32", specData, [1, 2, 1, nBins]);

  const encOut = await encSession.run({ feat_erb: featErb, feat_spec: featSpec });
  const emb = pickOutput(encOut, encSession, "emb");

  const erbOut = await erbSession.run({ emb });
  const maskTensor = pickOutput(erbOut, erbSession, "mask");
  const maskData = maskTensor.data;
  const maskErb = new Float32Array(config.nbErb);
  for (let i = 0; i < config.nbErb; i += 1) {
    maskErb[i] = maskData[i] ?? 1.0;
  }

  const maskFreq = expandErbMask(maskErb, erbFilters, erbWeightSum);
  const n = real.length;
  const maxBin = Math.floor(n / 2);
  for (let bin = 0; bin <= maxBin; bin += 1) {
    const g = maskFreq[bin] || 1.0;
    real[bin] *= g;
    imag[bin] *= g;
    if (bin > 0 && bin < maxBin) {
      const mirror = n - bin;
      real[mirror] *= g;
      imag[mirror] *= g;
    }
  }

  const time = idft(real, imag, cosTable, sinTable);
  for (let i = 0; i < time.length; i += 1) {
    time[i] *= windowTable[i];
  }
  return time;
}

async function handleChunk(chunk) {
  if (!ortReady) return chunk;
  frameBuffer.copyWithin(0, config.hopSize);
  frameBuffer.set(chunk, config.fftSize - config.hopSize);
  const enhanced = await processFrame(frameBuffer);
  for (let i = 0; i < config.fftSize; i += 1) {
    olaBuffer[i] += enhanced[i];
  }
  const output = olaBuffer.slice(0, config.hopSize);
  olaBuffer.copyWithin(0, config.hopSize);
  olaBuffer.fill(0, config.fftSize - config.hopSize);
  return output;
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const item = queue.shift();
    const output = await handleChunk(item.samples);
    workletPort.postMessage(
      { type: "processed", id: item.id, samples: output },
      [output.buffer]
    );
  }
  processing = false;
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "connect") {
    workletPort = data.port;
    workletPort.onmessage = (msg) => {
      const payload = msg.data || {};
      if (payload.type === "process") {
        queue.push({ id: payload.id, samples: payload.samples });
        drainQueue();
      }
    };
    return;
  }
  if (data.type === "init") {
    modelBaseUrl = data.modelBaseUrl;
    wasmBaseUrl = data.wasmBaseUrl;
    initOrt()
      .then(() => {
        if (workletPort) {
          workletPort.postMessage({ type: "dfn2-ready" });
        }
      })
      .catch((err) => {
        if (workletPort) {
          workletPort.postMessage({
            type: "dfn2-error",
            message: String(err && err.message ? err.message : err),
          });
        }
      });
  }
};
