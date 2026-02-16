(() => {
  let audioCtx = null;
  let gainNode = null;
  let highpass = null;
  let mudCut = null;
  let presence = null;
  let compressor = null;
  let limiter = null;
  let clarityEnabled = false;
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

    if (clarityEnabled) {
      gainNode.connect(highpass);
      highpass.connect(mudCut);
      mudCut.connect(presence);
      presence.connect(compressor);
      compressor.connect(limiter);
      limiter.connect(audioCtx.destination);
    } else {
      gainNode.connect(audioCtx.destination);
    }
  }

  function ensureAudioGraph() {
    if (!audioCtx) {
      audioCtx = new AudioContext({ latencyHint: "interactive" });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.0;

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

      connectGraph();
    }
  }

  function hookMedia(el) {
    if (!el || sources.has(el)) return;
    ensureAudioGraph();
    try {
      const source = audioCtx.createMediaElementSource(el);
      source.connect(gainNode);
      sources.set(el, source);
    } catch (err) {
      // Likely already connected or not allowed by the browser.
    }
  }

  function scan() {
    const media = document.querySelectorAll("audio, video");
    for (const el of media) hookMedia(el);
  }

  const observer = new MutationObserver(() => scan());
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
      sendResponse({ ok: true });
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
