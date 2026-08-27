// Event feed (observatory spec §8.7): reverse chronological, sim-timestamped,
// filterable by type. Speech prominent, movement dim. Clicking an event
// seeks the scrubber in replay or selects the agent in live.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const WINDOW = 250;

const FILTERS = ["all", "speech", "movement", "build", "destruction", "violence", "lineage", "lifecycle"];

const CATEGORY = {
  speech: "speech",
  move: "movement",
  build: "build",
  inscribe: "build",
  raze: "destruction",
  demolish_progress: "destruction",
  demolish_complete: "destruction",
  attack: "violence",
  death: "violence",
  beget: "lineage",
  foster: "lineage",
  matured: "lineage",
  registered: "lifecycle",
  claimed: "lifecycle",
  takeover: "lifecycle",
  attach: "lifecycle",
  leave: "lifecycle",
  released: "lifecycle",
  reaped: "lifecycle",
  give: "lifecycle",
  drop: "lifecycle",
  gather: "lifecycle",
  consume: "lifecycle",
};

function line(state, ev) {
  const n = (id) => esc(state.agents.get(id)?.name ?? state.departed.get(id)?.name ?? id ?? "?");
  switch (ev.type) {
    case "speech": return `<b>${n(ev.speaker)}</b>: “${esc(ev.text)}”`;
    case "move": return `<span class="dim">${n(ev.agentId)} moved ${ev.from} → ${ev.to}</span>`;
    case "build": return `${n(ev.agentId)} built ${esc(ev.form)} “${esc(ev.structure?.name)}” at ${ev.coord}`;
    case "inscribe": return `${n(ev.agentId)} inscribed at ${ev.coord}: “${esc(ev.text)}”`;
    case "raze": return `${n(ev.agentId)} razed “${esc(ev.name)}” at ${ev.coord}${ev.inscriptionDestroyed ? " — its inscription is gone" : ""}`;
    case "demolish_progress": return `<span class="dim">${n(ev.agentId)} works at the ${ev.coord} structure (${ev.ticks}/${ev.required})</span>`;
    case "demolish_complete": return `${n(ev.agentId)} brought down “${esc(ev.name)}” at ${ev.coord}${ev.fragmentLeft ? " — a fragment survives" : ""}`;
    case "attack": return `<b>${n(ev.actor)} attacked ${n(ev.target)}</b> at ${ev.coord}`;
    case "death": return `<b>${n(ev.agentId)} died</b> at ${ev.coord}`;
    case "beget": return `an infant was born to ${n(ev.agentId)} at ${ev.coord}${ev.divergence ? " — a divergence is noted" : ""}`;
    case "foster": return `${n(ev.agentId)} fostered the infant at ${ev.coord}`;
    case "matured": return `the infant at ${ev.coord} came of age`;
    case "registered": return `${esc(ev.name)} entered the world at ${ev.coord}`;
    case "claimed": return `a matured body was claimed as ${esc(ev.name)}`;
    case "takeover": return `<span class="dim">a client took over ${n(ev.agentId)}</span>`;
    case "gather": return `<span class="dim">${n(ev.agentId)} gathered at ${ev.coord}</span>`;
    case "give": return `<span class="dim">${n(ev.from)} gave to ${n(ev.to)}</span>`;
    case "drop": return `<span class="dim">${n(ev.agentId)} dropped resources at ${ev.coord}</span>`;
    case "consume": return `<span class="dim">${n(ev.agentId)} consumed ${esc(ev.resource)}</span>`;
    case "reaped": return `<span class="dim">${esc(ev.name)} was reclaimed by the world</span>`;
    case "released": return `<span class="dim">${esc(ev.name)} left the world</span>`;
    case "leave": return `<span class="dim">${n(ev.agentId)}'s client detached</span>`;
    case "attach": return `<span class="dim">a client attached to ${n(ev.agentId)}</span>`;
    default: return `<span class="dim">${esc(ev.type)}</span>`;
  }
}

import { liveHistoryHint } from "./hint.js";

export function renderFeed(el, state, ctx) {
  el.innerHTML = "<h3>Event feed</h3>";
  el.insertAdjacentHTML("beforeend", liveHistoryHint(state));
  const bar = document.createElement("div");
  for (const f of FILTERS) {
    const b = document.createElement("button");
    b.textContent = f;
    b.style.cssText = `margin:0 4px 8px 0;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer;background:none;border:1px solid var(--panel-line);border-radius:3px;color:${(ctx.feedFilter ?? "all") === f ? "var(--accent)" : "var(--panel-dim)"}`;
    b.onclick = () => {
      ctx.feedFilter = f;
      ctx.refresh();
    };
    bar.appendChild(b);
  }
  el.appendChild(bar);

  const filter = ctx.feedFilter ?? "all";
  const events = state.events.filter((e) => filter === "all" || CATEGORY[e.type] === filter);
  const shown = events.slice(-WINDOW).reverse();
  for (const ev of shown) {
    const div = document.createElement("div");
    div.className = "event row";
    div.innerHTML = `<span class="t">t${ev.tick} ${ev.simTime ?? ""}</span><span style="flex:1">${line(state, ev)}</span>`;
    div.onclick = () => ctx.onEventClick(ev);
    el.appendChild(div);
  }
  if (shown.length === 0) el.insertAdjacentHTML("beforeend", `<div class="dim">nothing yet</div>`);
}
