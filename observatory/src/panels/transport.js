// Transport bar (observatory spec §7): play, pause, step, speed, sim clock,
// tick counter, +N ticks, source indicator. In live mode controls proxy to
// /control; in replay they drive the local playhead. The scrubber exists in
// replay only, with event markers for deaths, births, attacks, first
// inscriptions, and destruction.

export function createTransport(el, { mode, onControl, onSeek, onSpeed, onLighting = null }) {
  el.innerHTML = "";
  const btn = (label, action) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => onControl(action);
    el.appendChild(b);
    return b;
  };

  btn("⏵", "play");
  btn("⏸", "pause");
  btn("⏭", "step");
  const plus = document.createElement("button");
  plus.textContent = "+20";
  plus.onclick = () => onControl("extend", { ticks: 20 });
  if (mode === "live") el.appendChild(plus);

  const speed = document.createElement("select");
  for (const s of [0.5, 1, 2, 5, 10]) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = `${s}×`;
    if (s === 1) o.selected = true;
    speed.appendChild(o);
  }
  speed.onchange = () => onSpeed(Number(speed.value));
  speed.style.cssText = "background:#131211;color:var(--panel-fg);border:1px solid var(--panel-line);border-radius:3px;font:inherit;padding:2px";
  el.appendChild(speed);

  // Operator lighting override (observatory spec v0.6 §2): follow sim time,
  // or hold the lights at a fixed hour. Not diegetic — the world's clock
  // keeps running; only the view changes.
  if (onLighting) {
    const lighting = document.createElement("select");
    const opts = [["follow", "sun: follow"], ...["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"].map((h) => [h, `sun: ${h}`])];
    for (const [value, label] of opts) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      lighting.appendChild(o);
    }
    lighting.onchange = () => onLighting(lighting.value);
    lighting.style.cssText = "background:#131211;color:var(--panel-fg);border:1px solid var(--panel-line);border-radius:3px;font:inherit;padding:2px";
    el.appendChild(lighting);
  }

  const clock = document.createElement("span");
  clock.className = "clock";
  el.appendChild(clock);

  const scrub = document.createElement("div");
  scrub.id = "scrub";
  scrub.innerHTML = `<div class="markers"></div><input type="range" min="0" max="1" value="0" step="1"/>`;
  el.appendChild(scrub);
  const range = scrub.querySelector("input");
  const markersEl = scrub.querySelector(".markers");
  if (mode === "replay") {
    scrub.style.display = "block";
    range.oninput = () => onSeek(Number(range.value));
  }

  const source = document.createElement("span");
  source.className = `source ${mode === "live" ? "live" : ""}`;
  source.textContent = mode;
  el.appendChild(source);

  return {
    setClock(tick, simTime, extra = "") {
      clock.textContent = `t${tick ?? 0} · ${simTime ?? "--:--"}${extra ? ` · ${extra}` : ""}`;
    },
    setRange(maxTick, current) {
      range.max = String(maxTick);
      if (document.activeElement !== range) range.value = String(current);
    },
    setMarkers(markers, maxTick) {
      markersEl.innerHTML = "";
      for (const m of markers) {
        const d = document.createElement("div");
        d.className = `marker ${m.kind}`;
        d.style.left = `${(m.tick / Math.max(1, maxTick)) * 100}%`;
        d.title = `${m.kind} at t${m.tick}`;
        markersEl.appendChild(d);
      }
    },
    setSource(text, live) {
      source.textContent = text;
      source.classList.toggle("live", live);
    },
  };
}
