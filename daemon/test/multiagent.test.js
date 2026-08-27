// Multi-agent fog coverage, carried forward from v0 and adapted from the
// 5-room seed to a 4x4 grid: speech in one cell leaves no trace in any other
// occupied cell, checked per non-present agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const SPOKEN = "The plum tree hides a XYLOGRAPH nobody has seen";
const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 12 };

// Six agents: Sable and Lux share 1,1; the other four are spread out alone.
function freshWorld() {
  const world = makeWorld({ gridSize: 4, slots: 6 });
  const agents = {
    sable: addAgentAt(world, "Sable", "1,1"),
    lux: addAgentAt(world, "Lux", "1,1"),
    rune: addAgentAt(world, "Rune", "0,0"),
    devi: addAgentAt(world, "Devi", "3,0"),
    pip: addAgentAt(world, "Pip", "0,3"),
    orin: addAgentAt(world, "Orin", "3,3"),
  };
  return { world, agents };
}

test("six agents on a 4x4 grid: slots consumed, positions held", () => {
  const { world } = freshWorld();
  assert.equal(world.agents.size, 6);
  assert.equal(world.slots.used, 6);
  assert.deepEqual(
    [...world.agents.values()].map((b) => b.coord).sort(),
    ["0,0", "0,3", "1,1", "1,1", "3,0", "3,3"]
  );
});

test("fog at N=6: speech reaches both cell occupants and nobody anywhere else", () => {
  const { world, agents } = freshWorld();
  writePerceptions(world, 1, "09:15");
  const roster = captureRoster(world);

  const actions = new Map([
    [agents.sable.id, { action: { type: "say", text: SPOKEN, intent: "stirring", reason: "test" }, assigned: false, coercedWait: false }],
  ]);
  for (const key of ["rune", "devi", "pip", "orin", "lux"]) {
    actions.set(agents[key].id, { action: { type: "wait", coord: null, text: null, structure: null }, assigned: true });
  }
  resolveTick(world, 1, "09:15", actions, roster);
  writePerceptions(world, 2, "09:30");

  // Co-present: lux hears it, sable remembers saying it.
  for (const hearer of [agents.sable, agents.lux]) {
    const obs = buildObservation(world, hearer.id, 2, OBS_OPTS);
    assert.equal(obs.heard.length, 1, `${hearer.persona.name} heard it`);
    assert.equal(obs.heard[0].speakerId, agents.sable.id);
  }

  // Everyone else: no trace, in observation or memory stream.
  for (const key of ["rune", "devi", "pip", "orin"]) {
    const body = agents[key];
    assert.equal(body.memories.filter((m) => m.type === "speech").length, 0, `${key} has no speech memory`);
    const obs = buildObservation(world, body.id, 2, OBS_OPTS);
    assert.deepEqual(obs.heard, []);
    assert.ok(!JSON.stringify(obs).includes("XYLOGRAPH"), `${key}'s observation has no fragment of it`);
  }
});

test("fog at N=6: present lists are per-cell and exclude self; no cross-cell positions leak", () => {
  const { world, agents } = freshWorld();
  writePerceptions(world, 1, "09:15");
  const sable = buildObservation(world, agents.sable.id, 1, OBS_OPTS);
  assert.equal(sable.present.length, 1);
  assert.equal(sable.present[0].agentId, agents.lux.id);
  assert.equal(sable.present[0].authored.name, "Lux");

  const pip = buildObservation(world, agents.pip.id, 1, OBS_OPTS);
  assert.deepEqual(pip.present, [], "pip is alone");
  const dump = JSON.stringify(pip);
  for (const name of ["Rune", "Devi", "Sable", "Orin", "Lux"]) {
    assert.ok(!dump.includes(name), `pip's observation says nothing about ${name}'s position`);
  }
});

test("simultaneous speech in separate cells stays separate", () => {
  const { world, agents } = freshWorld();
  writePerceptions(world, 1, "09:15");
  const roster = captureRoster(world);
  const actions = new Map([
    [agents.sable.id, { action: { type: "say", text: "cell-only KETTLETALK", intent: "", reason: "" }, assigned: false, coercedWait: false }],
    [agents.orin.id, { action: { type: "say", text: "corner-only PLUMWATCH", intent: "", reason: "" }, assigned: false, coercedWait: false }],
  ]);
  for (const key of ["rune", "devi", "pip", "lux"]) {
    actions.set(agents[key].id, { action: { type: "wait", coord: null, text: null, structure: null }, assigned: true });
  }
  resolveTick(world, 1, "09:15", actions, roster);

  const luxStream = JSON.stringify(agents.lux.memories);
  assert.ok(luxStream.includes("KETTLETALK") && !luxStream.includes("PLUMWATCH"));
  const orinStream = JSON.stringify(agents.orin.memories);
  assert.ok(orinStream.includes("PLUMWATCH") && !orinStream.includes("KETTLETALK"), "orin alone hears only himself");
});
