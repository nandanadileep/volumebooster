(() => {
  let audioCtx = null;
  let gainNode = null;
  let highpass = null;
  let mudCut = null;
  let presence = null;
  let compressor = null;
  let limiter = null;
  let analyser = null;
  let meterBuffer = null;
  let autoGainTimer = null;
  let autoGain = 1.0;
  const autoGainConfig = {
    enabled: true,
    targetRms: 0.1,
    min: 0.6,
    max: 1.8,
    rise: 0.18,
    fall: 0.08,
    silenceGate: 0.003,
  };
  let clarityEnabled = false;
  let boostValue = 1.0;
  let muted = false;
  let blocked = false;
  let lastHookError = "";
  const sources = new Map();

  function disconnectSafely(node) {
    try {
      node.disconnect();
    } catch (err) {
      // Ignore disconnect errors.
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

    if (clarityEnabled) {
      gainNode.connect(highpass);
      highpass.connect(mudCut);
      mudCut.connect(presence);
      presence.connect(compressor);
      compressor.connect(limiter);
      limiter.connect(audioCtx.destination);
      limiter.connect(analyser);
    } else {
      gainNode.connect(audioCtx.destination);
      gainNode.connect(analyser);
    }
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
      compressor.threshold.value = -22;
      compressor.knee.value = 18;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.05;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      meterBuffer = new Float32Array(analyser.fftSize);

      connectGraph();
      startAutoGainLoop();
    }
  }

  function applyGain() {
    if (!gainNode) return;
    const finalGain = muted ? 0 : Math.min(boostValue * autoGain, 3.0);
    gainNode.gain.value = finalGain;
  }

  function startAutoGainLoop() {
    if (autoGainTimer) return;
    autoGainTimer = setInterval(() => {
      if (!autoGainConfig.enabled || !analyser || !meterBuffer) return;
      analyser.getFloatTimeDomainData(meterBuffer);

      let sum = 0;
      for (let i = 0; i < meterBuffer.length; i += 1) {
        const v = meterBuffer[i];
        sum += v * v;
      }
      const rms = Math.sqrt(sum / meterBuffer.length);

      if (rms < autoGainConfig.silenceGate) {
        autoGain += (1.0 - autoGain) * autoGainConfig.fall;
        applyGain();
        return;
      }

      const desired = Math.min(
        autoGainConfig.max,
        Math.max(autoGainConfig.min, autoGainConfig.targetRms / rms)
      );

      const diff = desired - autoGain;
      const rate = diff > 0 ? autoGainConfig.rise : autoGainConfig.fall;
      autoGain += diff * rate;
      applyGain();
    }, 250);
  }

  function hookMedia(el) {
    if (!el || sources.has(el)) return;
    ensureAudioGraph();
    try {
      const source = audioCtx.createMediaElementSource(el);
      source.connect(gainNode);
      sources.set(el, source);
      blocked = false;
      lastHookError = "";
    } catch (err) {
      if (sources.size === 0) {
        blocked = true;
        lastHookError = String(err && err.name ? err.name : err);
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
      connectGraph();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "SET_BOOST") {
      ensureAudioGraph();
      boostValue = Number(msg.value) || 1.0;
      applyGain();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "SET_MUTE") {
      ensureAudioGraph();
      muted = Boolean(msg.muted);
      applyGain();
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
      audioCtx.resume().catch(() => {});
    }
  }

  window.addEventListener("click", resumeAudio, { capture: true });
  window.addEventListener("keydown", resumeAudio, { capture: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }

  chrome.storage.local.get({ boost: 1.0, clarity: false, muted: false }, (data) => {
    boostValue = Number(data.boost) || 1.0;
    clarityEnabled = Boolean(data.clarity);
    muted = Boolean(data.muted);
    ensureAudioGraph();
    applyGain();
    connectGraph();
  });
})();
