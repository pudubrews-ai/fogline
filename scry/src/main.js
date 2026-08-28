// Wiring: config -> source (live SSE or replay file) -> one reducer ->
// scene + panels. One world-state object, one reducer, one render loop.
// The observatory renders what the daemon publishes and decides nothing.

import { createStage } from "./scene/stage.js";
import { createLighting } from "./scene/lighting.js";
import { createGround } from "./scene/ground.js";
import { createStructures } from "./scene/structures.js";
import { createAgents } from "./scene/agents.js";
import { createProps } from "./scene/props.js";
import { createCameraRig } from "./scene/camera.js";
import { LiveSource } from "./source/live.js";
import { parseLog, ReplayRun, loadLogText } from "./source/replay.js";
import { createTransport } from "./panels/transport.js";
import { renderRoster } from "./panels/roster.js";
import { renderInspector } from "./panels/inspector.js";
import { renderMemory } from "./panels/memory.js";
import { renderAgentMap } from "./panels/agentmap.js";
import { renderLineage } from "./panels/lineage.js";
import { renderLedger } from "./panels/ledger.js";
import { renderNorms } from "./panels/norms.js";
import { renderFeed } from "./panels/feed.js";
import { renderViability } from "./panels/viability.js";
import { renderSpend } from "./panels/spend.js";
import { renderInscriptions } from "./panels/inscriptions.js";
import { renderAnalyst } from "./panels/analyst.js";
import { renderConfigPanel } from "./panels/configpanel.js";
import { renderCrosscheck } from "./panels/crosscheck.js";
import { createTickerBar } from "./panels/tickerbar.js";
import { tabTitle } from "./tabtitle.js";
import { isNotable, phrase, itemsAroundTick } from "./ticker.js";
import { cellHoverLines, believedHoverLines } from "./panels/cellhover.js";
import { createReadonlyClient } from "./analyst/readonly.js";
import { shouldConsult } from "./analyst/watch.js";
import { buildContext } from "./analyst/retrieve.js";
import * as THREE from "three";

import config from "../config.json";

const params = new URLSearchParams(location.search);
const mode = params.get("source") ?? config.source ?? "live";
const daemonBase = params.get("daemon") ?? config.daemon ?? "http://localhost:3000";
// The analyst's ONLY daemon access: the read-only client (spec v0.8 §2.3).
// The config and crosscheck panels reuse it — they too only ever read.
const readonly = createReadonlyClient(daemonBase);

// ---------- scene ----------

const stageEl = document.getElementById("stage");
const stage = createStage(stageEl, { post: config.post ?? {} });
let world = null; // built once gridSize is known

function buildWorld(gridSize) {
  world = {
    gridSize,
    lighting: createLighting(stage.scene, gridSize),
    ground: createGround(stage.scene, gridSize),
    structures: createStructures(stage.scene, gridSize, { weathering: config.weathering !== false }),
    agents: createAgents(stage.scene, gridSize),
    props: createProps(stage.scene, gridSize),
    rig: createCameraRig({
      camera: stage.camera,
      dom: stage.renderer.domElement,
      gridSize,
      minShotTicks: config.director?.minShotTicks ?? 3,
    }),
  };
  world.rig.bindAgentLookup((id) => world.agents.byId.get(id)?.root.position ?? null);
}

// ---------- shared UI context ----------

let state = null;
const ctx = {
  selectedId: null,
  clientMeta: new Map(), // agentId -> {modelHint, clientName} from live client_state
  config,
  showTruth: false,
  memoryQuery: "",
  feedFilter: "all",
  inscriptionCoord: null, // the wall the inscriptions panel is showing
  select(id) {
    ctx.selectedId = id;
    refreshPanel();
  },
  refresh: () => refreshPanel(),
  setMapOverlay(known) {
    overlayKnown = known;
    applyOverlay();
  },
  onEventClick(ev) {
    if (mode === "replay") seekTo(ev.tick);
    // An inscribe event opens that wall's history (spec v0.6 §3): the
    // panel is reachable from the feed in both modes.
    if (ev.type === "inscribe" && ev.coord) {
      ctx.openInscriptions(ev.coord);
      return;
    }
    if (mode !== "replay") {
      const id = ev.agentId ?? ev.actor ?? ev.speaker ?? null;
      if (id && state?.agents.has(id)) ctx.select(id);
    }
  },
  openInscriptions(coord) {
    ctx.inscriptionCoord = coord;
    activePanel = "inscriptions";
    refreshPanel();
  },
  // v0.8 panel state. The analyst's objectives toggle defaults OFF — the
  // operator chose behaviour-only as the default (spec §2.7).
  analyst: {
    log: [],
    includeObjectives: false,
    watchOn: false,
    busy: false,
    callsTotal: 0,
    draft: "",
    sidecar: params.get("analyst") ?? config.analyst ?? "http://localhost:3200",
    readonly,
  },
  configPanel: { readonly, base: null, baseRunId: null, draft: null, name: "", typicalCost: null, loaded: false, refresh: () => {} },
  crosscheckPanel: { readonly, rows: null, openRunId: null, report: null, status: null, error: null, refresh: () => {} },
  runState: { paused: false, stopped: false, waitingForAgents: false },
};

// ---------- panels ----------

const PANELS = [
  ["roster", renderRoster],
  ["inspector", renderInspector],
  ["memory", renderMemory],
  ["map", renderAgentMap],
  ["lineage", renderLineage],
  ["ledger", renderLedger],
  ["inscriptions", renderInscriptions],
  ["norms", renderNorms],
  ["feed", renderFeed],
  ["viability", renderViability],
  ["spend", renderSpend],
  ["analyst", renderAnalyst],
  ["config", renderConfigPanel],
  ["crosscheck", renderCrosscheck],
];
let activePanel = "roster";
const tabsEl = document.getElementById("tabs");
const panelEl = document.getElementById("panel");
for (const [name] of PANELS) {
  const b = document.createElement("button");
  b.textContent = name;
  b.dataset.panel = name;
  b.onclick = () => {
    activePanel = name;
    if (name !== "map") ctx.setMapOverlay(null);
    refreshPanel();
  };
  tabsEl.appendChild(b);
}

function refreshPanel() {
  if (!state) return;
  for (const b of tabsEl.children) b.classList.toggle("active", b.dataset.panel === activePanel);
  const render = PANELS.find(([n]) => n === activePanel)[1];
  render(panelEl, state, ctx);
  if (activePanel !== "map") ctx.setMapOverlay(null);
}

// ---------- agent-map overlay (spec §8.4) ----------

let overlayKnown = null;
function applyOverlay() {
  if (!world || !state) return;
  world.ground.setOverlay(overlayKnown);
  const agent = overlayKnown ? state.agents.get(ctx.selectedId) : null;
  if (agent && !ctx.showTruth) {
    // Redraw structures as THAT agent knows them: snapshot structures in
    // visited cells, nothing anywhere else. Props and other agents drop out;
    // this is a picture of a mind, not of the world.
    const syntheticCells = new Map();
    for (const [coord] of state.cells) {
      syntheticCells.set(coord, { coord, deposit: null, loose: null, structure: null, corpses: [], fragment: null });
    }
    for (const [coord, k] of agent.knownCells) {
      syntheticCells.get(coord).structure = k.structure ? { ...k.structure, builtAtTick: k.structure.builtAtTick ?? k.lastSeenTick } : null;
    }
    world.structures.sync({ cells: syntheticCells, tick: state.tick });
    world.props.group.visible = false;
    for (const [id, v] of world.agents.byId) v.root.visible = id === ctx.selectedId;
  } else {
    world.structures.sync(state);
    world.props.group.visible = true;
    for (const v of world.agents.byId.values()) v.root.visible = true;
  }
}

// ---------- state intake ----------

const hud = document.getElementById("hud");
// The ticker (spec v0.8 §5): selective, paced, recycling — never blank once
// anything has happened. Fed from the reducer's events; never the analyst.
const tickerBar = createTickerBar(document.getElementById("ticker"));
let tickerSeenTick = 0;

function refreshTitle() {
  // Snapshot folds carry the flags; between snapshots the barrier signals
  // keep ctx.runState current (paused / waiting / stopped, spec §6).
  const runState = {
    paused: state?.paused || ctx.runState.paused,
    stopped: state?.stopped || ctx.runState.stopped,
    waitingForAgents: state?.waitingForAgents || ctx.runState.waitingForAgents,
  };
  document.title = tabTitle(state, runState);
}

function onState(next) {
  const firstBoot = state === null || (world && next.gridSize !== world.gridSize);
  state = next;
  if (!world || firstBoot) {
    if (world) location.reload(); // grid changed mid-session: rebuild clean
    else buildWorld(state.gridSize || 8);
  }
  world.structures.sync(state);
  world.props.sync(state);
  world.agents.sync(state);
  world.rig.onState(state);
  world.lighting.update(state.simTime, lightingOverride);
  hud.textContent = `${state.premise ?? ""}${state.runId ? `  ·  run ${state.runId}` : ""}`;
  transport?.setClock(state.tick, state.simTime, state.maxTicks ? `of ${state.maxTicks}` : "");
  refreshTitle();
  if (state.crosscheckStatus) ctx.crosscheckPanel.status = state.crosscheckStatus;
  if (mode === "live") {
    if (state.tick < tickerSeenTick) tickerSeenTick = 0; // reset/new run
    const fresh = state.events.filter((ev) => ev.tick > tickerSeenTick && isNotable(ev));
    tickerSeenTick = state.tick;
    tickerBar.push(
      fresh
        .map((ev) => ({ text: phrase(ev, state), pinned: ev.type === "death" }))
        .filter((item) => item.text)
    );
    maybeWatch();
  }
  refreshPanel();
  if (overlayKnown) applyOverlay();
}

// Watch mode (spec §2.4): rides situationChanged from the tick record — a
// tick where nothing changed for anyone costs no model call.
let watchBusy = false;
async function maybeWatch() {
  const a = ctx.analyst;
  if (!a.watchOn || watchBusy || !state) return;
  const record = {
    tick: state.tick,
    situations: state.lastSituations,
    events: state.events.filter((ev) => ev.tick === state.tick),
  };
  if (!shouldConsult(record)) return;
  watchBusy = true;
  try {
    const notable = record.events.filter(isNotable).map((ev) => phrase(ev, state)).filter(Boolean);
    const question =
      `Watch mode, tick ${record.tick}. Notable this tick: ${notable.join(" ") || "situation changes only."} ` +
      `In one or two flat sentences: is anything here worth the operator's attention, and why? If not, answer "nothing notable".`;
    const context = buildContext(question, { state, index: null, includeObjectives: a.includeObjectives });
    const res = await fetch(`${a.sidecar}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, context }),
    });
    const body = await res.json();
    if (body.callsTotal != null) a.callsTotal = body.callsTotal;
    if (body.answer && !/^nothing notable/i.test(body.answer.trim())) {
      a.log.push({ kind: "watch", tick: record.tick, text: body.answer });
      if (activePanel === "analyst") refreshPanel();
    }
  } catch {
    // sidecar down: watch mode silently idles; ask-anything reports it
  } finally {
    watchBusy = false;
  }
}

// ---------- sources ----------

let transport = null;
// Operator lighting override (spec v0.6 §2): null follows sim time; an
// "HH:MM" string holds the lights at that hour. Not diegetic.
let lightingOverride = null;
const onLighting = (value) => {
  lightingOverride = value === "follow" ? null : value;
  if (world && state) world.lighting.update(state.simTime, lightingOverride);
};
let live = null;
let replay = null; // {runs, run, playhead, playing, speed, timer}

if (mode === "live") {
  live = new LiveSource({
    daemon: params.get("daemon") ?? config.daemon ?? "http://localhost:3000",
    onState,
    onSignal(event, data) {
      world?.agents.onSignal(event, data);
      if (event === "client_state") {
        ctx.clientMeta.set(data.agentId, { modelHint: data.modelHint, clientName: data.clientName, surface: data.surface ?? null });
      }
      // Crosscheck supervision state rides the operator stream (daemon §3.2a).
      if (event === "crosscheck") {
        ctx.crosscheckPanel.status = data;
        if (activePanel === "crosscheck") refreshPanel();
      }
      // Run-state flags between snapshots, for the tab title (spec §6).
      if (event === "barrier") {
        if (data.event === "pause_requested") ctx.runState.paused = true;
        if (data.event === "resumed") ctx.runState.paused = false;
        if (data.event === "run_complete") ctx.runState.stopped = true;
        if (data.event === "waiting_for_agents") ctx.runState.waitingForAgents = true;
        if (data.event === "tick_open" || data.event === "reset" || data.event === "extended") {
          ctx.runState.waitingForAgents = false;
          if (data.event !== "tick_open") ctx.runState.stopped = false;
        }
        refreshTitle();
      }
    },
  });
  transport = createTransport(document.getElementById("transport"), {
    mode: "live",
    onControl: (action, extra) => live.control(action, extra).catch(() => {}),
    onSeek: () => {},
    onSpeed: (s) => live.control("play", { speed: s }).catch(() => {}),
    onLighting,
  });
  live.connect();
} else {
  const file = params.get("file") ?? config.replayFile ?? "./ticks.log";
  bootReplay(file);
}

async function bootReplay(file) {
  let text;
  try {
    text = await loadLogText(file);
  } catch (err) {
    hud.textContent = `could not load ${file} — drop a ticks.log on the page`;
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) startReplay(parseLog(await f.text()));
    });
    return;
  }
  startReplay(parseLog(text));
}

function startReplay(parsed) {
  const { runs } = parsed;
  if (runs.length === 0) {
    hud.textContent = "no runs found in that log";
    return;
  }
  // Run picker whenever more than one run is present (spec §3.5): events
  // from two runs are never folded into one state.
  if (runs.length > 1) {
    const picker = document.getElementById("runpicker");
    picker.style.display = "flex";
    picker.innerHTML = `<div class="box"><h3>This log holds ${runs.length} runs</h3></div>`;
    const box = picker.querySelector(".box");
    runs.forEach((run, i) => {
      const b = document.createElement("button");
      const ticks = run.records.length > 0 ? `${run.records[0].tick}–${run.records[run.records.length - 1].tick}` : "empty";
      b.textContent = `run ${i + 1} · ${run.runId} · ticks ${ticks}`;
      b.onclick = () => {
        picker.style.display = "none";
        openRun(run);
      };
      box.appendChild(b);
    });
  } else {
    openRun(runs[0]);
  }
}

function openRun(run) {
  const rr = new ReplayRun(run);
  replay = { run: rr, playhead: 0, playing: false, speed: 1, lastAdvance: 0 };
  transport = createTransport(document.getElementById("transport"), {
    mode: "replay",
    onControl(action) {
      if (action === "play") replay.playing = true;
      if (action === "pause") replay.playing = false;
      if (action === "step") {
        replay.playing = false;
        seekTo(Math.min(rr.lastTick, replay.playhead + 1));
      }
    },
    onSeek: (tick) => seekTo(tick),
    onSpeed: (s) => (replay.speed = s),
    onLighting,
  });
  transport.setMarkers(rr.markers(), rr.lastTick);
  transport.setRange(rr.lastTick, 0);
  seekTo(rr.records.length > 0 ? rr.records[0].tick : 0);
}

function seekTo(tick) {
  if (!replay) return;
  const prevTick = replay.playhead;
  replay.playhead = Math.max(0, Math.min(replay.run.lastTick, tick));
  const next = replay.run.stateAtTick(replay.playhead);
  onState(next);
  transport.setRange(replay.run.lastTick, replay.playhead);
  // Ticker in replay (spec §5.6): synced to the scrubber — seeking to tick
  // 400 shows what was on the ticker around tick 400.
  tickerBar.setItems(itemsAroundTick(next.events, replay.playhead, next));
  // Thinking in replay: play back each agent's measured latency when moving
  // forward one tick — the record's latencyMs, capped to the tick interval.
  if (replay.playhead === prevTick + 1) {
    const rec = replay.run.records.find((r) => r.tick === replay.playhead);
    for (const a of rec?.actions ?? []) {
      if (a.latencyMs != null) world.agents.thinkFor(a.agentId, Math.min(a.latencyMs / replay.speed, 900 / replay.speed));
    }
  }
}

// ---------- hover labels, selection, screenshot, UI toggle ----------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hoverLabel = document.getElementById("hover-label");

stage.renderer.domElement.addEventListener("pointermove", (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  if (!world || !state) return;
  raycaster.setFromCamera(pointer, stage.camera);
  const hits = raycaster.intersectObjects([world.agents.group, world.structures.group, world.ground.group], true);
  let label = null;
  for (const hit of hits) {
    let node = hit.object;
    while (node && !node.userData.coord && node.parent) {
      // climb to an agent root or structure root
      const agentEntry = [...world.agents.byId.entries()].find(([, v]) => v.root === node);
      if (agentEntry) {
        const agent = state.agents.get(agentEntry[0]);
        label = agent?.name ?? `unnamed ${agent?.lifeStage ?? "body"}`;
        break;
      }
      const structEntry = [...world.structures.byCoord.entries()].find(([, s]) => s.root === node);
      if (structEntry) {
        label = `“${structEntry[1].record.authored.name}”`;
        break;
      }
      node = node.parent;
    }
    if (label) break;
  }
  // Cell hover (scry spec v0.9 §3): no agent or structure under the
  // pointer — read the ground tile's cell out of reducer state. Under an
  // agent-map overlay the tooltip shows what the SELECTED AGENT believes
  // is there, marked stale; the true state stays on the panel's toggle.
  if (!label) {
    const tile = hits.find((h) => h.object.userData?.coord);
    if (tile) {
      const coord = tile.object.userData.coord;
      const lines =
        overlayKnown && ctx.selectedId
          ? believedHoverLines(state, coord, ctx.selectedId)
          : cellHoverLines(state, coord);
      label = lines.join("\n");
    }
  }
  if (label) {
    hoverLabel.style.display = "block";
    hoverLabel.style.left = `${e.clientX + 12}px`;
    hoverLabel.style.top = `${e.clientY + 12}px`;
    hoverLabel.style.whiteSpace = "pre-line";
    hoverLabel.textContent = label;
  } else {
    hoverLabel.style.display = "none";
  }
});

stage.renderer.domElement.addEventListener("click", (e) => {
  if (!world || !state) return;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
  const hits = raycaster.intersectObjects([world.agents.group, world.structures.group], true);
  for (const hit of hits) {
    let node = hit.object;
    while (node) {
      const entry = [...world.agents.byId.entries()].find(([, v]) => v.root === node);
      if (entry) {
        ctx.select(entry[0]);
        return;
      }
      // A structure opens its inscription history (spec v0.6 §3): the
      // panel is reachable straight from the 3D view.
      const structEntry = [...world.structures.byCoord.entries()].find(([, s]) => s.root === node);
      if (structEntry) {
        ctx.openInscriptions(structEntry[0]);
        return;
      }
      node = node.parent;
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "1") world?.rig.setMode("orbit");
  if (e.key === "2" && ctx.selectedId) world?.rig.follow(ctx.selectedId);
  if (e.key === "3") world?.rig.setMode("free");
  if (e.key === "4") world?.rig.setMode("director");
  if (e.key === "h") document.body.classList.toggle("hidden-ui");
  if (e.key === "p") {
    // Screenshot with UI hidden (spec §6): clips come out of this app.
    const hadUI = !document.body.classList.contains("hidden-ui");
    if (hadUI) document.body.classList.add("hidden-ui");
    stage.render();
    const a = document.createElement("a");
    a.download = `fogline-t${state?.tick ?? 0}.png`;
    a.href = stage.renderer.domElement.toDataURL("image/png");
    a.click();
    if (hadUI) document.body.classList.remove("hidden-ui");
  }
  if (e.key === " " && replay) {
    e.preventDefault();
    replay.playing = !replay.playing;
  }
});

// ---------- render loop ----------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (world) {
    // Replay playback advances the playhead on a real-time cadence.
    if (replay?.playing && now - replay.lastAdvance > 800 / replay.speed) {
      replay.lastAdvance = now;
      if (replay.playhead >= replay.run.lastTick) replay.playing = false;
      else seekTo(replay.playhead + 1);
    }
    world.agents.update(now, dt, stage.camera.position);
    world.rig.update(dt);
    stage.render();
  }
  if (mode === "live") tickerBar.tick(now); // paced release; replay is scrubber-driven
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
