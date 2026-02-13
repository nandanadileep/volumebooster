(() => {
  let audioCtx = null;
  let gainNode = null;
  const sources = new Map();

  function ensureAudioGraph() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(audioCtx.destination);
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
      // Likely already connected or disallowed; ignore.
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
    if (msg && msg.type === "SET_BOOST") {
      ensureAudioGraph();
      gainNode.gain.value = msg.value;
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      sendResponse({ ok: true });
    }
  });

  // Attempt to unlock audio on user gesture.
  window.addEventListener(
    "click",
    () => {
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
    },
    { once: true, capture: true }
  );

  // Initial scan in case media elements exist at load.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
