// v0.6 gates (observatory spec v0.6 §7): the moonlight floor, capped
// eye-cast lights, the operator lighting override, the inscription history
// panel model, construction slack beside subsistence, and clientStatus
// driving the roster with no string parsing anywhere in the panel code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { createState } from "../src/source/reducer.js";
import { createLighting, lightingAt, minutesOf, effectiveSimTime, MOONLIGHT_FLOOR } from "../src/scene/lighting.js";
import { createAgents, pickEyeLights } from "../src/scene/agents.js";
import { inscriptionModel, inscribedStructures, authorTint } from "../src/panels/inscriptions.js";
import { viabilityModel } from "../src/panels/viability.js";
import { connectionLabel } from "../src/panels/roster.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// agents.js draws speech bubbles onto a canvas; headless tests need only a
// stand-in that satisfies the constructor path.
globalThis.document ??= {};
if (!globalThis.document.createElement) {
  globalThis.document.createElement = () => ({ width: 0, height: 0, getContext: () => null });
}

const mkAgent = (id, coord, extra = {}) => ({
  agentId: id, name: id, coord, prevCoord: coord, lifeStage: "adult", connectionState: "active",
  appearance: { bodyColor: "#5a6b5e", eyeColor: "#ff4400", scale: "medium", shell: "smooth", eyes: "pair" },
  vitality: 100, sustenance: 100, inventory: {}, memories: [], knownCells: new Map(), ...extra,
});

// ---------- 1. moonlight floor ----------

test("GATE moonlight floor: midnight never falls below the minimum ambient; night stays distinct, geometry readable", () => {
  const midnight = lightingAt(minutesOf("00:00"));
  assert.equal(midnight.night, true);
  assert.ok(midnight.fillIntensity >= MOONLIGHT_FLOOR, `ambient ${midnight.fillIntensity} holds the floor`);
  assert.ok(midnight.background > 0x101010, "the sky is not pure black — silhouettes have something to sit against");
  assert.ok(midnight.fillIntensity < lightingAt(minutesOf("12:00")).fillIntensity + 0.5, "night is still night, not daylight");

  // And applied: the scene's hemisphere light actually carries the floor,
  // blue-shifted against the day's neutral fill.
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 8);
  const nightState = lighting.update("02:00");
  assert.equal(nightState.night, true);
  assert.ok(lighting.fill.intensity >= MOONLIGHT_FLOOR, "the hemisphere fill holds the floor at 02:00");
  const hsl = {};
  lighting.fill.color.getHSL(hsl);
  assert.ok(hsl.h > 0.5 && hsl.h < 0.75, `night fill is blue-shifted (hue ${hsl.h.toFixed(2)})`);
  assert.ok(lighting.sun.intensity < 0.2, "the moon key stays dim — eyes still carry the frame");
});

// ---------- 2. eye lights ----------

test("GATE eye lights: point-light count scales with nearby agents and stays under the cap", () => {
  const scene = new THREE.Scene();
  const agents = createAgents(scene, 8, { eyeLightCap: 4 });
  const countLit = () => {
    let n = 0;
    scene.traverse((node) => node.isLight && node.name === "eye-light" && node.visible && n++);
    return n;
  };

  const state = { agents: new Map(), events: [], tick: 1 };
  state.agents.set("a_1", mkAgent("a_1", "0,0"));
  state.agents.set("a_2", mkAgent("a_2", "0,0"));
  agents.sync(state);
  agents.update(1000, 0.016, { x: 0, z: 0 });
  assert.equal(countLit(), 2, "two agents, two lights — a crowded cell is brighter than an empty one");

  for (let i = 3; i <= 9; i++) state.agents.set(`a_${i}`, mkAgent(`a_${i}`, `${i % 8},1`));
  agents.sync(state);
  agents.update(2000, 0.016, { x: 0, z: 0 });
  assert.equal(countLit(), 4, "nine agents, the cap holds at four");

  // Unmanned bodies have dark eyes and never hold a light.
  assert.deepEqual(
    pickEyeLights(
      [
        { id: "near", x: 0, z: 0, lit: true },
        { id: "dark", x: 0, z: 0, lit: false },
        { id: "far", x: 9, z: 9, lit: true },
      ],
      { x: 0, z: 0 },
      2
    ),
    ["near", "far"],
    "nearest lit agents chosen; unlit bodies skipped"
  );
});

// ---------- 3. lighting override ----------

test("GATE lighting override: holding at a fixed hour produces the same sun state regardless of sim time", () => {
  assert.equal(effectiveSimTime("02:00", "12:00"), "12:00");
  assert.equal(effectiveSimTime("02:00", "follow"), "02:00");
  assert.equal(effectiveSimTime("02:00", null), "02:00");

  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 8);
  const sunState = () => ({
    pos: lighting.sun.position.toArray().map((v) => v.toFixed(4)),
    intensity: lighting.sun.intensity,
    color: lighting.sun.color.getHexString(),
  });
  lighting.update("02:00", "12:00");
  const heldAtNight = sunState();
  lighting.update("14:30", "12:00");
  const heldInAfternoon = sunState();
  assert.deepEqual(heldAtNight, heldInAfternoon, "the held hour wins over any sim time");
  lighting.update("12:00", null);
  assert.deepEqual(sunState(), heldAtNight, "and equals genuinely being at that hour");
  lighting.update("02:00", null);
  assert.notEqual(sunState().intensity, heldAtNight.intensity, "releasing the override follows sim time again");
});

// ---------- 4. inscription history ----------

test("GATE inscription history: ten entries from three authors, in order, coloured by author, budget shown, exhaustion marked", () => {
  const state = createState();
  state.gridSize = 2;
  state.inscriptionMax = 200;
  const authors = ["Mara Flint", "Odd Wren", "Silas"];
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i + 1}`,
    authorId: `a_${i % 3}`,
    authorName: authors[i % 3],
    tick: i + 2,
    text: `entry ${i + 1}`,
  }));
  state.cells.set("0,0", {
    coord: "0,0",
    deposit: null,
    loose: null,
    corpses: [],
    fragment: null,
    structure: {
      form: "marker",
      authored: { name: "The Ledger", description: "d" },
      inscription: { entries, charactersUsed: 80 },
      demolishProgress: null,
      builtAtTick: 1,
      history: [],
    },
  });

  const m = inscriptionModel(state, "0,0");
  assert.equal(m.entries.length, 10, "every entry present");
  assert.deepEqual(m.entries.map((e) => e.text), entries.map((e) => `${e.text}`), "in append order");
  assert.deepEqual(m.entries.map((e) => e.tick), entries.map((e) => e.tick), "each with its tick");
  assert.equal(m.authors.length, 3, "three authors recognised");
  const tints = new Set(m.entries.map((e) => e.tint));
  assert.equal(tints.size, 3, "one colour per author — a multi-author wall is legible at a glance");
  assert.equal(m.entries[0].tint, authorTint("Mara Flint"), "colour is a stable function of the author");
  assert.equal(m.charactersUsed, 80);
  assert.equal(m.inscriptionMax, 200, "budget state shown against the permanent cap");
  assert.equal(m.charactersRemaining, 120);
  assert.equal(m.exhausted, false);

  // Exhaustion is marked: a full wall can never be written on again.
  state.cells.get("0,0").structure.inscription.charactersUsed = 200;
  const full = inscriptionModel(state, "0,0");
  assert.equal(full.exhausted, true, "a full wall is marked");
  assert.equal(full.charactersRemaining, 0);

  // The panel's own selector finds the wall.
  assert.deepEqual(inscribedStructures(state)[0], { coord: "0,0", name: "The Ledger", entries: 10 });
});

// ---------- 5. construction slack ----------

test("GATE construction slack renders beside the subsistence ratio, with expectedAgents beside slots", () => {
  const state = createState();
  state.viability = { ratio: 1.35, supply: 135, demand: 100, seededSivet: 60, sivetSprings: 3, regenSupply: 75, capacity: 4.2, optimalSurvivors: 5.1, slots: 12, expectedAgents: 5, maxTicks: 450 };
  state.constructionSlack = { slack: 0.62, buildDemand: 22.5, buildSupply: 18, travelFactor: 0.78, expectedAgents: 5 };
  state.agents.set("a_1", { agentId: "a_1", lifeStage: "adult" });

  const m = viabilityModel(state);
  assert.equal(m.ratio, 1.35, "subsistence still first");
  assert.equal(m.constructionSlack, 0.62, "slack beside it — viable and unable to build are different facts");
  assert.equal(m.expectedAgents, 5, "demand's population is named");
  assert.equal(m.slots, 12, "beside the slot count");
  assert.equal(m.slackDetail.travelFactor, 0.78, "the travel arithmetic rides along");

  // A pre-v0.6 record degrades gracefully.
  state.constructionSlack = null;
  assert.equal(viabilityModel(state).constructionSlack, null);
});

// ---------- 6. clientStatus drives the roster ----------

test("GATE clientStatus drives adapter_fault on the roster; no string parsing anywhere in the panel code", () => {
  const agent = (extra) => ({ agentId: "a_1", connectionState: "active", lastReason: null, lastActionType: null, ...extra });
  assert.equal(connectionLabel(agent({ clientStatus: "adapter_fault" })), "adapter_fault");
  assert.equal(connectionLabel(agent({ clientStatus: "ok" })), "active");
  assert.equal(connectionLabel(agent({ clientStatus: null })), "active");
  // The old implicit contract is dead: a reason string alone changes nothing.
  assert.equal(
    connectionLabel(agent({ lastReason: "adapter_fault: auth failure", lastActionType: "wait" })),
    "active",
    "reason strings no longer drive the roster"
  );

  // Grep the panel source: no reason-string parsing survives.
  const rosterSrc = readFileSync(join(srcDir, "panels", "roster.js"), "utf8");
  assert.ok(!rosterSrc.includes("lastReason"), "roster.js never touches lastReason");
  assert.ok(!/startsWith\(\s*["']adapter_fault/.test(rosterSrc), "no prefix parsing");
  assert.ok(!/adapter_fault: /.test(rosterSrc), "no reason-string format knowledge at all");
});
