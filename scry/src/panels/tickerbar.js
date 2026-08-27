// The ticker's DOM half (observatory spec v0.8 §5): a single-line strip
// above the transport bar. All decisions — what qualifies, phrasing, pace,
// recycling, replay sync — live in src/ticker.js; this file only appends
// spans and lets old ones drift off.

import { createTicker } from "../ticker.js";

export function createTickerBar(el, opts = {}) {
  const ticker = createTicker(opts);
  const track = document.createElement("div");
  track.className = "ticker-track";
  el.appendChild(track);

  function show(item) {
    const span = document.createElement("span");
    span.className = `ticker-item${item.recycled ? " recycled" : ""}`;
    span.textContent = item.text;
    track.appendChild(span);
    while (track.children.length > 8) track.removeChild(track.firstChild);
  }

  return {
    push(items) {
      ticker.push(items);
    },
    // Replay seek: replace the strip wholesale with what was on the ticker
    // around that tick (§5.6) — the scrubber owns time, not the pace cap.
    setItems(texts) {
      track.innerHTML = "";
      for (const text of texts) show({ text, recycled: false });
    },
    // Called from the render loop; the ticker itself decides pace.
    tick(nowMs) {
      const item = ticker.next(nowMs);
      if (item) show(item);
    },
  };
}
