// Gather, drop, give, consume: carry limits, contested splits, and the
// upkeep ordering that lets an agent eat on the tick it would starve
// (daemon spec §2.3, §14 tests 13 and 14; protocol §5.3, §9.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions, IMPORTANCE } from "../world/memory.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { validateAction } from "../engine/tick.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const mk = (type, extra = {}) => ({ action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: "", reason: "", ...extra }, assigned: false, coercedWait: false });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

test("gather: takes from a deposit up to the carry limit and reports the actual amount", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Miner", "1,1");
  a.inventory.sivet = 8; // 4 units of headroom against carryLimit 12
  world.cells.get("1,1").deposit = { resource: "orrum", quantity: 10, capacity: 10, regenAccum: 0 };

  tick(world, 1, new Map([[a.id, mk("gather")]]));
  assert.equal(a.inventory.orrum, 4, "clamped to the carry limit");
  assert.equal(world.cells.get("1,1").deposit.quantity, 6, "only what fits was taken");
  assert.deepEqual(a.lastActionOutcome, { type: "gather", result: "ok", why: "took 4 orrum" });
});

test("contested gather: even split, remainder to the lowest agentId", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "One", "1,1");
  const b = addAgentAt(world, "Two", "1,1");
  const c = addAgentAt(world, "Three", "1,1");
  world.cells.get("1,1").deposit = { resource: "khal", quantity: 8, capacity: 8, regenAccum: 0 };

  tick(world, 1, new Map([[a.id, mk("gather")], [b.id, mk("gather")], [c.id, mk("gather")]]));

  const lowest = [a, b, c].sort((x, y) => (x.id < y.id ? -1 : 1))[0];
  for (const g of [a, b, c]) {
    assert.equal(g.inventory.khal, g === lowest ? 4 : 2, `${g.persona.name}: share ${g === lowest ? "with" : "without"} remainder`);
  }
  assert.equal(world.cells.get("1,1").deposit.quantity, 0, "deposit emptied exactly");
});

test("gather falls back to loose piles and empties them; a corpse in the cell is untouched", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Scav", "2,2");
  const cell = world.cells.get("2,2");
  cell.loose = { sivet: 2, orrum: 1, khal: 0 };
  cell.corpses.push({ authored: { name: "Old" }, appearance: {}, diedAtTick: 1, causeAgentId: null });

  tick(world, 1, new Map([[a.id, mk("gather")]]));
  assert.deepEqual(a.inventory, { sivet: 2, orrum: 1, khal: 0, rubble: 0 });
  assert.equal(cell.loose, null, "emptied loose pile is removed");
  assert.equal(cell.corpses.length, 1, "corpses are not resources and are never gatherable");
});

test("gather with nothing present, or with a full pack, fails informatively", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Empty", "0,0");
  tick(world, 1, new Map([[a.id, mk("gather")]]));
  assert.equal(a.lastActionOutcome.why, "nothing here to gather");

  const full = addAgentAt(world, "Full", "1,1");
  full.inventory.orrum = 12;
  world.cells.get("1,1").deposit = { resource: "khal", quantity: 5, capacity: 5, regenAccum: 0 };
  tick(world, 2, new Map([[full.id, mk("gather")]]));
  assert.equal(full.lastActionOutcome.why, "you cannot carry more");
  assert.equal(world.cells.get("1,1").deposit.quantity, 5);
});

test("drop: places a loose pile; give: unilateral transfer with recipient memory and both clamps", () => {
  const world = makeWorld();
  const giver = addAgentAt(world, "Giver", "1,1");
  const taker = addAgentAt(world, "Taker", "1,1");
  giver.inventory.sivet = 5;
  taker.inventory.orrum = 11; // capacity 1

  // v0.4: give is ALL-OR-NOTHING (protocol §10.3). Three sivet cannot fit in
  // one free unit of capacity, so nothing moves — and the failure says only
  // that the gift did not transfer.
  tick(world, 1, new Map([
    [giver.id, mk("give", { target: taker.id, resources: { sivet: 3 } })],
    [taker.id, wait()],
  ]));
  assert.equal(taker.inventory.sivet, 0, "nothing transfers when the full amount does not fit");
  assert.equal(giver.inventory.sivet, 5, "giver keeps everything");
  assert.equal(giver.lastActionOutcome.why, "the gift did not transfer");
  assert.ok(!taker.memories.some((m) => m.importance === IMPORTANCE.GIFT_RECEIVED));

  // A gift that fits transfers in full, with the recipient memory.
  tick(world, 2, new Map([
    [giver.id, mk("give", { target: taker.id, resources: { sivet: 1 } })],
    [taker.id, wait()],
  ]));
  assert.equal(taker.inventory.sivet, 1);
  assert.equal(giver.inventory.sivet, 4);
  assert.match(giver.lastActionOutcome.why, /gave 1 sivet to Taker/);
  assert.ok(taker.memories.some((m) => m.importance === IMPORTANCE.GIFT_RECEIVED && m.text === "Giver gave you 1 sivet."));

  tick(world, 3, new Map([[giver.id, mk("drop", { resources: { sivet: 2 } })], [taker.id, wait()]]));
  assert.deepEqual(world.cells.get("1,1").loose, { sivet: 2, orrum: 0, khal: 0, rubble: 0 });
  assert.equal(giver.inventory.sivet, 2);
});

test("give to an absent agent fails; drop of what you lack fails", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Alone", "0,0");
  const far = addAgentAt(world, "Far", "3,3");
  a.inventory.khal = 1;
  tick(world, 1, new Map([[a.id, mk("give", { target: far.id, resources: { khal: 1 } })], [far.id, wait()]]));
  assert.deepEqual(a.lastActionOutcome, { type: "give", result: "failed", why: "no such agent here", attempts: 1 });
  assert.equal(a.inventory.khal, 1);

  tick(world, 2, new Map([[a.id, mk("drop", { resources: { orrum: 2 } })], [far.id, wait()]]));
  assert.deepEqual(a.lastActionOutcome, { type: "drop", result: "failed", why: "nothing to drop", attempts: 1 });
});

test("upkeep ordering: an agent at 1 sustenance that consumes sivet this tick does not starve", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Hungry", "0,0");
  a.sustenance = 1;
  a.inventory.sivet = 1;

  tick(world, 1, new Map([[a.id, mk("consume", { resource: "sivet" })]]));
  assert.equal(a.sustenance, 25, "ate to 26, then decayed 1 at upkeep");
  assert.equal(a.vitality, 100, "no starvation damage on the tick it ate");
  assert.equal(a.inventory.sivet, 0);
  // v0.7 A1 superseded the old silent outcome: every consume now reports
  // what it restored.
  assert.deepEqual(a.lastActionOutcome, { type: "consume", result: "ok", why: "consumed 1 sivet; it restored 25 sustenance" });
});

test("consuming a non-restorative resource is allowed, spends the unit, and reports nil restoration (v0.7 A1)", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Curious", "0,0");
  a.inventory.orrum = 2;
  a.sustenance = 50;
  tick(world, 1, new Map([[a.id, mk("consume", { resource: "orrum" })]]));
  assert.equal(a.inventory.orrum, 1);
  assert.equal(a.sustenance, 49, "no restoration — just the tick's decay");
  assert.deepEqual(a.lastActionOutcome, { type: "consume", result: "ok", why: "consumed 1 orrum; it restored nothing" });
});

test("structural validation of the inventory actions", () => {
  const base = { protocol: "0.3", intent: "", reason: "" };
  assert.ok(validateAction({ ...base, type: "give", target: "a_1", resources: { sivet: 1 } }).action);
  assert.ok(validateAction({ ...base, type: "give", resources: { sivet: 1 } }).error, "give needs a target");
  assert.ok(validateAction({ ...base, type: "give", target: "a_1", resources: {} }).error, "empty map");
  assert.ok(validateAction({ ...base, type: "give", target: "a_1", resources: { gold: 1 } }).error, "unknown resource");
  assert.ok(validateAction({ ...base, type: "give", target: "a_1", resources: { sivet: -2 } }).error, "negative");
  assert.ok(validateAction({ ...base, type: "drop", resources: { khal: 2 } }).action);
  assert.ok(validateAction({ ...base, type: "consume", resource: "sivet" }).action);
  assert.ok(validateAction({ ...base, type: "consume", resource: "stone" }).error);
  assert.ok(validateAction({ ...base, type: "gather" }).action);
  assert.ok(validateAction({ ...base, type: "gather", resources: { sivet: 1 } }).error, "gather takes no arguments");
});
