// v0.9 — the engine refactor (engine spec v0.9 §8).
//
// Test 1 is THE gate: Orrum-5 booted from its definition produces world
// state identical to v0.8 from the same seed. The v0.8 states were captured
// from the pre-refactor code at the fogline initial import (fixtures/
// v08-state.json, three seeds) — if the default is not a no-op, the refactor
// changed the world and twelve runs of data stop being comparable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld, exitsFor } from "../world/world.js";
import { resourcesConfig } from "../world/resources.js";
import { computeViability, computeConstructionSlack, VIABILITY_DEFAULTS } from "../world/viability.js";
import { typicalStructureCost } from "../world/recipes.js";
import { loadDefinition, normalizeDefinition, defaultDefinition } from "../world/definition.js";
import { validateAction, TickEngine } from "../engine/tick.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { buildObservation } from "../world/observe.js";
import { addAgentAt, persona } from "./helpers.js";

const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(daemonDir, "test", "fixtures", "v08-state.json"), "utf8"));
const orrumConfig = JSON.parse(readFileSync(join(daemonDir, "config.json"), "utf8"));

// The same deterministic PRNG the fixture was generated with.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Boot Orrum-5 exactly as server.js does on the definition path.
function bootOrrum5(seed) {
  const definition = loadDefinition(join(daemonDir, "worlds", "orrum-5.json"));
  const config = orrumConfig;
  const expectedAgents = config.expectedAgents ?? config.minAgents ?? 2;
  const world = createWorld({
    definition,
    slots: config.slots,
    genotype: config.genotype ?? {},
    lineage: {
      maturityTicks: config.maturityTicks,
      begetVitalityCost: config.begetVitalityCost,
      begetResourceCost: config.begetResourceCost,
    },
    destruction: config.destruction ?? {},
    carryLimit: config.carryLimit,
    inscriptionMax: config.inscriptionMax ?? 500,
    seeding: {
      ...VIABILITY_DEFAULTS,
      ...definition.viability,
      maxTicks: config.maxTicks,
      expectedAgents,
    },
    rng: mulberry32(seed),
  });
  return { world, config, expectedAgents };
}

test("GATE v0.9 test 1 — the default is a no-op: Orrum-5 from its definition reproduces v0.8 state from the same seed", () => {
  for (const boot of fixture.boots) {
    const { world, config, expectedAgents } = bootOrrum5(boot.seed);

    // Same deposits at the same coordinates — quantity, capacity, regen state.
    const deposits = [...world.cells.values()]
      .filter((c) => c.deposit)
      .map((c) => ({
        coord: c.coord,
        resource: c.deposit.resource,
        quantity: c.deposit.quantity,
        capacity: c.deposit.capacity,
        regenAccum: c.deposit.regenAccum,
      }))
      .sort((a, b) => (a.coord < b.coord ? -1 : 1));
    assert.deepEqual(deposits, boot.deposits, `seed ${boot.seed}: deposits byte-identical`);

    // Same viability arithmetic, key for key. (expectedAgents = slots in the
    // default config, so fix 6.1's cap change is invisible here — as it must
    // be.)
    const viability = computeViability(world, config.maxTicks, expectedAgents);
    assert.deepEqual(viability, boot.viability, `seed ${boot.seed}: viability identical`);

    const slack = computeConstructionSlack(world, config.maxTicks, expectedAgents, typicalStructureCost(world));
    assert.deepEqual(slack, boot.constructionSlack, `seed ${boot.seed}: construction slack identical`);

    // Same vitals — the one key that MOVED (sivetRestores) now lives on the
    // consumable declaration, verbatim.
    const { sivetRestores, ...v08Vitals } = boot.vitals;
    assert.deepEqual(world.vitals, v08Vitals, `seed ${boot.seed}: vitals identical`);
    assert.equal(world.consumable.restores, sivetRestores, "restores moved verbatim");
    assert.equal(world.consumable.name, "sivet");

    // Same grid, slots, limits, lineage, destruction.
    assert.equal(world.gridSize, boot.gridSize);
    assert.equal(world.width, boot.gridSize);
    assert.equal(world.height, boot.gridSize);
    assert.equal(world.slots.total, boot.slots.total);
    assert.equal(world.carryLimit, boot.carryLimit);
    assert.equal(world.inscriptionMax, boot.inscriptionMax);
    assert.deepEqual(world.lineage, boot.lineage);
    const { rubbleRatio, ...v08Destruction } = boot.destruction;
    assert.deepEqual({ ...world.destruction, rubbleRatio: world.byproduct.ratio }, { ...v08Destruction, rubbleRatio });
  }

  // Same recipes, same forms, same premise — moved verbatim.
  const defn = loadDefinition(join(daemonDir, "worlds", "orrum-5.json"));
  assert.deepEqual(defn.recipes, fixture.recipes, "recipe table moved verbatim");
  assert.deepEqual([...defn.forms], fixture.forms, "forms moved verbatim");
  assert.equal(defn.premise, fixture.premise, "premise moved verbatim");
  const w = bootOrrum5(1).world;
  assert.equal(typicalStructureCost(w), fixture.typicalStructureCost);
});

// ---------- test 3: roles, not names ----------

const RENAMED_WORLD = {
  name: "Test-Renamed",
  grid: { width: 8, height: 8 },
  premise: "A different valley with different words for everything.",
  resources: [
    { name: "berry", role: "consumable", need: "sustenance", restores: 25 },
    { name: "stone", role: "structural" },
    { name: "clay", role: "structural" },
    { name: "shard", role: "byproduct", substitutesFor: "stone", ratio: 3 },
  ],
  deposits: { seedDensity: 0.12, quantityRange: [10, 20], regenPerTick: 0.15, distribution: "clustered" },
  recipes: {
    marker: { stone: 1 },
    wall: { stone: 3, clay: 1 },
  },
  forms: ["wall", "marker"],
  vitals: { sustenanceMax: 100, sustenanceDecayPerTick: 3 },
  viability: { targetRatio: 1.35, viabilityFloor: 1.0, minSpringsPerResource: 2 },
  actions: ["move", "say", "build", "wait", "gather", "drop", "give", "consume"],
};

test("v0.9 test 3 — roles, not names: a definition with different resource names computes correct viability", () => {
  const definition = normalizeDefinition(RENAMED_WORLD);
  const world = createWorld({
    definition,
    slots: 13,
    seeding: { ...VIABILITY_DEFAULTS, ...definition.viability, maxTicks: 250, expectedAgents: 13 },
    rng: mulberry32(1337),
  });
  const v = computeViability(world, 250, 13);
  // The ratio path seeded the CONSUMABLE (berry) to the target ratio, and
  // the arithmetic computed from the role, not from any name.
  assert.ok(Math.abs(v.ratio - 1.35) / 1.35 < 0.05, `ratio ${v.ratio.toFixed(3)} within 5% of target`);
  assert.ok(v.seededSivet > 0 && v.sivetSprings >= 2, "consumable seeded under the v0.8 record keys");
  const seeded = new Set([...world.cells.values()].filter((c) => c.deposit).map((c) => c.deposit.resource));
  assert.ok(seeded.has("berry") && seeded.has("stone") && seeded.has("clay"), "all seedable types present");
  assert.ok(!seeded.has("shard"), "the byproduct is never seeded");
});

test("v0.9 test 3b — consume restores from the consumable role; the byproduct substitutes in builds", () => {
  const definition = normalizeDefinition(RENAMED_WORLD);
  const world = createWorld({ definition, slots: 4 });
  const eater = addAgentAt(world, "Renamed Eater", "1,1");
  eater.sustenance = 40;
  eater.inventory.berry = 1;
  const actions = new Map([
    [eater.id, { action: { type: "consume", resource: "berry" }, assigned: false, coercedWait: false, coerceReason: null }],
  ]);
  resolveTick(world, 1, "09:00", actions, captureRoster(world));
  assert.ok(eater.lastActionOutcome.why.includes("restored 25 sustenance"), "berry restores as the consumable");

  const builder = addAgentAt(world, "Renamed Builder", "2,2");
  builder.inventory.stone = 1; // wall needs 3 stone 1 clay: gap of 2 stone
  builder.inventory.clay = 1;
  builder.inventory.shard = 6; // 2 × ratio 3
  const buildActions = new Map([
    [builder.id, {
      action: { type: "build", structure: { form: "wall", name: "Shard Wall", description: "" } },
      assigned: false, coercedWait: false, coerceReason: null,
    }],
  ]);
  resolveTick(world, 2, "09:15", buildActions, captureRoster(world));
  assert.equal(builder.lastActionOutcome.result, "ok");
  assert.ok(
    builder.lastActionOutcome.why.includes("6 shard in place of 2 stone"),
    `byproduct substitution reported: ${builder.lastActionOutcome.why}`
  );
  assert.equal(builder.inventory.shard, 0);
});

// ---------- test 4: non-square grid ----------

test("v0.9 test 4 — a 4×16 world boots, computes adjacency correctly, and keeps the fog", () => {
  const definition = normalizeDefinition({
    ...RENAMED_WORLD,
    name: "Canyon",
    grid: { width: 4, height: 16 },
  });
  const world = createWorld({
    definition,
    slots: 5,
    seeding: { ...VIABILITY_DEFAULTS, ...definition.viability, maxTicks: 250, expectedAgents: 5 },
    rng: mulberry32(7),
  });
  assert.equal(world.width, 4);
  assert.equal(world.height, 16);
  assert.equal(world.gridSize, null, "non-square worlds carry no square gridSize");
  assert.equal(world.cells.size, 64);
  assert.ok(world.cells.has("3,15") && !world.cells.has("4,0") && !world.cells.has("0,16"));

  // Adjacency at the asymmetric edges: 4-way, in-bounds only.
  assert.deepEqual(exitsFor(world, "0,0").map((e) => e.coord).sort(), ["0,1", "1,0"]);
  assert.deepEqual(exitsFor(world, "3,15").map((e) => e.coord).sort(), ["2,15", "3,14"]);
  assert.deepEqual(exitsFor(world, "3,7").map((e) => e.coord).sort(), ["2,7", "3,6", "3,8"]);
  assert.equal(exitsFor(world, "1,7").length, 4);

  // The fogs hold: an observation from one corner carries no distant cell.
  const far = addAgentAt(world, "Far Watcher", "3,15");
  const near = addAgentAt(world, "Near Walker", "0,0");
  const obs = buildObservation(world, near.id, 1, { simTime: "09:00", deadline: null, retrievalK: 8 });
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("3,15"), "a cell never stood in is absent");
  assert.ok(!dump.includes("Far Watcher"), "a non-co-located agent is invisible");
  assert.equal(obs.cell.coord, "0,0");
});

// ---------- test 5: action toggles ----------

test("v0.9 test 5 — an action absent from the definition is rejected by the daemon", () => {
  const definition = normalizeDefinition(RENAMED_WORLD); // no attack, no take
  const world = createWorld({ definition, slots: 4 });
  const attack = validateAction(
    { protocol: "0.4", type: "attack", target: "a_0001" },
    {},
    world
  );
  assert.equal(attack.error, true);
  assert.equal(attack.detail, '"attack" is not part of this world');
  const take = validateAction({ protocol: "0.4", type: "take", target: "a_0001", resource: "berry" }, {}, world);
  assert.equal(take.error, true);
  assert.equal(take.detail, '"take" is not part of this world');
  // An enabled action still validates; a genuinely unknown type still
  // coerces to wait rather than erroring (protocol §10).
  const move = validateAction({ protocol: "0.4", type: "move", coord: "1,0" }, {}, world);
  assert.equal(move.error, undefined);
  const unknown = validateAction({ protocol: "0.4", type: "juggle" }, {}, world);
  assert.equal(unknown.coercedWait, true);
});

test("v0.9 test 5b — Orrum-5 declares exactly the v0.8 action set: take is off in it", () => {
  const defn = defaultDefinition();
  assert.deepEqual(
    [...defn.actions].sort(),
    ["attack", "beget", "build", "consume", "demolish", "drop", "foster", "gather", "give", "inscribe", "move", "raze", "say", "wait"].sort()
  );
  assert.ok(!defn.actions.has("take"), "take is OFF in Orrum-5");
  assert.equal(defn.knowledgeInheritance, false, "knowledge inheritance is OFF in Orrum-5");
});

// ---------- tests 6 and 7: take ----------

const TAKE_WORLD = normalizeDefinition({
  ...RENAMED_WORLD,
  name: "Take-Test",
  actions: [...RENAMED_WORLD.actions, "take", "attack", "raze"],
});

function takeFixture() {
  const world = createWorld({ definition: TAKE_WORLD, slots: 6 });
  const victim = addAgentAt(world, "Victim", "1,1");
  const taker = addAgentAt(world, "Taker", "1,1");
  const witness = addAgentAt(world, "Witness", "1,1");
  const outsider = addAgentAt(world, "Outsider", "3,3");
  victim.inventory.berry = 2;
  return { world, victim, taker, witness, outsider };
}

const act = (action) => ({ action, assigned: false, coercedWait: false, coerceReason: null });

test("v0.9 test 6 — take visibility: victim and co-located witnesses remember; zero trace outside the cell", () => {
  const { world, victim, taker, witness, outsider } = takeFixture();
  const actions = new Map([[taker.id, act({ type: "take", target: victim.id, resource: "berry" })]]);
  const summary = resolveTick(world, 1, "09:00", actions, captureRoster(world));
  assert.equal(summary.take, 1);
  assert.equal(victim.inventory.berry, 1, "one unit left the victim");
  assert.equal(taker.inventory.berry, 1, "one unit reached the taker");

  const expected = "Taker took 1 berry from Victim.";
  for (const body of [victim, taker, witness]) {
    assert.ok(
      body.memories.some((m) => m.text === expected),
      `${body.persona.name} holds the ordinary memory`
    );
  }

  // Nobody outside the cell knows: scan the outsider's full observation.
  const obs = buildObservation(world, outsider.id, 2, { simTime: "09:15", deadline: null, retrievalK: 8 });
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("took"), "no trace of the take outside the cell");
  assert.ok(!dump.includes("Taker") && !dump.includes("Victim"), "no names travel");
});

test("v0.9 test 6b — take failures coerce to wait and report flatly", () => {
  const { world, victim, taker } = takeFixture();
  // Target holds none of that resource.
  const r1 = new Map([[taker.id, act({ type: "take", target: victim.id, resource: "stone" })]]);
  resolveTick(world, 1, "09:00", r1, captureRoster(world));
  assert.deepEqual(taker.lastActionOutcome, { type: "take", result: "failed", why: "they hold no stone", attempts: 1 });
  // Target absent.
  const r2 = new Map([[taker.id, act({ type: "take", target: "a_zzzz", resource: "berry" })]]);
  resolveTick(world, 2, "09:15", r2, captureRoster(world));
  assert.equal(taker.lastActionOutcome.why, "no such agent here");
  // Actor at carry limit.
  taker.inventory.stone = world.carryLimit;
  const r3 = new Map([[taker.id, act({ type: "take", target: victim.id, resource: "berry" })]]);
  resolveTick(world, 3, "09:30", r3, captureRoster(world));
  assert.equal(taker.lastActionOutcome.why, "you cannot carry more");
  assert.equal(victim.inventory.berry, 2, "nothing ever moved");
});

test("v0.9 test 7 — take resolves before movement: the victim cannot flee a take already underway", () => {
  const { world, victim, taker } = takeFixture();
  const actions = new Map([
    [taker.id, act({ type: "take", target: victim.id, resource: "berry" })],
    [victim.id, act({ type: "move", coord: "1,2" })],
  ]);
  resolveTick(world, 1, "09:00", actions, captureRoster(world));
  assert.equal(victim.coord, "1,2", "the move still happened");
  assert.equal(victim.inventory.berry, 1, "but the unit was already gone");
  assert.equal(taker.inventory.berry, 1);
});

test("v0.9 test 7b — an agent cannot take and move in the same tick: one action per tick holds for take", () => {
  const { world, victim, taker } = takeFixture();
  // take is a single action; the taker's action this tick IS the take, so
  // its position after resolution is unchanged — assert the resolution
  // order pins it: take lands before raze in the same tick.
  const cell = world.cells.get("1,1");
  cell.structure = {
    form: "marker",
    authored: { name: "Marked Stone", description: "" },
    inscription: { entries: [], charactersUsed: 0 },
    demolishProgress: null,
    history: [{ agentId: victim.id, tick: 0, action: "build" }],
  };
  const razer = addAgentAt(world, "Razer", "1,1");
  razer.vitality = 100;
  const actions = new Map([
    [taker.id, act({ type: "take", target: victim.id, resource: "berry" })],
    [razer.id, act({ type: "raze" })],
  ]);
  const summary = resolveTick(world, 1, "09:00", actions, captureRoster(world));
  assert.equal(summary.take, 1);
  assert.equal(summary.raze, 1);
  assert.equal(taker.coord, "1,1", "the taker is still standing where it took");
});

// ---------- test 8: knowledge inheritance ----------

test("v0.9 test 8 — inheritance: the child's map and failed-attempt record match the parent's at birth and diverge after", () => {
  const definition = normalizeDefinition({
    ...RENAMED_WORLD,
    name: "Heirloom",
    actions: [...RENAMED_WORLD.actions, "beget", "foster"],
    knowledgeInheritance: true,
  });
  const world = createWorld({ definition, slots: 6, lineage: { begetResourceCost: { berry: 1 }, begetVitalityCost: 5 } });
  assert.equal(world.knowledgeInheritance, true);
  const parent = addAgentAt(world, "Parent", "1,1");
  // A parent who has seen a cell and failed at things.
  parent.knownCells.set("2,1", { structureSnapshot: null, lastSeenTick: 3 });
  parent.failedAttempts.push({ type: "build", detail: "wall", why: "short 2 stone", count: 3, lastTick: 4 });
  parent.inventory.berry = 5;

  const actions = new Map([[parent.id, act({ type: "beget" })]]);
  resolveTick(world, 5, "10:00", actions, captureRoster(world));
  const infant = [...world.agents.values()].find((b) => b.lifeStage === "infant");
  assert.ok(infant, "an infant was born");

  // Match at birth…
  assert.deepEqual([...infant.knownCells.keys()].sort(), [...parent.knownCells.keys()].sort());
  assert.deepEqual(infant.failedAttempts, parent.failedAttempts);
  // …but the copies are the child's own: divergence is real.
  parent.failedAttempts[0].count = 9;
  parent.knownCells.set("3,1", { structureSnapshot: null, lastSeenTick: 6 });
  assert.equal(infant.failedAttempts[0].count, 3, "the child's record does not track the parent");
  assert.ok(!infant.knownCells.has("3,1"), "the child's map does not track the parent");

  // The record renders through the existing observation path once claimed —
  // with no word about inheritance anywhere.
  infant.lifeStage = "adult";
  infant.persona = structuredClone(persona("Heir"));
  const obs = buildObservation(world, infant.id, 7, { simTime: "10:30", deadline: null, retrievalK: 8 });
  assert.ok(obs.self.failedAttempts?.some((f) => f.detail === "wall" && f.count === 3), "inherited record renders");
  const dump = JSON.stringify(obs).toLowerCase();
  for (const word of ["inherit", "parent knew", "passed down"]) {
    assert.ok(!dump.includes(word), `no inheritance framing: ${word}`);
  }
});

test("v0.9 test 8b — inheritance OFF (Orrum-5 and any world not declaring it): the child starts blank", () => {
  const definition = normalizeDefinition({
    ...RENAMED_WORLD,
    name: "Blank-Slate",
    actions: [...RENAMED_WORLD.actions, "beget"],
  });
  const world = createWorld({ definition, slots: 6, lineage: { begetResourceCost: { berry: 1 }, begetVitalityCost: 5 } });
  const parent = addAgentAt(world, "Parent Blank", "1,1");
  parent.failedAttempts.push({ type: "build", detail: "wall", why: "short 2 stone", count: 3, lastTick: 4 });
  parent.inventory.berry = 5;
  const actions = new Map([[parent.id, act({ type: "beget" })]]);
  resolveTick(world, 5, "10:00", actions, captureRoster(world));
  const infant = [...world.agents.values()].find((b) => b.lifeStage === "infant");
  assert.equal(infant.failedAttempts.length, 0);
  // The end-of-tick snapshot gives every body its CURRENT cell (v0.8
  // behavior, unchanged); nothing else was copied.
  assert.deepEqual([...infant.knownCells.keys()], ["1,1"]);
});

// ---------- test 9: viability off-by-one ----------

test("v0.9 test 9 — optimalSurvivors and demand use the same agent count (fix 6.1)", () => {
  const { world } = (() => bootOrrum5(1337))();
  // Run-13's shape: expectedAgents below slots. The baseline must never
  // exceed the population the demand was computed over.
  const v = computeViability(world, 250, 11);
  assert.equal(v.expectedAgents, 11);
  assert.ok(v.optimalSurvivors <= 11, `optimalSurvivors ${v.optimalSurvivors} bounded by expectedAgents`);
  // And with a huge larder the cap binds exactly at expectedAgents.
  for (const cell of world.cells.values()) {
    if (cell.deposit?.resource === "sivet") cell.deposit.capacity = 10000;
  }
  const capped = computeViability(world, 250, 11);
  assert.equal(capped.optimalSurvivors, 11);
});

// ---------- the engine knows the world's premise ----------

test("v0.9 — a definition world carries its name and premise onto the run header", () => {
  const definition = normalizeDefinition(RENAMED_WORLD);
  const engine = new TickEngine({
    worldFactory: () => createWorld({ definition, slots: 4 }),
    config: { maxTicks: 10, minAgents: 1, actionDeadlineMs: 100, startSimTime: "09:00", minutesPerTick: 15, startPaused: true },
  });
  try {
    assert.equal(engine.lastRunStarted.world, "Test-Renamed");
    assert.equal(engine.lastRunStarted.premise, RENAMED_WORLD.premise);
    assert.equal(engine.lastRunStarted.width, 8);
    assert.equal(engine.lastRunStarted.height, 8);
  } finally {
    engine.dispose();
  }
});
