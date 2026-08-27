// Roster (observatory spec §8.1): every agent — name, appearance swatch,
// life stage, connection state, backing model, latency, misses, cell.
// Click selects. Below the living: the departed, so a death does not just
// silently shorten the list.

// Who is gone, merged from two sources: corpses standing in cells (always
// present, even for a viewer who connected after the death) and the
// reducer's departure records (released/reaped bodies leave no corpse).
export function collectDeparted(state) {
  const out = [];
  const seen = new Set();
  for (const cell of state.cells.values()) {
    for (const corpse of cell.corpses) {
      seen.add(`${corpse.authored?.name}@${corpse.diedAtTick}`);
      out.push({
        name: corpse.authored?.name ?? null,
        appearance: corpse.appearance ?? null,
        diedAtTick: corpse.diedAtTick,
        coord: cell.coord,
        kind: "died",
      });
    }
  }
  const foodByKey = new Map(
    [...state.departed.values()].filter((d) => d.diedAtTick != null).map((d) => [`${d.name}@${d.diedAtTick}`, d])
  );
  for (const entry of out) {
    // Death-cause instrumentation (v0.6 §5): the record knows whether
    // reachable food existed; corpses alone do not carry it.
    const rec = foodByKey.get(`${entry.name}@${entry.diedAtTick}`);
    entry.foodAtDeath = rec?.foodAtDeath ?? null;
    entry.foodReachable = rec?.foodReachable ?? null;
  }
  for (const d of state.departed.values()) {
    if (d.diedAtTick != null && seen.has(`${d.name}@${d.diedAtTick}`)) continue;
    out.push({
      name: d.name,
      appearance: d.appearance,
      diedAtTick: d.diedAtTick,
      coord: null,
      kind: d.diedAtTick != null ? "died" : "left",
      foodAtDeath: d.foodAtDeath ?? null,
      foodReachable: d.foodReachable ?? null,
    });
  }
  out.sort((a, b) => (a.diedAtTick ?? Infinity) - (b.diedAtTick ?? Infinity));
  return out;
}

// adapter_fault (spec §3.2, v0.6 §6): distinct from stalled, and driven by
// the typed `clientStatus` enum on the operator record — no reason-string
// parsing anywhere in this panel. An expired CLI session must not read as
// a pensive agent for two hundred ticks.
export function connectionLabel(agent) {
  if (agent.clientStatus === "adapter_fault") return "adapter_fault";
  return agent.connectionState ?? "?";
}

// Group living agents by billing surface (spec §3.2): five clients on one
// account must be visible at a glance, so agents sharing a surface sit
// together under one label. Undeclared surfaces group under "undeclared".
export function surfaceGroups(state) {
  const groups = new Map();
  for (const agent of state.agents.values()) {
    const key = agent.surface ?? "undeclared";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

// A stable tint per surface so grouping reads as color before it reads as
// text. Presentation only.
export function surfaceTint(surface) {
  let hash = 0;
  for (const ch of String(surface ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 45%, 55%)`;
}

export function renderRoster(el, state, ctx) {
  el.innerHTML = "<h3>Roster</h3>";
  if (state.agents.size === 0) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">No agents. The world boots empty.</div>`);
    return;
  }
  for (const [surface, agents] of surfaceGroups(state)) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="dim" style="margin:6px 0 2px;border-left:3px solid ${surfaceTint(surface)};padding-left:6px">${surface}${agents.length > 1 ? ` · ${agents.length} agents on this surface` : ""}</div>`
    );
    for (const agent of agents) {
      const row = document.createElement("div");
      row.className = `row${ctx.selectedId === agent.agentId ? " selected" : ""}`;
      const meta = ctx.clientMeta.get(agent.agentId) ?? {};
      const model = agent.modelHint ?? meta.modelHint ?? "";
      const adapter = agent.clientName ?? meta.clientName ?? "";
      const conn = connectionLabel(agent);
      const latency = agent.lastActionLatencyMs != null ? `${agent.lastActionLatencyMs}ms` : "—";
      row.innerHTML = `
        <span class="swatch" style="background:${agent.appearance?.bodyColor ?? "#777"};border-color:${agent.appearance?.eyeColor ?? "#777"}"></span>
        <span style="flex:1">
          <div>${agent.name ?? "<span class='dim'>unnamed " + agent.lifeStage + "</span>"}</div>
          <div class="dim">${agent.lifeStage} · ${conn === "adapter_fault" ? `<span class="ambiguous">adapter_fault</span>` : conn} · ${agent.coord}${model ? " · " + model : ""}${adapter ? " · " + adapter : ""}</div>
        </span>
        <span class="dim" style="text-align:right">${latency}<br>${agent.consecutiveMisses > 0 ? agent.consecutiveMisses + " missed" : ""}</span>`;
      row.onclick = () => ctx.select(agent.agentId);
      el.appendChild(row);
    }
  }

  const departed = collectDeparted(state);
  if (departed.length > 0) {
    el.insertAdjacentHTML("beforeend", "<h3>Departed</h3>");
    for (const d of departed) {
      const row = document.createElement("div");
      row.className = "row";
      // A starvation death under famine and one amid plenty mean opposite
      // things (v0.6 §5); say which this was when the record knows.
      const food =
        d.foodAtDeath === "inventory"
          ? " · died holding food"
          : d.foodAtDeath === "nearby"
            ? " · food was within reach"
            : d.foodAtDeath === "none"
              ? " · no food within reach"
              : "";
      const where =
        d.kind === "died"
          ? `† died t${d.diedAtTick}${d.coord ? ` · corpse at ${d.coord}` : ""}${food}`
          : "left the world";
      row.innerHTML = `
        <span class="swatch" style="background:${d.appearance?.bodyColor ?? "#444"};border-color:#3a3833;opacity:0.55"></span>
        <span style="flex:1">
          <div class="dim">${d.name ?? "an unnamed body"}</div>
          <div class="dim">${where}</div>
        </span>`;
      el.appendChild(row);
    }
  }
}
