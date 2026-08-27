// situationChanged (protocol §12, daemon spec §10, §14 test 12). The FALSE
// case is the one that matters: wrong in the true direction, this flag
// silently burns model calls and every test that only checks true cases
// stays green. So: an agent alone in empty cells, travelling toward a stated
// destination, five ticks, false every time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { computeSituations } from "../world/situation.js";
import { makeWorld, addAgentAt, grant } from "./helpers.js";

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };
const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const mk = (type, extra = {}) => ({ action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: "", reason: "", ...extra }, assigned: false, coercedWait: false });

// One full cycle as the engine runs it: perceptions, situation diff, resolve.
function cycle(world, n, actions = new Map()) {
  writePerceptions(world, n, "09:15");
  const situations = computeSituations(world, n);
  resolveTick(world, n, "09:15", actions, captureRoster(world));
  return situations;
}

test("FALSE case: alone, empty cells, travelling toward a stated destination — false five ticks running", () => {
  const world = makeWorld(); // no deposits, no structures: genuinely empty ground
  const walker = addAgentAt(world, "Walker", "0,0");
  walker.currentIntent = "walking to 3,3";

  // Tick 1 is the first observation ever: true, and not what we are testing.
  const first = cycle(world, 1, new Map([[walker.id, mk("move", { coord: "1,0" })]]));
  assert.equal(first.get(walker.id).situationChanged, true, "the very first observation is a change");

  const path = ["2,0", "3,0", "3,1", "3,2", "3,3"];
  for (let i = 0; i < path.length; i++) {
    const situations = cycle(world, 2 + i, new Map([[walker.id, mk("move", { coord: path[i] })]]));
    assert.equal(
      situations.get(walker.id).situationChanged,
      false,
      `tick ${2 + i}: mid-journey, alone, empty cell — a model call here is money burnt`
    );
  }
  assert.equal(walker.coord, "3,3", "the journey actually happened");
});

test("FALSE case survives the observation builder: the payload carries false verbatim", () => {
  const world = makeWorld();
  const walker = addAgentAt(world, "Walker", "0,0");
  cycle(world, 1, new Map([[walker.id, mk("move", { coord: "1,0" })]]));
  writePerceptions(world, 2, "09:30");
  const situations = computeSituations(world, 2);
  const obs = buildObservation(world, walker.id, 2, { ...OBS_OPTS, situation: situations.get(walker.id) });
  assert.equal(obs.situationChanged, false);
});

test("arrival with something to see IS a change: deposits, corpses, structures wake the traveller", () => {
  const world = makeWorld();
  const walker = addAgentAt(world, "Walker", "0,0");
  world.cells.get("2,0").deposit = { resource: "orrum", quantity: 5, capacity: 5, regenAccum: 0 };
  cycle(world, 1, new Map([[walker.id, mk("move", { coord: "1,0" })]]));
  const quiet = cycle(world, 2, new Map([[walker.id, mk("move", { coord: "2,0" })]]));
  assert.equal(quiet.get(walker.id).situationChanged, false, "empty 1,0 was quiet");
  const arrived = cycle(world, 3, new Map([[walker.id, wait()]]));
  assert.equal(arrived.get(walker.id).situationChanged, true, "a deposit is news");
});

test("true triggers: presence change, speech heard, failed outcome, band change, attack in cell, first read", () => {
  const world = makeWorld({ slots: 4 });
  const a = addAgentAt(world, "Ada", "1,1");
  const b = addAgentAt(world, "Brim", "1,2");
  cycle(world, 1, new Map([[a.id, wait()], [b.id, wait()]])); // baselines

  // Presence: Brim walks in; next OPEN, Ada's set changed.
  cycle(world, 2, new Map([[a.id, wait()], [b.id, mk("move", { coord: "1,1" })]]));
  let s = cycle(world, 3, new Map([[a.id, wait()], [b.id, mk("say", { text: "hello there" })]]));
  assert.equal(s.get(a.id).situationChanged, true, "present-set changed");

  // Speech heard last tick.
  s = cycle(world, 4, new Map([[a.id, wait()], [b.id, wait()]]));
  assert.equal(s.get(a.id).situationChanged, true, "speech was heard");

  // Static co-located tick: back to false for both.
  s = cycle(world, 5, new Map([[a.id, wait()], [b.id, wait()]]));
  assert.equal(s.get(a.id).situationChanged, false, "nothing new between them");
  assert.equal(s.get(b.id).situationChanged, false);

  // Failed outcome (gather on nothing) trips the next tick.
  cycle(world, 6, new Map([[a.id, mk("gather")], [b.id, wait()]]));
  s = cycle(world, 7, new Map([[a.id, wait()], [b.id, wait()]]));
  assert.equal(s.get(a.id).situationChanged, true, "lastActionOutcome.result === failed");
  assert.equal(s.get(b.id).situationChanged, false, "the neighbour's failure is not my news");

  // Attack in the cell: both fighter and witness wake.
  cycle(world, 8, new Map([[a.id, mk("attack", { target: b.id })], [b.id, wait()]]));
  s = cycle(world, 9, new Map([[a.id, wait()], [b.id, wait()]]));
  assert.equal(s.get(a.id).situationChanged, true, "attack occurred in the cell");
  assert.equal(s.get(b.id).situationChanged, true, "the target certainly noticed — and the band moved");

  // Band change without violence: creeping hunger crosses fed -> hungry.
  const c = addAgentAt(world, "Crow", "3,3");
  cycle(world, 10, new Map([[c.id, wait()]]));
  c.sustenance = 61; // one decay from the boundary
  cycle(world, 11, new Map([[c.id, wait()]])); // upkeep: 61 -> 60, hungry
  s = cycle(world, 12, new Map([[c.id, wait()]]));
  assert.equal(s.get(c.id).situationChanged, true, "sustenanceBand crossed");

  // First inscription read; re-reads stay quiet.
  const d = grant(addAgentAt(world, "Dee", "0,3"), { orrum: 1 });
  cycle(world, 13, new Map([[d.id, mk("build", { structure: { form: "marker", name: "Stone", description: "d" } })]]));
  cycle(world, 14, new Map([[d.id, mk("inscribe", { text: "the first law" })]]));
  const e = addAgentAt(world, "Eft", "0,2");
  cycle(world, 15, new Map([[d.id, wait()], [e.id, mk("move", { coord: "0,3" })]]));
  s = cycle(world, 16, new Map([[d.id, wait()], [e.id, wait()]]));
  assert.equal(s.get(e.id).situationChanged, true, "first reading of an inscription (and an arrival with news)");
  s = cycle(world, 17, new Map([[d.id, wait()], [e.id, wait()]]));
  s = cycle(world, 18, new Map([[d.id, wait()], [e.id, wait()]]));
  assert.equal(s.get(e.id).situationChanged, false, "re-reading the same text is not news");
});

test("attentionBudget: changed situations granted first, then the longest-ungranted; ceiling respected", () => {
  const world = makeWorld({ slots: 6 });
  const bodies = [];
  for (let i = 0; i < 5; i++) bodies.push(addAgentAt(world, `Agent${i}`, `${i % 4},${Math.floor(i / 4)}`));
  writePerceptions(world, 1, "09:15");
  const s1 = computeSituations(world, 1, { attentionBudget: 2 });
  const grantedCount = [...s1.values()].filter((v) => v.attentionGranted).length;
  assert.equal(grantedCount, 2, "ceiling respected even when everything changed");
  writePerceptions(world, 2, "09:30");
  const s2 = computeSituations(world, 2, { attentionBudget: 2 });
  for (const [id, v] of s2) {
    assert.equal(typeof v.attentionGranted, "boolean", `${id} carries a grant decision`);
  }
  const grantedTicks = new Set([...world.agents.values()].map((b) => b.lastAttentionTick));
  assert.ok(grantedTicks.has(2), "later ticks grant the previously starved");
});
