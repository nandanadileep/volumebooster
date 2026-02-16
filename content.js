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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
