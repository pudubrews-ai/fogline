// Observatory client. Renders the world from the operator SSE stream.
// The `thinking` state is driven by real barrier timing: it starts when the
// daemon logs observation_emitted and ends when action_received arrives for
// that agent — the visible form of the tick barrier, never a fixed animation.
// The map overlay renders the grid as ONE AGENT knows it — the instrument
// that makes cartographic fog legible.

import { buildFigure, setFigureState, setGaze, showBubble } from "./robot.js";

const state = {
  agents: new Map(), // id -> {def, figure, coord, connection, speaking, thinking}
  cells: new Map(), // coord -> {structure} — live truth, operator-omniscient
  gridSize: 0,
  maxTicks: 0,
  slots: { total: 0, used: 0 },
  mapAgent: "",
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const nameOf = (agentId) => state.agents.get(agentId)?.def.persona?.name ?? agentId;
const colorOf = (agentId) => {
  const def = state.agents.get(agentId)?.def;
  return def?.appearance?.bodyColor ?? def?.persona?.appearance?.bodyColor ?? "#8b90a1";
};

// ---------- grid ----------

function buildGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  grid.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const coord = `${x},${y}`;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.coord = coord;
      cell.innerHTML = `
        <span class="cell-coord">${coord}</span>
        <div class="cell-structure" hidden></div>
        <div class="agents"></div>`;
      grid.appendChild(cell);
    }
  }
}

function renderCellStructure(coord) {
  const cell = state.cells.get(coord);
  const el = document.querySelector(`.cell[data-coord="${coord}"] .cell-structure`);
  if (!el) return;
  if (cell?.structure) {
    el.hidden = false;
    el.textContent = `⌂ ${cell.structure.authored.name}`;
    el.title = cell.structure.authored.description;
  } else {
    el.hidden = true;
  }
}

function placeFigure(agentId, coord) {
  const a = state.agents.get(agentId);
  a.coord = coord;
  document.querySelector(`.cell[data-coord="${coord}"] .agents`).appendChild(a.figure);
  refreshAllStates();
}

// ---------- agents ----------

function addAgent(body) {
  if (state.agents.has(body.id)) return;
  const figure = buildFigure({
    id: body.id,
    name: body.persona?.name ?? "unnamed",
    appearance: body.appearance ?? body.persona?.appearance,
    lifeStage: body.lifeStage,
  });
  figure.addEventListener("click", () => {
    $("#map-agent").value = body.id;
    state.mapAgent = body.id;
    renderMapOverlay();
  });
  state.agents.set(body.id, {
    def: body,
    figure,
    coord: body.coord,
    connection: body.connection,
    speaking: false,
    thinking: false,
  });
  placeFigure(body.id, body.coord);

  const col = document.createElement("div");
  col.className = "memory-col";
  col.id = `memcol-${body.id}`;
  const bodyColor = (body.appearance ?? body.persona?.appearance)?.bodyColor ?? "#8b90a1";
  col.innerHTML = `<h3 style="color:${bodyColor}">${escapeHtml(body.persona?.name ?? "unnamed")}</h3><ul class="memory-list" id="mem-${body.id}"></ul>`;
  $("#memory-columns").appendChild(col);

  const card = document.createElement("div");
  card.className = "client-card";
  card.id = `client-${body.id}`;
  $("#roster-cards").appendChild(card);
  renderRosterCard(body.id);
  renderMemories(body.id, body.memories);

  const opt = document.createElement("option");
  opt.value = body.id;
  opt.textContent = body.persona?.name ?? "unnamed";
  $("#map-agent").appendChild(opt);
  updateSlotBadge();
}

function removeAgent(agentId) {
  const a = state.agents.get(agentId);
  if (!a) return;
  a.figure.remove();
  document.getElementById(`memcol-${agentId}`)?.remove();
  document.getElementById(`client-${agentId}`)?.remove();
  document.querySelector(`#map-agent option[value="${agentId}"]`)?.remove();
  state.agents.delete(agentId);
  if (state.mapAgent === agentId) {
    state.mapAgent = "";
    $("#map-agent").value = "";
    renderMapOverlay();
  }
  refreshAllStates();
  updateSlotBadge();
}

// ---------- state machine per figure ----------

function effectiveState(a) {
  const conn = a.connection.state;
  if (conn === "unmanned") return "unmanned";
  if (conn === "stalled") return "stalled";
  if (a.speaking) return "speaking";
  const neighborSpeaking = [...state.agents.values()].some(
    (o) => o !== a && o.coord === a.coord && o.speaking
  );
  if (neighborSpeaking) return "listening";
  if (a.thinking) return "thinking";
  return "idle";
}

function refreshAllStates() {
  for (const a of state.agents.values()) {
    setFigureState(a.figure, effectiveState(a));
    // Gaze toward a cellmate if one exists (by DOM order within the cell).
    const cellmates = [...state.agents.values()].filter((o) => o !== a && o.coord === a.coord);
    if (cellmates.length === 0 || !a.figure.parentElement) {
      setGaze(a.figure, 0);
    } else {
      const siblings = [...a.figure.parentElement.children];
      setGaze(a.figure, siblings.indexOf(cellmates[0].figure) < siblings.indexOf(a.figure) ? -1 : 1);
    }
  }
}

// ---------- panels ----------

function renderRosterCard(agentId) {
  const a = state.agents.get(agentId);
  const c = a.connection;
  const p = a.def.persona;
  const card = document.getElementById(`client-${agentId}`);
  if (!card) return;
  card.innerHTML = `
    <h3 style="color:${p?.appearance?.bodyColor ?? "#8b90a1"}">${escapeHtml(p?.name ?? "unnamed")} <span class="conn conn-${c.state}">${c.state}</span></h3>
    <dl>
      <dt>client</dt><dd>${escapeHtml(c.clientName ?? "—")}</dd>
      <dt>model</dt><dd>${escapeHtml(c.modelHint ?? "—")}</dd>
      <dt>latency</dt><dd>${c.lastActionLatencyMs != null ? c.lastActionLatencyMs + " ms" : "—"}</dd>
      <dt>misses</dt><dd>${c.consecutiveMisses}</dd>
      <dt>cell</dt><dd>${a.coord}</dd>
      <dt>intent</dt><dd class="intent">${escapeHtml(a.def.currentIntent ?? "—")}</dd>
      <dt>reason</dt><dd class="reason">${escapeHtml(a.def.lastReason ?? "—")}</dd>
      <dt>objective</dt><dd class="objective">${escapeHtml(p.privateObjective)}</dd>
    </dl>`;
}

function renderMemories(agentId, memories) {
  const list = document.getElementById(`mem-${agentId}`);
  if (!list) return;
  list.innerHTML = memories
    .map(
      (m) => `<li class="mem mem-${m.type}">
        <span class="mem-time">${m.simTime}</span>
        <span class="mem-imp" title="importance ${m.importance}">${m.importance}</span>
        <span class="mem-text">${escapeHtml(m.type === "speech" ? `${m.speakerName}: “${m.text}”` : m.text)}</span>
      </li>`
    )
    .join("");
  list.scrollTop = list.scrollHeight;
}

// The per-agent map overlay: unvisited cells blank, visited cells showing the
// agent's snapshot, snapshots that no longer match the live cell marked stale.
function renderMapOverlay() {
  const mapGrid = $("#map-grid");
  const legend = $("#map-legend");
  const a = state.agents.get(state.mapAgent);
  if (!a) {
    mapGrid.innerHTML = "";
    legend.hidden = true;
    return;
  }
  legend.hidden = false;
  const known = new Map((a.def.knownCells ?? []).map((k) => [k.coord, k]));
  mapGrid.innerHTML = "";
  mapGrid.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const coord = `${x},${y}`;
      const k = known.get(coord);
      const el = document.createElement("div");
      el.className = "map-cell";
      if (!k) {
        el.classList.add("map-unvisited");
      } else {
        el.classList.add("map-visited");
        const snapName = k.structure?.authored.name ?? null;
        const liveName = state.cells.get(coord)?.structure?.authored.name ?? null;
        const liveDesc = state.cells.get(coord)?.structure?.authored.description ?? null;
        const snapDesc = k.structure?.authored.description ?? null;
        const stale = snapName !== liveName || snapDesc !== liveDesc;
        el.innerHTML = `
          <span class="map-coord">${coord}${a.coord === coord ? " ◉" : ""}</span>
          <span class="map-structure">${snapName ? "⌂ " + escapeHtml(snapName) : ""}</span>
          <span class="map-meta">t${k.lastSeenTick}${stale ? ' <span class="stale-mark" title="stale: the cell has changed since this agent last stood here">▲</span>' : ""}</span>`;
      }
      mapGrid.appendChild(el);
    }
  }
}

let refreshTimer = null;
function scheduleMemoryRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    for (const agentId of [...state.agents.keys()]) {
      const res = await fetch(`/observatory/agent/${agentId}`);
      if (!res.ok) continue; // released/reaped between events
      const body = await res.json();
      const a = state.agents.get(agentId);
      if (!a) continue;
      a.def = body;
      a.connection = body.connection;
      renderMemories(agentId, body.memories);
      renderRosterCard(agentId);
    }
    refreshAllStates();
    renderMapOverlay();
  }, 120);
}

function feed(kind, simTime, html) {
  const li = document.createElement("li");
  li.className = `feed-${kind}`;
  li.innerHTML = `<span class="feed-time">${simTime ?? ""}</span> ${html}`;
  $("#feed").prepend(li);
  while ($("#feed").children.length > 200) $("#feed").lastChild.remove();
}

function regFeed(kind, html) {
  const li = document.createElement("li");
  li.className = `feed-${kind}`;
  li.innerHTML = html;
  $("#reg-feed").prepend(li);
  while ($("#reg-feed").children.length > 100) $("#reg-feed").lastChild.remove();
}

function updateSlotBadge() {
  $("#slot-badge").textContent = `slots ${state.slots.used}/${state.slots.total}`;
}

function updateClock(tick, simTime, phase, paused, stopped) {
  if (simTime) $("#sim-time").textContent = simTime;
  $("#tick-counter").textContent = `tick ${tick}${state.maxTicks ? " / " + state.maxTicks : ""}`;
  const badge = $("#phase-badge");
  badge.textContent = stopped ? "complete" : paused && phase !== "COLLECTING" ? "paused" : phase.toLowerCase();
  badge.className = `phase phase-${stopped ? "stopped" : phase.toLowerCase()}`;
}

function setGridStatus(text) {
  const el = $("#grid-status");
  if (text) {
    el.textContent = text;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ---------- init ----------

function initFromSnapshot(snap) {
  state.gridSize = snap.gridSize;
  state.maxTicks = snap.maxTicks;
  state.slots = snap.slots;
  state.cells = new Map(snap.cells.map((c) => [c.coord, { structure: c.structure }]));
  state.agents.clear();
  state.mapAgent = "";

  $("#premise").textContent = snap.premise ?? "";
  $("#grid-title").textContent = `World — ${snap.gridSize}×${snap.gridSize}`;
  $("#memory-columns").innerHTML = "";
  $("#roster-cards").innerHTML = "";
  $("#feed").innerHTML = "";
  $("#reg-feed").innerHTML = "";
  $("#map-agent").innerHTML = `<option value="">select an agent…</option>`;
  $("#banner").hidden = true;

  buildGrid();
  for (const coord of state.cells.keys()) renderCellStructure(coord);
  for (const agent of snap.agents) addAgent(agent);

  if (snap.agents.length === 0 || snap.waitingForAgents) {
    setGridStatus(`Waiting for agents — ${snap.slots.used}/${snap.minAgents ?? 2} registered. The world is empty until clients register.`);
  } else {
    setGridStatus(null);
  }
  updateClock(snap.tick, snap.simTime, snap.phase, snap.paused, snap.stopped);
  $("#speed").value = String(snap.speed);
  updateSlotBadge();
  renderMapOverlay();
  refreshAllStates();
}

// ---------- SSE wiring ----------

const es = new EventSource("/observatory/stream");
const on = (event, fn) => es.addEventListener(event, (e) => fn(JSON.parse(e.data)));

on("snapshot", initFromSnapshot);

on("registered", async (d) => {
  state.slots = d.slots;
  updateSlotBadge();
  regFeed("registered", `<b style="color:${d.appearance.bodyColor}">${escapeHtml(d.name)}</b> registered (${escapeHtml(d.clientName ?? "unnamed client")}) — spawned at ${d.coord}`);
  const res = await fetch(`/observatory/agent/${d.agentId}`);
  if (res.ok) addAgent(await res.json());
  setGridStatus(null);
});

on("released", (d) => {
  state.slots = d.slots;
  regFeed("released", `${escapeHtml(d.name)} released — slot freed, structures remain`);
  removeAgent(d.agentId);
});

on("reaped", (d) => {
  state.slots = d.slots;
  regFeed("reaped", `☠ ${escapeHtml(d.name)} reaped at tick ${d.tick} — slot freed, structures remain`);
  removeAgent(d.agentId);
});

on("tick_open", (d) => {
  updateClock(d.tick, d.simTime, "COLLECTING", false, false);
  setGridStatus(null);
  for (const agentInfo of d.agents) {
    const a = state.agents.get(agentInfo.agentId);
    if (a && a.coord !== agentInfo.coord) placeFigure(agentInfo.agentId, agentInfo.coord);
  }
});

on("speech", (d) => {
  const a = state.agents.get(d.speaker);
  if (!a) return;
  a.speaking = true;
  showBubble(a.figure, d.text);
  refreshAllStates();
  setTimeout(() => {
    a.speaking = false;
    refreshAllStates();
  }, 4200);
  feed("speech", d.simTime, `<b style="color:${colorOf(d.speaker)}">${escapeHtml(nameOf(d.speaker))}</b>: “${escapeHtml(d.text)}”`);
  scheduleMemoryRefresh();
});

on("move", (d) => {
  if (state.agents.has(d.agentId)) placeFigure(d.agentId, d.to);
  feed("move", d.simTime, `${escapeHtml(nameOf(d.agentId))} moved ${d.from} → ${d.to}`);
  scheduleMemoryRefresh();
});

on("build", (d) => {
  state.cells.set(d.coord, { structure: { authored: d.structure } });
  renderCellStructure(d.coord);
  feed("build", d.simTime, `<b style="color:${colorOf(d.agentId)}">${escapeHtml(nameOf(d.agentId))}</b> built “${escapeHtml(d.structure.name)}” at ${d.coord}`);
  scheduleMemoryRefresh();
});

on("reflection", (d) => {
  feed("reflection", d.simTime, `${escapeHtml(nameOf(d.agentId))} reflects: ${escapeHtml(d.text)}`);
  scheduleMemoryRefresh();
});

on("client_state", (d) => {
  const a = state.agents.get(d.agentId);
  if (!a) return;
  a.connection = { ...a.connection, ...d };
  renderRosterCard(d.agentId);
  refreshAllStates();
});

on("takeover", (d) => {
  regFeed("takeover", `⚡ takeover: ${escapeHtml(nameOf(d.agentId))} is now driven by ${escapeHtml(d.clientName ?? "an unnamed client")}`);
});

on("barrier", (d) => {
  switch (d.event) {
    case "observation_emitted": {
      // The real start of this agent's decision window.
      const a = state.agents.get(d.agentId);
      if (a) {
        a.thinking = true;
        refreshAllStates();
      }
      break;
    }
    case "action_received": {
      // The real end of it: on-screen thinking duration equals measured latency.
      const a = state.agents.get(d.agentId);
      if (a) {
        a.thinking = false;
        refreshAllStates();
      }
      break;
    }
    case "waiting_for_agents":
      setGridStatus(`Waiting for agents — ${d.registered}/${d.needed} registered.`);
      break;
    case "tick_closed":
      for (const a of state.agents.values()) a.thinking = false;
      updateClock(d.tick, null, "CLOSED", false, false);
      refreshAllStates();
      break;
    case "tick_resolved":
      updateClock(d.tick, null, "RESOLVED", true, false);
      scheduleMemoryRefresh();
      break;
    case "run_complete": {
      const banner = $("#banner");
      banner.textContent = `Run complete at tick ${d.tick}. The world holds; extend or reset to go again.`;
      banner.hidden = false;
      break;
    }
  }
});

// ---------- controls ----------

$("#map-agent").onchange = (e) => {
  state.mapAgent = e.target.value;
  renderMapOverlay();
};

let paused = true;
async function control(action, speed, extra = {}) {
  const res = await fetch("/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(speed != null ? { speed } : {}), ...extra }),
  });
  const body = await res.json();
  if (body.ok) {
    paused = body.state.paused;
    if (body.state.maxTicks) state.maxTicks = body.state.maxTicks;
    if (!body.state.stopped) $("#banner").hidden = true;
    updateClock(body.state.tick, null, body.state.phase, body.state.paused, body.state.stopped);
    if (body.state.waitingForAgents) setGridStatus("Waiting for agents…");
  }
}

$("#btn-play").onclick = () => control("play", Number($("#speed").value));
$("#btn-pause").onclick = () => control("pause");
$("#btn-step").onclick = () => control("step");
$("#btn-extend").onclick = () => control("extend", null, { ticks: 20 });
$("#btn-reset").onclick = () => control("reset");
$("#speed").onchange = () => control(paused ? "pause" : "play", Number($("#speed").value));
