// Cartographic fog (daemon spec §9 test 1, protocol §6.3): knowledge of a
// cell is a snapshot taken while standing in it. It goes stale and STAYS
// stale — a shared reference instead of a copy would silently defeat this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt, grant } from "./helpers.js";

const OBS_OPTS = { simTime: "10:00", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  resolveTick(world, n, "09:15", actions, roster);
}

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const move = (coord) => ({ action: { type: "move", coord, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const build = (name, description) => ({ action: { type: "build", coord: null, text: null, structure: { form: "marker", name, description }, intent: "", reason: "" }, assigned: false, coercedWait: false });

test("cartographic fog: a visited cell's snapshot stays stale after someone builds there", () => {
  const world = makeWorld();
  const ana = addAgentAt(world, "Ana", "1,1");
  const bo = grant(addAgentAt(world, "Bo", "1,2"), { orrum: 3 });

  // Tick 1: Ana leaves 1,1 (visited), Bo moves into it.
  tick(world, 1, new Map([[ana.id, move("1,0")], [bo.id, move("1,1")]]));
  assert.equal(ana.coord, "1,0");
  assert.equal(bo.coord, "1,1");

  // Tick 2: Bo builds in 1,1 after Ana has gone.
  tick(world, 2, new Map([[ana.id, wait()], [bo.id, build("STALE-SPIRE", "a tower Ana has never seen")]]));
  assert.equal(world.cells.get("1,1").structure.authored.name, "STALE-SPIRE");

  // Ana's known map still shows 1,1 as she last saw it: empty.
  const known = ana.knownCells.get("1,1");
  assert.equal(known.structureSnapshot, null, "snapshot not silently refreshed");

  // And her observation carries no trace of the new structure.
  writePerceptions(world, 3, "09:45");
  const obs = buildObservation(world, ana.id, 3, OBS_OPTS);
  const knownEntry = obs.knownCells.find((k) => k.coord === "1,1");
  assert.equal(knownEntry.structure, null, "observation shows the stale snapshot");
  assert.ok(!JSON.stringify(obs).includes("STALE-SPIRE"), "no trace of the unseen structure");
});

test("knownCells contains only visited cells, and revisiting refreshes the snapshot", () => {
  const world = makeWorld();
  const ana = addAgentAt(world, "Ana", "1,1");
  const bo = grant(addAgentAt(world, "Bo", "1,2"), { orrum: 3 });

  tick(world, 1, new Map([[ana.id, move("1,0")], [bo.id, move("1,1")]]));
  tick(world, 2, new Map([[ana.id, wait()], [bo.id, build("STALE-SPIRE", "now you see it")]]));

  writePerceptions(world, 3, "09:45");
  const before = buildObservation(world, ana.id, 3, OBS_OPTS);
  assert.deepEqual(before.knownCells.map((k) => k.coord).sort(), ["1,0", "1,1"], "exactly the visited cells");

  // Ana walks back into 1,1: the snapshot refreshes on arrival.
  tick(world, 3, new Map([[ana.id, move("1,1")], [bo.id, wait()]]));
  writePerceptions(world, 4, "10:00");
  const after = buildObservation(world, ana.id, 4, OBS_OPTS);
  const revisited = after.knownCells.find((k) => k.coord === "1,1");
  assert.equal(revisited.structure.authored.name, "STALE-SPIRE", "revisit sees the truth");
  assert.equal(revisited.lastSeenTick, 3, "snapshot stamped at the arrival tick's RESOLVED");
});

test("the snapshot is a deep copy: mutating the live cell cannot reach a stale snapshot", () => {
  const world = makeWorld();
  const ana = addAgentAt(world, "Ana", "1,1");
  const bo = grant(addAgentAt(world, "Bo", "1,1"), { orrum: 3 });

  // Both present while Bo builds: both snapshots capture the structure.
  tick(world, 1, new Map([[ana.id, wait()], [bo.id, build("SHARED-HALL", "seen by both")]]));
  // Ana leaves.
  tick(world, 2, new Map([[ana.id, move("1,0")], [bo.id, wait()]]));

  // Simulate a future world where the structure's text changed in place
  // (e.g. a v0.3 `modify`): the stale snapshot must not follow.
  world.cells.get("1,1").structure.authored.name = "RENAMED-HALL";
  assert.equal(ana.knownCells.get("1,1").structureSnapshot.authored.name, "SHARED-HALL");
});

test("an agent standing in a cell while someone builds there knows it (snapshot covers presence, not just arrival)", () => {
  const world = makeWorld();
  const ana = addAgentAt(world, "Ana", "1,1");
  const bo = grant(addAgentAt(world, "Bo", "1,1"), { orrum: 3 });

  tick(world, 1, new Map([[ana.id, wait()], [bo.id, build("WITNESSED", "built in company")]]));
  assert.equal(ana.knownCells.get("1,1").structureSnapshot.authored.name, "WITNESSED");
});
