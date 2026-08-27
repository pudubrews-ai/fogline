// v0.5 gates (observatory spec §5): structures render, the material floor
// becomes machine-checkable, the sun tracks sim time, agents stay distinct,
// the fragment slab appears and disappears with the record, surfaces group
// on the roster, and the behavioral tax computes. All headless scene-graph
// assertions — sun quality and overall fidelity still need eyes on
// `npm run dev`.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createState, reduce } from "../src/source/reducer.js";
import { createStructures } from "../src/scene/structures.js";
import { createGround } from "../src/scene/ground.js";
import { createProps } from "../src/scene/props.js";
import { createAgents } from "../src/scene/agents.js";
import { createLighting } from "../src/scene/lighting.js";
import { PALETTE } from "../src/theme.js";
import { surfaceGroups, connectionLabel } from "../src/panels/roster.js";
import { viabilityModel } from "../src/panels/viability.js";

// agents.js draws speech bubbles onto a canvas; headless tests need only a
// stand-in that satisfies the constructor path (nothing is drawn here).
globalThis.document ??= {};
if (!globalThis.document.createElement) {
  globalThis.document.createElement = () => ({ width: 0, height: 0, getContext: () => null });
}

const FORMS = ["tower", "hut", "wall", "platform", "pit", "marker"];

const structureRecord = (form, i) => ({
  coord: `${i},0`,
  deposit: null,
  loose: null,
  structure: { form, authored: { name: `The ${form}`, description: "x", inscription: i % 2 === 0 ? "carved" : null }, demolishProgress: null, builtAtTick: 3, history: [] },
  corpses: [],
  fragment: null,
});

function replayStateWithAllForms() {
  let state = reduce(null, {
    event: "run_started",
    runId: "r_test",
    gridSize: 8,
    premise: "x",
    maxTicks: 100,
    startSimTime: "09:00",
    deposits: [],
  });
  state = reduce(state, {
    tick: 5,
    simTime: "10:00",
    summary: {},
    events: [],
    memories: [],
    actions: [],
    bodies: [],
    cells: FORMS.map(structureRecord),
  });
  return state;
}

// ---------- 1. structures render ----------

test("GATE structures render: a replay with built structures produces geometry for each, one per form", () => {
  const state = replayStateWithAllForms();
  const scene = new THREE.Scene();
  const structures = createStructures(scene, 8);
  structures.sync(state);
  assert.equal(structures.byCoord.size, FORMS.length, "one entry per built cell");
  for (const [i, form] of FORMS.entries()) {
    const entry = structures.byCoord.get(`${i},0`);
    assert.ok(entry, `${form} present`);
    let meshes = 0;
    entry.root.traverse((n) => n.isMesh && meshes++);
    assert.ok(meshes > 0, `${form} carries geometry`);
    assert.equal(entry.record.form, form);
  }
  // And removal: a state without them clears the scene.
  structures.sync({ cells: new Map([["0,0", { coord: "0,0", structure: null }]]), tick: 6 });
  assert.equal(structures.byCoord.size, 0, "structures leave when the record loses them");
});

// ---------- 2. material floor ----------

test("GATE material floor: every material in a full scene has roughness >= 0.85 and metalness 0 — zero exceptions", () => {
  const scene = new THREE.Scene();
  const gridSize = 8;
  createGround(scene, gridSize);
  const structures = createStructures(scene, gridSize);
  const props = createProps(scene, gridSize);
  const agents = createAgents(scene, gridSize);

  const state = replayStateWithAllForms();
  // Add every prop species and a mid-demolition structure.
  state.cells.set("0,1", { coord: "0,1", deposit: { resource: "sivet", quantity: 8 }, loose: null, structure: null, corpses: [], fragment: null });
  state.cells.set("1,1", { coord: "1,1", deposit: null, loose: { rubble: 6, orrum: 2 }, structure: null, corpses: [], fragment: { text: "x" } });
  state.cells.set("2,1", { coord: "2,1", deposit: null, loose: null, structure: null, corpses: [{ authored: { name: "Old Marle" }, appearance: { scale: "medium" }, diedAtTick: 1 }], fragment: null });
  state.cells.get("0,0").structure.demolishProgress = { ticks: 2, required: 3 };
  state.agents.set("a_1", {
    agentId: "a_1", name: "Vek", coord: "3,3", prevCoord: "3,3", lifeStage: "adult",
    appearance: { bodyColor: "#5a6b5e", eyeColor: "#ff4400", scale: "medium", shell: "ridged", eyes: "pair" },
    vitality: 90, sustenance: 90, inventory: {}, memories: [], knownCells: new Map(),
  });

  structures.sync(state);
  props.sync(state);
  agents.sync(state);

  let checked = 0;
  scene.traverse((node) => {
    if (!node.isMesh && !node.isSprite) return;
    if (node.isSprite) return; // billboarded UI text, not a lit surface
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of materials) {
      if (!m) continue;
      checked += 1;
      assert.ok(m.isMeshStandardMaterial, `${node.name || node.type} bypasses the material factory (${m.type})`);
      assert.ok(m.roughness >= 0.85, `${node.name || node.type} roughness ${m.roughness} below the floor`);
      assert.equal(m.metalness, 0, `${node.name || node.type} has metalness`);
    }
  });
  assert.ok(checked > 80, `sanity: the traversal actually saw the scene (${checked} materials)`);
});

// ---------- 3. sun tracks time ----------

test("GATE sun tracks time: azimuth and color differ measurably at 06:00, 12:00, and 18:00", () => {
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 8);
  const at = (t) => {
    lighting.update(t);
    return {
      azimuth: Math.atan2(lighting.sun.position.z, lighting.sun.position.x),
      elevation: lighting.sun.position.y,
      color: lighting.sun.color.getHexString(),
      intensity: lighting.sun.intensity,
    };
  };
  const dawn = at("06:00");
  const noon = at("12:00");
  const dusk = at("18:00");

  assert.ok(Math.abs(dawn.azimuth - noon.azimuth) > 0.5, "sun swept between dawn and noon");
  assert.ok(Math.abs(noon.azimuth - dusk.azimuth) > 0.5, "and between noon and dusk");
  assert.ok(noon.elevation > dawn.elevation && noon.elevation > dusk.elevation, "noon is the high sun");
  assert.notEqual(dawn.color, noon.color, "dawn is warmer than noon");
  assert.ok(noon.intensity > dawn.intensity, "noon is brighter than dawn");
  assert.ok(lighting.sun.castShadow, "the sun casts real shadows");
  assert.ok(scene.fog instanceof THREE.Fog, "linear fog is present");
  const night = at("02:00");
  assert.ok(night.intensity < 0.2, "night is dim — the eyes carry the frame");
});

// ---------- 4. agent distinctness ----------

test("GATE agent distinctness: five bodyColors produce five distinct rendered colors, none collapsing toward black", () => {
  const scene = new THREE.Scene();
  const agents = createAgents(scene, 8);
  const colors = ["#5a6b5e", "#1c1c20", "#6e7b84", "#2a2320", "#948c7b"]; // two near-black on purpose
  const state = { agents: new Map(), events: [], tick: 1 };
  colors.forEach((c, i) => {
    state.agents.set(`a_${i}`, {
      agentId: `a_${i}`, name: `A${i}`, coord: `${i},0`, prevCoord: `${i},0`, lifeStage: "adult",
      appearance: { bodyColor: c, eyeColor: "#ff4400", scale: "medium", shell: "smooth", eyes: "pair" },
      vitality: 100, sustenance: 100, inventory: {}, memories: [], knownCells: new Map(),
    });
  });
  agents.sync(state);
  const rendered = [...agents.byId.values()].map((v) => v.body.material.color);
  assert.equal(new Set(rendered.map((c) => c.getHexString())).size, 5, "five distinct rendered colors");
  const ground = new THREE.Color(PALETTE.ground);
  for (const c of rendered) {
    const hsl = {};
    c.getHSL(hsl);
    assert.ok(hsl.l >= 0.3, `lightness ${hsl.l.toFixed(2)} stays above the collapse floor`);
    assert.notEqual(c.getHexString(), ground.getHexString(), "never the background value");
  }
});

// ---------- 5. fragment slab ----------

test("GATE fragment slab: demolished renders a slab, razed does not, gathered-to-zero removes it", () => {
  const scene = new THREE.Scene();
  const props = createProps(scene, 8);
  const cellsAt = (demolishedFragment, rubble) =>
    new Map([
      ["1,1", { coord: "1,1", deposit: null, loose: rubble > 0 ? { rubble } : null, structure: null, corpses: [], fragment: demolishedFragment }],
      ["2,2", { coord: "2,2", deposit: null, loose: { rubble: 4 }, structure: null, corpses: [], fragment: null }], // razed: rubble, NO slab
    ]);

  props.sync({ tick: 10, cells: cellsAt({ text: "The well belongs to everyone" }, 6), agents: new Map() });
  const slabs = [];
  scene.traverse((n) => n.name === "fragment-slab" && slabs.push(n));
  assert.equal(slabs.length, 1, "exactly one slab — the demolished pile has it, the razed pile does not");

  // The pile is gathered to zero: the daemon's record drops loose AND
  // fragment; the slab goes with it. No destruction spectacle, just absence.
  props.sync({ tick: 11, cells: cellsAt(null, 0), agents: new Map() });
  const after = [];
  scene.traverse((n) => n.name === "fragment-slab" && after.push(n));
  assert.equal(after.length, 0, "carry off the pile, carry off the record");
});

// ---------- 6. surface grouping ----------

test("GATE surface grouping: three agents across two surfaces group correctly; adapter_fault reads distinctly", () => {
  const state = createState();
  const mk = (id, surface, extra = {}) => ({
    agentId: id, name: id, coord: "0,0", lifeStage: "adult", connectionState: "active",
    surface, modelHint: "m", clientName: "c", lastReason: null, lastActionType: "move", ...extra,
  });
  state.agents.set("a_1", mk("a_1", "claude-cli:sub:a3f9"));
  state.agents.set("a_2", mk("a_2", "claude-cli:sub:a3f9"));
  state.agents.set("a_3", mk("a_3", "codex-cli:sub:7b21"));

  const groups = surfaceGroups(state);
  assert.equal(groups.length, 2);
  const bySurface = Object.fromEntries(groups.map(([s, list]) => [s, list.map((a) => a.agentId)]));
  assert.deepEqual(bySurface["claude-cli:sub:a3f9"].sort(), ["a_1", "a_2"], "two clients on one account sit together");
  assert.deepEqual(bySurface["codex-cli:sub:7b21"], ["a_3"]);

  // adapter_fault (v0.6 §6): driven by the typed clientStatus enum, no
  // reason-string parsing anywhere.
  assert.equal(connectionLabel(mk("a_4", null, { clientStatus: "adapter_fault", lastActionType: "wait" })), "adapter_fault");
  assert.equal(connectionLabel(mk("a_5", null, { connectionState: "stalled" })), "stalled");
  assert.equal(connectionLabel(mk("a_6", null, { lastReason: "walking north", lastActionType: "move" })), "active");
});

// ---------- 7. behavioral tax ----------

test("GATE behavioral tax: known optimal baseline minus live survivors, with the capacity countdown flag", () => {
  const state = createState();
  state.viability = { ratio: 0.73, supply: 73, demand: 100, seededSivet: 43, sivetSprings: 3, regenSupply: 30, capacity: 1.25, optimalSurvivors: 3.04, slots: 5, maxTicks: 200 };
  for (let i = 0; i < 5; i++) {
    state.agents.set(`a_${i}`, { agentId: `a_${i}`, lifeStage: "adult" });
  }
  const m = viabilityModel(state);
  assert.equal(m.population, 5);
  assert.ok(Math.abs(m.behavioralTax - -1.96) < 1e-9, "3.04 optimal − 5 alive = −1.96 (more alive than the baseline, pre-collapse)");
  assert.equal(m.overCapacity, true, "5 against capacity 1.25: the larder is being spent and the run has a countdown");

  // After the collapse: zero survivors, the tax is the whole story.
  state.agents.clear();
  const after = viabilityModel(state);
  assert.ok(Math.abs(after.behavioralTax - 3.04) < 1e-9, "3.04 optimal − 0 actual");
  assert.equal(after.overCapacity, false);
  assert.equal(viabilityModel(createState()), null, "no viability record: the panel says so instead of inventing one");
});
