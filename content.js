(() => {
  let audioCtx = null;
  let gainNode = null;
  let highpass = null;
  let mudCut = null;
  let presence = null;
  let compressor = null;
  let limiter = null;
  let analyser = null;
  let measureHighpass = null;
  let measureLowpass = null;
  let meterBuffer = null;
  let autoGainTimer = null;
  let autoGain = 1.0;
  let rnnoiseNode = null;
  let rnnoiseEnabled = false;
  let rnnoiseLoading = null;
  let rnnoiseReady = false;
  let dfn2Node = null;
  let dfn2Worker = null;
  let dfn2Enabled = false;
  let dfn2Loading = null;
  let dfn2Ready = false;
  const autoGainConfig = {
    enabled: true,
    targetDb: -18.0,
    outputTrimDb: 0.5,
    outputTrimGain: Math.pow(10, 0.5 / 20),
    min: 0.6,
    max: 2.4,
    hopMs: 80,
    attackSec: 0.3,
    releaseSec: 0.6,
    maxStep: 0.08,
    silenceDb: -52,
    silenceHoldMs: 400,
    silenceResumeMs: 150,
    maxUpDbPerUpdate: 0.15,
    maxDownDbPerUpdate: 0.35,
  };
  let clarityEnabled = false;
  let boostValue = 1.0;
  let muted = false;
  let blocked = false;
  let lastHookError = "";
  const sources = new Map();
  const RNNOISE_WORKLET_URL = chrome.runtime.getURL("ml/rnnoise-worklet.js");
  const RNNOISE_WASM_URL = chrome.runtime.getURL("ml/rnnoise.wasm");
  const DFN2_WORKLET_URL = chrome.runtime.getURL("ml/dfn2-worklet.js");
  const DFN2_WORKER_URL = chrome.runtime.getURL("ml/dfn2-worker.js");
  const DFN2_MODEL_URL = chrome.runtime.getURL("ml/dfn2/");
  const ORT_WASM_URL = chrome.runtime.getURL("ml/");
  let overlay = null;
  let overlayDragging = false;
  let overlayPendingDrag = false;
  let overlayDragFromInput = false;
  let resetFlashTimer = null;
  let overlayDragStart = { x: 0, y: 0 };
  let overlayDragOffset = { x: 0, y: 0 };
  const OVERLAY_POS_KEY = "overlayPos";
  const OVERLAY_DEFAULT_POS = { x: 24, y: 24 };

  function disconnectSafely(node) {
    try {
      node.disconnect();
    } catch (err) {
      // Ignore disconnect errors.
    }
  }

  function getInputNode() {
    if (dfn2Enabled && dfn2Ready && dfn2Node) return dfn2Node;
    if (rnnoiseEnabled && rnnoiseNode) return rnnoiseNode;
    return gainNode;
  }

  function rewireSources() {
    const inputNode = getInputNode();
    for (const source of sources.values()) {
      disconnectSafely(source);
      try {
        source.connect(inputNode);
      } catch (err) {
        // Ignore reconnect errors.
      }
    }
  }

  function ensureRnnoiseNode() {
    if (!audioCtx || rnnoiseNode || rnnoiseLoading || !rnnoiseEnabled) return;
    rnnoiseLoading = audioCtx.audioWorklet
      .addModule(RNNOISE_WORKLET_URL)
      .then(() => {
        rnnoiseNode = new AudioWorkletNode(audioCtx, "rnnoise-processor");
        rnnoiseNode.port.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === "rnnoise-ready") {
            rnnoiseReady = true;
            rewireSources();
          }
          if (data.type === "rnnoise-error" || data.type === "rnnoise-unsupported") {
            rnnoiseEnabled = false;
            rnnoiseReady = false;
            rnnoiseNode = null;
            rnnoiseLoading = null;
            rewireSources();
          }
        };
        rnnoiseNode.port.postMessage({ type: "init", wasmUrl: RNNOISE_WASM_URL });
        connectGraph();
        rewireSources();
        rnnoiseLoading = null;
      })
      .catch(() => {
        rnnoiseEnabled = false;
        rnnoiseReady = false;
        rnnoiseNode = null;
        rnnoiseLoading = null;
        rewireSources();
      });
  }

  function setRnnoiseEnabled(enabled) {
    rnnoiseEnabled = Boolean(enabled);
    if (!rnnoiseEnabled) {
      rnnoiseReady = false;
      if (rnnoiseNode) {
        rnnoiseNode.port.postMessage({ type: "enable", enabled: false });
      }
      connectGraph();
      rewireSources();
      return;
    }
    ensureRnnoiseNode();
    if (rnnoiseNode) {
      rnnoiseNode.port.postMessage({ type: "enable", enabled: true });
      connectGraph();
      rewireSources();
    }
  }

  function ensureDfn2Node() {
    if (!audioCtx || dfn2Node || dfn2Loading || !dfn2Enabled) return;
    dfn2Loading = audioCtx.audioWorklet
      .addModule(DFN2_WORKLET_URL)
      .then(() => {
        dfn2Node = new AudioWorkletNode(audioCtx, "dfn2-processor");
        dfn2Node.port.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === "dfn2-ready") {
            dfn2Ready = true;
            rewireSources();
            console.info("[VolumeBoost] DeepFilterNet2 active.");
          }
          if (data.type === "dfn2-error") {
            dfn2Enabled = false;
            dfn2Ready = false;
            dfn2Node = null;
            if (dfn2Worker) {
              dfn2Worker.terminate();
              dfn2Worker = null;
            }
            dfn2Loading = null;
            rewireSources();
            console.warn("[VolumeBoost] DeepFilterNet2 failed, falling back to RNNoise.", data.message);
          }
        };
        dfn2Worker = new Worker(DFN2_WORKER_URL);
        const channel = new MessageChannel();
        dfn2Node.port.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
        dfn2Worker.postMessage({ type: "connect", port: channel.port2 }, [channel.port2]);
        dfn2Worker.postMessage({
          type: "init",
          modelBaseUrl: DFN2_MODEL_URL,
          wasmBaseUrl: ORT_WASM_URL,
        });
        connectGraph();
        rewireSources();
        dfn2Loading = null;
      })
      .catch(() => {
        dfn2Enabled = false;
        dfn2Ready = false;
        dfn2Node = null;
        if (dfn2Worker) {
          dfn2Worker.terminate();
          dfn2Worker = null;
        }
        dfn2Loading = null;
        rewireSources();
      });
  }

  function setDfn2Enabled(enabled) {
    dfn2Enabled = Boolean(enabled);
    if (!dfn2Enabled) {
      dfn2Ready = false;
      if (dfn2Node) {
        dfn2Node.port.postMessage({ type: "enable", enabled: false });
      }
      connectGraph();
      rewireSources();
      updateOverlayControls();
      return;
    }
    ensureDfn2Node();
    if (dfn2Node) {
      dfn2Node.port.postMessage({ type: "enable", enabled: true });
      connectGraph();
      rewireSources();
      updateOverlayControls();
    }
  }

  function connectGraph() {
    if (!audioCtx || !gainNode) return;

    disconnectSafely(gainNode);
    disconnectSafely(highpass);
    disconnectSafely(mudCut);
    disconnectSafely(presence);
    disconnectSafely(compressor);
    disconnectSafely(limiter);
    disconnectSafely(analyser);
    disconnectSafely(measureHighpass);
    disconnectSafely(measureLowpass);
    disconnectSafely(rnnoiseNode);
    disconnectSafely(dfn2Node);

    if (dfn2Enabled && dfn2Ready && dfn2Node) {
      dfn2Node.connect(gainNode);
    } else if (rnnoiseEnabled && rnnoiseNode) {
      rnnoiseNode.connect(gainNode);
    }

    if (clarityEnabled) {
      gainNode.connect(highpass);
      highpass.connect(mudCut);
      mudCut.connect(presence);
      presence.connect(compressor);
      compressor.connect(limiter);
    } else {
      gainNode.connect(limiter);
    }
    limiter.connect(audioCtx.destination);
    limiter.connect(measureHighpass);
    measureHighpass.connect(measureLowpass);
    measureLowpass.connect(analyser);
  }

  function ensureAudioGraph() {
    if (!audioCtx) {
      audioCtx = new AudioContext({ latencyHint: "interactive" });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = muted ? 0 : boostValue;

      highpass = audioCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 90;
      highpass.Q.value = 0.7;

      mudCut = audioCtx.createBiquadFilter();
      mudCut.type = "lowshelf";
      mudCut.frequency.value = 250;
      mudCut.gain.value = -2.5;

      presence = audioCtx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 3000;
      presence.Q.value = 1.0;
      presence.gain.value = 3.5;

      compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -28;
      compressor.knee.value = 24;
      compressor.ratio.value = 2.2;
      compressor.attack.value = 0.02;
      compressor.release.value = 0.4;

      limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;

      analyser = audioCtx.createAnalyser();
      const desiredWindowSec = 0.4;
      let size = 256;
      const target = Math.max(256, Math.floor(audioCtx.sampleRate * desiredWindowSec));
      while (size < target) size *= 2;
      analyser.fftSize = size;
      meterBuffer = new Float32Array(analyser.fftSize);

      measureHighpass = audioCtx.createBiquadFilter();
      measureHighpass.type = "highpass";
      measureHighpass.frequency.value = 120;
      measureHighpass.Q.value = 0.707;

      measureLowpass = audioCtx.createBiquadFilter();
      measureLowpass.type = "lowpass";
      measureLowpass.frequency.value = 6000;
      measureLowpass.Q.value = 0.707;

      connectGraph();
      startAutoGainLoop();
      ensureRnnoiseNode();
      ensureDfn2Node();
    }
  }

  function applyGain() {
    if (!gainNode) return;
    const baseGain = muted ? 0 : Math.min(boostValue * autoGain, 2.4);
    const finalGain = baseGain * autoGainConfig.outputTrimGain;
    gainNode.gain.value = finalGain;
  }

  function getBoostBounds() {
    const min = overlay?.range ? Number(overlay.range.min) : 0.5;
    const max = overlay?.range ? Number(overlay.range.max) : 2.4;
    return { min, max };
  }

  function setBoostValue(next) {
    const { min, max } = getBoostBounds();
    const clamped = Math.min(max, Math.max(min, next));
    boostValue = Math.round(clamped * 10) / 10;
    applyGain();
    updateOverlayControls();
    chrome.storage.local.set({ boost: boostValue });
  }

  function toggleMute() {
    muted = !muted;
    chrome.storage.local.set({ muted });
    applyGain();
    updateOverlayControls();
  }

  function toggleClarity() {
    clarityEnabled = !clarityEnabled;
    chrome.storage.local.set({ clarity: clarityEnabled });
    setRnnoiseEnabled(clarityEnabled);
    setDfn2Enabled(clarityEnabled);
    connectGraph();
    updateOverlayControls();
  }

  function startAutoGainLoop() {
    if (autoGainTimer) return;
    let belowGateMs = 0;
    let aboveGateMs = 0;
    let allowIncrease = true;
    autoGainTimer = setInterval(() => {
      if (!autoGainConfig.enabled || !analyser || !meterBuffer) return;
      analyser.getFloatTimeDomainData(meterBuffer);

      let sum = 0;
      for (let i = 0; i < meterBuffer.length; i += 1) {
        const v = meterBuffer[i];
        sum += v * v;
      }
      const rms = Math.sqrt(sum / meterBuffer.length);
      const rmsDb = 20 * Math.log10(rms + 1e-12);

      if (rmsDb < autoGainConfig.silenceDb) {
        belowGateMs += autoGainConfig.hopMs;
        aboveGateMs = 0;
      } else {
        aboveGateMs += autoGainConfig.hopMs;
        belowGateMs = 0;
      }

      if (belowGateMs >= autoGainConfig.silenceHoldMs) {
        allowIncrease = false;
      } else if (!allowIncrease && aboveGateMs >= autoGainConfig.silenceResumeMs) {
        allowIncrease = true;
      }

      const desiredLinear = Math.pow(10, (autoGainConfig.targetDb - rmsDb) / 20);
      const desired = Math.min(autoGainConfig.max, Math.max(autoGainConfig.min, desiredLinear));

      const currentDb = 20 * Math.log10(autoGain + 1e-9);
      const desiredDb = 20 * Math.log10(desired + 1e-9);
      const diffDb = desiredDb - currentDb;
      const tau = diffDb > 0 ? autoGainConfig.attackSec : autoGainConfig.releaseSec;
      const coeff = 1 - Math.exp(-(autoGainConfig.hopMs / 1000) / tau);
      let deltaDb = diffDb * coeff;

      if (!allowIncrease && deltaDb > 0) {
        deltaDb = 0;
      }

      deltaDb = Math.max(
        -autoGainConfig.maxDownDbPerUpdate,
        Math.min(autoGainConfig.maxUpDbPerUpdate, deltaDb)
      );

      const nextDb = currentDb + deltaDb;
      autoGain = Math.pow(10, nextDb / 20);
      autoGain = Math.min(autoGainConfig.max, Math.max(autoGainConfig.min, autoGain));
      applyGain();
    }, autoGainConfig.hopMs);
  }

  function hookMedia(el) {
    if (!el || sources.has(el)) return;
    ensureAudioGraph();
    try {
      const source = audioCtx.createMediaElementSource(el);
      source.connect(getInputNode());
      sources.set(el, source);
      blocked = false;
      lastHookError = "";
      updateOverlayStatus();
    } catch (err) {
      if (sources.size === 0) {
        blocked = true;
        lastHookError = String(err && err.name ? err.name : err);
        updateOverlayStatus();
      }
    }
  }

  function unhookMedia(el) {
    const source = sources.get(el);
    if (!source) return;
    try {
      source.disconnect();
    } catch (err) {
      // Ignore disconnect errors.
    }
    sources.delete(el);
    updateOverlayStatus();
  }

  function collectMedia(node, collection) {
    if (!node) return;
    if (node.tagName === "AUDIO" || node.tagName === "VIDEO") {
      collection.push(node);
      return;
    }
    if (node.querySelectorAll) {
      collection.push(...node.querySelectorAll("audio, video"));
    }
  }

  function scan() {
    const media = document.querySelectorAll("audio, video");
    for (const el of media) hookMedia(el);
  }

  const observer = new MutationObserver((mutations) => {
    const added = [];
    const removed = [];
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => collectMedia(node, added));
      mutation.removedNodes.forEach((node) => collectMedia(node, removed));
    }
    for (const el of added) hookMedia(el);
    for (const el of removed) unhookMedia(el);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener(
    "play",
    (e) => {
      const el = e.target;
      if (el && (el.tagName === "AUDIO" || el.tagName === "VIDEO")) {
        hookMedia(el);
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "SET_CLARITY") {
      ensureAudioGraph();
      clarityEnabled = Boolean(msg.enabled);
      setRnnoiseEnabled(clarityEnabled);
      setDfn2Enabled(clarityEnabled);
      connectGraph();
      updateOverlayControls();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "TOGGLE_CLARITY") {
      ensureAudioGraph();
      toggleClarity();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "SET_BOOST") {
      ensureAudioGraph();
      boostValue = Number(msg.value) || 1.0;
      applyGain();
      updateOverlayControls();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "ADJUST_BOOST") {
      ensureAudioGraph();
      const delta = Number(msg.delta) || 0;
      setBoostValue(boostValue + delta);
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "RESET_BOOST") {
      ensureAudioGraph();
      boostValue = 1.0;
      autoGain = 1.0;
      applyGain();
      chrome.storage.local.set({ boost: boostValue });
      updateOverlayControls();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "SET_MUTE") {
      ensureAudioGraph();
      muted = Boolean(msg.muted);
      applyGain();
      updateOverlayControls();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "TOGGLE_MUTE") {
      ensureAudioGraph();
      toggleMute();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "GET_STATE") {
      sendResponse({
        ok: true,
        boost: boostValue,
        clarity: clarityEnabled,
        muted,
        hooked: sources.size > 0,
        blocked: blocked && sources.size === 0,
        lastHookError,
        audioState: audioCtx ? audioCtx.state : "uninitialized",
        sources: sources.size,
      });
    }
  });

  function resumeAudio() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().then(updateOverlayStatus).catch(() => {});
    }
  }

  window.addEventListener("click", resumeAudio, { capture: true });
  window.addEventListener("keydown", resumeAudio, { capture: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }

  chrome.storage.local.get({ boost: 1.0, clarity: true, muted: false }, (data) => {
    boostValue = Number(data.boost) || 1.0;
    clarityEnabled = Boolean(data.clarity);
    muted = Boolean(data.muted);
    setRnnoiseEnabled(clarityEnabled);
    setDfn2Enabled(clarityEnabled);
    ensureAudioGraph();
    applyGain();
    connectGraph();
    initOverlayWhenReady();
  });

  function initOverlayWhenReady() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initOverlay, { once: true });
    } else {
      initOverlay();
    }
  }

  function initOverlay() {
    if (window.top !== window) return;
    if (overlay || document.getElementById("vb-overlay-host")) return;
    const host = document.createElement("div");
    host.id = "vb-overlay-host";
    host.style.position = "fixed";
    host.style.left = `${OVERLAY_DEFAULT_POS.x}px`;
    host.style.top = `${OVERLAY_DEFAULT_POS.y}px`;
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          z-index: 2147483647;
          font-family: "Segoe UI", sans-serif;
          color: #d6e9ff;
          user-select: none;
        }
        .panel {
          background: #0b0b10;
          border: 1px solid rgba(47, 51, 69, 0.7);
          border-radius: 22px;
          padding: 10px 12px;
          box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.65),
            inset 0 2px 8px rgba(0, 0, 0, 0.7);
          transition: border-color 0.2s ease;
        }
        .panel.applied {
          border-color: rgba(0, 255, 140, 0.6);
        }
        .panel.error {
          border-color: rgba(255, 82, 82, 0.65);
        }
        .bar {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .drag-handle {
          width: 10px;
          height: 18px;
          border-radius: 8px;
          border: 1px solid rgba(47, 51, 69, 0.8);
          background: radial-gradient(circle at 30% 30%, #1b1f2a, #0b0b12);
          box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.12);
          display: grid;
          place-items: center;
          color: #6f7688;
          font-size: 12px;
          cursor: grab;
        }
        .drag-handle:active {
          cursor: grabbing;
        }
        .slider {
          --percent: 0%;
          position: relative;
          width: 320px;
          height: 10px;
          padding: 0 14px;
        }
        .track {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          height: 4px;
          transform: translateY(-50%);
          border-radius: 999px;
          background: #0a0a0f;
          border: 1px solid #1b1b25;
          box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.85),
            0 0 6px rgba(64, 255, 240, 0.25),
            0 0 16px rgba(88, 108, 255, 0.22);
          overflow: hidden;
        }
        .fill {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: var(--percent);
          background: linear-gradient(
            90deg,
            rgba(40, 240, 255, 0.35) 0%,
            #28f0ff 35%,
            #7c58ff 70%,
            rgba(124, 88, 255, 0.35) 100%
          );
          background-size: 200% 100%;
          animation: flowGlow 3s linear infinite;
          box-shadow: 0 0 10px rgba(40, 240, 255, 0.55),
            0 0 18px rgba(124, 88, 255, 0.45);
          border-radius: inherit;
          transition: box-shadow 0.2s ease;
        }
        .fill::after {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: -35%;
          width: 35%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.6),
            transparent
          );
          animation: flowStreak 2.6s linear infinite;
          opacity: 0.6;
          pointer-events: none;
        }
        .thumb {
          position: absolute;
          top: 50%;
          left: var(--percent);
          width: 12px;
          height: 12px;
          transform: translate(-50%, -50%);
          border-radius: 999px;
          background: radial-gradient(circle at 30% 30%, #2a2f3f, #0b0b12);
          border: 1px solid #2f3345;
          box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.18),
            0 4px 10px rgba(0, 0, 0, 0.55);
          pointer-events: none;
        }
        input[type="range"] {
          -webkit-appearance: none;
          appearance: none;
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          opacity: 0;
          cursor: pointer;
        }
        .value {
          min-width: 40px;
          text-align: right;
          font-size: 12px;
          color: #9aa0ad;
        }
        .actions {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: 6px;
        }
        .btn {
          width: 20px;
          height: 20px;
          border-radius: 999px;
          border: 1px solid #2b2f3b;
          background: #0f0f16;
          color: #7f8794;
          display: grid;
          place-items: center;
          font-size: 10px;
          cursor: pointer;
          padding: 0;
          box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.12),
            0 6px 10px rgba(0, 0, 0, 0.45);
          transition: color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease,
            transform 0.1s ease;
        }
        .btn.is-active {
          border-color: #3a4052;
          color: #c9d3de;
          background: #14141c;
          box-shadow: 0 0 6px rgba(120, 190, 255, 0.35),
            0 0 10px rgba(140, 110, 255, 0.25),
            inset 0 1px 2px rgba(255, 255, 255, 0.18);
        }
        .btn:active {
          transform: scale(0.96);
        }
        .status {
          display: none;
        }
        .slider:hover .fill {
          animation: glowPulse 1.4s ease-in-out infinite;
        }
        .slider.dragging .fill {
          animation: glowPulse 0.8s ease-in-out infinite;
        }
        @keyframes glowPulse {
          0% {
            box-shadow: 0 0 10px rgba(40, 240, 255, 0.55),
              0 0 18px rgba(124, 88, 255, 0.45);
          }
          50% {
            box-shadow: 0 0 14px rgba(40, 240, 255, 0.85),
              0 0 26px rgba(124, 88, 255, 0.7);
          }
          100% {
            box-shadow: 0 0 10px rgba(40, 240, 255, 0.55),
              0 0 18px rgba(124, 88, 255, 0.45);
          }
        }
        @keyframes flowGlow {
          0% {
            background-position: 0% 50%;
          }
          100% {
            background-position: 200% 50%;
          }
        }
        @keyframes flowStreak {
          0% {
            transform: translateX(-120%);
          }
          100% {
            transform: translateX(320%);
          }
        }
      </style>
      <div class="panel error" id="vb-panel">
        <div class="bar">
          <div class="drag-handle" id="vb-drag" title="Drag">::</div>
          <div class="slider" id="vb-slider" style="--percent: 0%;">
            <div class="track"><div class="fill"></div></div>
            <div class="thumb"></div>
            <input id="vb-range" type="range" min="0.5" max="2.4" step="0.1" value="1" />
          </div>
          <span class="value" id="vb-value">1.0x</span>
          <div class="actions">
            <button class="btn" id="vb-clarity" title="Speech Focused">🗣️</button>
            <button class="btn" id="vb-reset" title="Reset">🔄</button>
            <button class="btn" id="vb-mute" title="Mute">🔇</button>
          </div>
        </div>
        <div class="status" id="vb-status"></div>
      </div>
    `;

    document.documentElement.appendChild(host);
    overlay = {
      host,
      panel: shadow.getElementById("vb-panel"),
      dragHandle: shadow.getElementById("vb-drag"),
      sliderWrap: shadow.getElementById("vb-slider"),
      range: shadow.getElementById("vb-range"),
      value: shadow.getElementById("vb-value"),
      clarity: shadow.getElementById("vb-clarity"),
      reset: shadow.getElementById("vb-reset"),
      mute: shadow.getElementById("vb-mute"),
      status: shadow.getElementById("vb-status"),
    };

    overlay.range.addEventListener("input", (e) => {
      setBoostValue(Number(e.target.value) || 1.0);
    });

    overlay.range.addEventListener("change", () => {
      chrome.storage.local.set({ boost: boostValue });
      updateOverlayStatus();
    });

    overlay.range.addEventListener("pointerdown", () => {
      overlay.sliderWrap.classList.add("dragging");
    });

    const stopDragGlow = () => overlay.sliderWrap.classList.remove("dragging");
    overlay.range.addEventListener("pointerup", stopDragGlow);
    overlay.range.addEventListener("pointerleave", stopDragGlow);

    overlay.clarity.addEventListener("click", () => {
      toggleClarity();
    });

    overlay.reset.addEventListener("click", () => {
      boostValue = 1.0;
      autoGain = 1.0;
      applyGain();
      chrome.storage.local.set({ boost: boostValue });
      updateOverlayControls();
      overlay.reset.classList.add("is-active");
      if (resetFlashTimer) clearTimeout(resetFlashTimer);
      resetFlashTimer = setTimeout(() => {
        overlay.reset.classList.remove("is-active");
        resetFlashTimer = null;
      }, 300);
    });

    overlay.mute.addEventListener("click", () => {
      toggleMute();
    });

    overlay.dragHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      overlayPendingDrag = true;
      overlayDragging = false;
      overlayDragFromInput = false;
      overlayDragStart = { x: e.clientX, y: e.clientY };
      const rect = host.getBoundingClientRect();
      overlayDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      overlay.dragHandle.setPointerCapture(e.pointerId);
    });

    overlay.dragHandle.addEventListener("pointermove", (e) => {
      if (!overlayPendingDrag && !overlayDragging) return;
      const dx = e.clientX - overlayDragStart.x;
      const dy = e.clientY - overlayDragStart.y;
      if (overlayPendingDrag) {
        overlayDragging = true;
        overlayPendingDrag = false;
      }
      const x = e.clientX - overlayDragOffset.x;
      const y = e.clientY - overlayDragOffset.y;
      applyOverlayPosition(x, y);
    });

    overlay.dragHandle.addEventListener("pointerup", (e) => {
      if (!overlayDragging && !overlayPendingDrag) return;
      overlayDragging = false;
      overlayPendingDrag = false;
      overlay.dragHandle.releasePointerCapture(e.pointerId);
      saveOverlayPosition();
    });

    overlay.dragHandle.addEventListener("pointercancel", (e) => {
      if (!overlayDragging && !overlayPendingDrag) return;
      overlayDragging = false;
      overlayPendingDrag = false;
      overlay.dragHandle.releasePointerCapture(e.pointerId);
      saveOverlayPosition();
    });

    loadOverlayPosition();
    updateOverlayControls();
    updateOverlayStatus();
    window.addEventListener("resize", clampOverlayToViewport);
  }

  function isButtonTarget(event) {
    return event
      .composedPath()
      .some(
        (el) =>
          el &&
          el.tagName &&
          (el.tagName === "BUTTON" || el.getAttribute?.("role") === "button")
      );
  }

  function updateOverlayControls() {
    if (!overlay) return;
    const min = Number(overlay.range.min) || 0;
    const max = Number(overlay.range.max) || 1;
    const percent = ((boostValue - min) / (max - min)) * 100;
    overlay.sliderWrap.style.setProperty("--percent", `${percent}%`);
    overlay.range.value = String(boostValue);
    overlay.value.textContent = `${boostValue.toFixed(1)}x`;
    overlay.clarity.classList.toggle("is-active", clarityEnabled);
    overlay.mute.textContent = muted ? "🔇" : "🔊";
    overlay.mute.classList.toggle("is-active", muted);
  }

  function updateOverlayStatus() {
    if (!overlay) return;
    if (blocked && sources.size === 0) {
      overlay.status.textContent = "";
      overlay.panel?.classList.add("error");
      overlay.panel?.classList.remove("applied");
      return;
    }
    if (audioCtx && audioCtx.state === "suspended") {
      overlay.status.textContent = "";
      overlay.panel?.classList.add("error");
      overlay.panel?.classList.remove("applied");
      return;
    }
    if (sources.size > 0) {
      overlay.status.textContent = "";
      overlay.panel?.classList.add("applied");
      overlay.panel?.classList.remove("error");
    } else {
      overlay.status.textContent = "";
      overlay.panel?.classList.add("error");
      overlay.panel?.classList.remove("applied");
    }
  }

  function clampOverlayPosition(x, y) {
    const maxX = Math.max(0, window.innerWidth - overlay.host.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - overlay.host.offsetHeight);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }

  function applyOverlayPosition(x, y) {
    if (!overlay) return;
    const pos = clampOverlayPosition(x, y);
    overlay.host.style.left = `${pos.x}px`;
    overlay.host.style.top = `${pos.y}px`;
  }

  function loadOverlayPosition() {
    chrome.storage.local.get({ [OVERLAY_POS_KEY]: OVERLAY_DEFAULT_POS }, (data) => {
      const pos = data[OVERLAY_POS_KEY] || OVERLAY_DEFAULT_POS;
      applyOverlayPosition(pos.x, pos.y);
    });
  }

  function saveOverlayPosition() {
    if (!overlay) return;
    const x = parseInt(overlay.host.style.left || OVERLAY_DEFAULT_POS.x, 10);
    const y = parseInt(overlay.host.style.top || OVERLAY_DEFAULT_POS.y, 10);
    chrome.storage.local.set({ [OVERLAY_POS_KEY]: { x, y } });
  }

  function clampOverlayToViewport() {
    if (!overlay) return;
    const x = parseInt(overlay.host.style.left || OVERLAY_DEFAULT_POS.x, 10);
    const y = parseInt(overlay.host.style.top || OVERLAY_DEFAULT_POS.y, 10);
    applyOverlayPosition(x, y);
  }
})();
