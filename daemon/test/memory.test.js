import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPORTANCE, addMemory, retrieve, scoreMemory, tokenize, writePerceptions } from "../world/memory.js";
import { makeWorld, addAgentAt } from "./helpers.js";

function freshWorld() {
  const world = makeWorld();
  const rune = addAgentAt(world, "Rune", "1,1");
  const devi = addAgentAt(world, "Devi", "1,1");
  return { world, rune, devi };
}

test("perception writes on change, not on state (dedupe)", () => {
  const { world, rune } = freshWorld();
  writePerceptions(world, 1, "09:15");
  const afterFirst = rune.memories.length;
  assert.equal(afterFirst, 2); // "You are at 1,1." + "Devi is here."
  for (let t = 2; t <= 10; t++) writePerceptions(world, t, "09:30");
  assert.equal(rune.memories.length, afterFirst, "no new perception memories when nothing changed");
});

test("perception records arrivals, departures, and own moves with table importance", () => {
  const { world, rune, devi } = freshWorld();
  writePerceptions(world, 1, "09:15");

  devi.coord = "1,2"; // devi moved during tick 1 resolution
  writePerceptions(world, 2, "09:30");
  const runeLast = rune.memories.at(-1);
  assert.equal(runeLast.text, "Devi left.");
  assert.equal(runeLast.importance, IMPORTANCE.PRESENCE_CHANGE);
  const deviLast = devi.memories.at(-1);
  assert.equal(deviLast.text, "You moved to 1,2.");
  assert.equal(deviLast.importance, IMPORTANCE.CELL_CHANGE);

  devi.coord = "1,1";
  writePerceptions(world, 3, "09:45");
  assert.equal(rune.memories.at(-1).text, "Devi arrived.");
  assert.equal(devi.memories.at(-1).text, "Rune is here.");
});

test("retrieval scores recency + importance + keyword relevance and bumps lastAccessedTick", () => {
  const { world, rune } = freshWorld();
  addMemory(world, rune, { tick: 1, simTime: "09:15", type: "observation", text: "You are at 1,1.", importance: 2 });
  const gears = addMemory(world, rune, { tick: 2, simTime: "09:30", type: "speech", text: "The brass gears are missing from the drawer", importance: 5, speaker: "a_devi", speakerName: "Devi" });
  addMemory(world, rune, { tick: 3, simTime: "09:45", type: "reflection", text: "I should tidy the bench", importance: 7 });

  const top = retrieve(rune, "find the brass gears drawer", 20, 2);
  assert.equal(top[0].id, gears.id, "keyword-relevant memory wins despite lower importance");
  assert.equal(gears.lastAccessedTick, 20, "lastAccessedTick updated on retrieval");

  // Recency component: same entry re-scored after access bump is fresher.
  const q = tokenize("brass gears");
  const fresh = scoreMemory(gears, q, 20);
  gears.lastAccessedTick = 2;
  const stale = scoreMemory(gears, q, 20);
  assert.ok(fresh > stale);
});

test("retrieve returns at most k and honors exclusions", () => {
  const { world, rune } = freshWorld();
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push(addMemory(world, rune, { tick: i, simTime: "09:00", type: "observation", text: `event number ${i}`, importance: 2 }));
  }
  const top = retrieve(rune, "", 10, 5);
  assert.equal(top.length, 5);
  const excluded = new Set(entries.map((e) => e.id));
  assert.equal(retrieve(rune, "", 10, 5, { excludeIds: excluded }).length, 0);
});

test("addMemory accrues importanceSinceLastReflection", () => {
  const { world, rune } = freshWorld();
  const before = rune.importanceSinceLastReflection;
  addMemory(world, rune, { tick: 1, simTime: "09:15", type: "speech", text: "hi", importance: 5, speaker: "a_devi", speakerName: "Devi" });
  addMemory(world, rune, { tick: 1, simTime: "09:15", type: "reflection", text: "hm", importance: 7 });
  assert.equal(rune.importanceSinceLastReflection - before, 12);
});
