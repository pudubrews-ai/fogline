// The fog boundary test required by daemon spec §7 and protocol §15.
// Carried forward from v0: the scenario changes from two rooms to two cells;
// the assertions do not. Agents in separate cells; speech resolves in one;
// the other's observation AND memory stream must contain no trace of it.
// This test predates the tick engine, the API, and the observatory, and must
// stay green forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const SPOKEN = "The seal is hidden under the floorboards";

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };

// Rune at 0,0 and Devi at 3,3 — maximally apart on a 4x4 grid.
function freshWorld() {
  const world = makeWorld();
  const rune = addAgentAt(world, "Rune", "0,0", {
    identity: "You are a tinkerer.",
    privateObjective: "SECRET-RUNE-OBJECTIVE orrery",
    discoverable: "RUNE-DISCOVERABLE you collect gears",
  });
  const devi = addAgentAt(world, "Devi", "3,3", {
    identity: "You are a reader.",
    privateObjective: "SECRET-DEVI-OBJECTIVE gears",
    discoverable: "DEVI-DISCOVERABLE you memorize maps",
  });
  return { world, rune, devi };
}

function runTickWithSpeech() {
  const { world, rune, devi } = freshWorld();

  // Tick 1 OPEN: perceptions, roster snapshot.
  writePerceptions(world, 1, "09:15");
  const roster = captureRoster(world);

  // Rune speaks in its cell; Devi (alone in a far cell) misses the tick.
  const actions = new Map([
    [rune.id, {
      action: { type: "say", text: SPOKEN, intent: "telling the cell my secret", reason: "PRIVATE-RUNE-REASON testing" },
      assigned: false, coercedWait: false,
    }],
    [devi.id, { action: { type: "wait", coord: null, text: null, structure: null }, assigned: true }],
  ]);
  resolveTick(world, 1, "09:15", actions, roster);
  return { world, rune, devi };
}

test("fog: speech in one cell leaves no trace in the other agent's memory stream", () => {
  const { world, rune, devi } = runTickWithSpeech();

  const speechEntries = devi.memories.filter((m) => m.type === "speech");
  assert.equal(speechEntries.length, 0, "Devi has no speech memory at all");
  const streamDump = JSON.stringify(devi.memories);
  assert.ok(!streamDump.includes("seal"), "no fragment of the utterance in Devi's stream");
  assert.ok(!streamDump.includes("floorboards"), "no fragment of the utterance in Devi's stream");

  // Positive control: the speaker remembers saying it.
  const runeSpeech = rune.memories.filter((m) => m.type === "speech");
  assert.equal(runeSpeech.length, 1);
  assert.equal(runeSpeech[0].text, SPOKEN);
});

test("fog: the other agent's next observation contains no trace of the speech", () => {
  const { world, rune, devi } = runTickWithSpeech();

  // Tick 2 OPEN for Devi.
  writePerceptions(world, 2, "09:30");
  const obs = buildObservation(world, devi.id, 2, OBS_OPTS);

  assert.deepEqual(obs.heard, [], "heard is empty");
  assert.deepEqual(obs.present, [], "Devi is alone");
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("seal") && !dump.includes("floorboards"), "no fragment of the utterance anywhere in the observation");
  assert.ok(!dump.includes("SECRET-RUNE-OBJECTIVE"), "no other agent's privateObjective");
  assert.ok(!dump.includes("PRIVATE-RUNE-REASON"), "no other agent's reason");
  assert.ok(!dump.includes("Rune"), "no positional information about an agent in another cell");
});

test("fog: an agent present in the cell does hear it, on the next tick, even after leaving", () => {
  const { world, rune, devi } = freshWorld();
  devi.coord = "0,0"; // start co-located instead
  devi.knownCells.clear();
  devi.knownCells.set("0,0", { structureSnapshot: null, lastSeenTick: 0 });
  writePerceptions(world, 1, "09:15");
  const roster = captureRoster(world);

  // Speech before movement: Devi walks out the same tick and still hears it.
  const actions = new Map([
    [rune.id, { action: { type: "say", text: SPOKEN, intent: "", reason: "" }, assigned: false, coercedWait: false }],
    [devi.id, { action: { type: "move", coord: "1,0", text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false }],
  ]);
  resolveTick(world, 1, "09:15", actions, roster);

  assert.equal(devi.coord, "1,0", "the move succeeded");
  writePerceptions(world, 2, "09:30");
  const obs = buildObservation(world, devi.id, 2, OBS_OPTS);
  assert.equal(obs.heard.length, 1);
  assert.equal(obs.heard[0].speakerId, rune.id);
  assert.equal(obs.heard[0].authored.text, SPOKEN);
});

test("fog: own observation never contains another agent's private tiers, in any field", () => {
  const { world, rune, devi } = runTickWithSpeech();
  writePerceptions(world, 2, "09:30");
  const runeObs = buildObservation(world, rune.id, 2, OBS_OPTS);
  assert.equal(runeObs.self.authored.privateObjective, "SECRET-RUNE-OBJECTIVE orrery", "own objective present");
  const dump = JSON.stringify(runeObs);
  assert.ok(!dump.includes("SECRET-DEVI-OBJECTIVE"));
  assert.ok(!dump.includes("DEVI-DISCOVERABLE"));
});

test("persona fog: a co-located agent's observation carries the observable tier only", () => {
  const { world, rune, devi } = freshWorld();
  devi.coord = "0,0"; // co-located
  devi.knownCells.clear();
  devi.knownCells.set("0,0", { structureSnapshot: null, lastSeenTick: 0 });
  writePerceptions(world, 1, "09:15");

  const obs = buildObservation(world, rune.id, 1, OBS_OPTS);
  assert.equal(obs.present.length, 1);
  const seen = obs.present[0];
  assert.equal(seen.agentId, devi.id);
  assert.deepEqual(Object.keys(seen.authored).sort(), ["appearance", "disposition", "name"]);

  // String-scan the full observation JSON for any fragment of Devi's hidden
  // tiers (daemon spec §9 test 2). Zero hits.
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("SECRET-DEVI-OBJECTIVE"), "no privateObjective fragment");
  assert.ok(!dump.includes("DEVI-DISCOVERABLE"), "no discoverable fragment");
  assert.ok(!dump.includes("You are a reader"), "no identity fragment");
});

test("fog: exits list coordinates only — never contents, occupancy, or emptiness", () => {
  const { world, rune, devi } = freshWorld();
  // Devi builds a structure right next to Rune; Rune has never stood there.
  devi.coord = "1,0";
  world.cells.get("1,0").structure = {
    authored: { name: "HIDDEN-TOWER", description: "unseen from one cell over" },
    history: [{ agentId: devi.id, tick: 1, action: "build" }],
  };
  writePerceptions(world, 1, "09:15");
  const obs = buildObservation(world, rune.id, 1, OBS_OPTS);
  for (const exit of obs.cell.exits) {
    assert.deepEqual(Object.keys(exit).sort(), ["coord", "direction"]);
  }
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("HIDDEN-TOWER"), "adjacent structure invisible");
  assert.ok(!dump.includes("Devi"), "adjacent occupancy invisible");
});
