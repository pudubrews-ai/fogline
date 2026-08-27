// v0.7 gates (daemon spec v0.7 §8): consume reports its outcome, vitality
// trend is perceivable while the mechanic that produces it stays invisible,
// the capacity headline announces a lethal world at boot without refusing
// it, tripDistance measures the furthest required material, and a corpse is
// distinguishable from an empty cell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../server.js";
import { computeConstructionSlack } from "../world/viability.js";
import { typicalStructureCost } from "../world/recipes.js";
import { addLoose } from "../world/resources.js";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt, grant, bootDaemon } from "./helpers.js";

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };
const mk = (type, extra = {}) => ({
  action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: null, reason: null, ...extra },
  assigned: false,
  coercedWait: false,
});
const wait = () => mk("wait");
const consume = (resource) => mk("consume", { resource });

function tick(world, n, actions, hooks = {}) {
  writePerceptions(world, n, "09:15");
  return resolveTick(world, n, "09:15", actions, captureRoster(world), hooks);
}

function observe(world, agentId, n) {
  writePerceptions(world, n, "10:00");
  return buildObservation(world, agentId, n, OBS_OPTS);
}

// ---------- 1. consume outcome ----------

test("GATE consume outcome: khal reports nil restoration, sivet reports the amount restored (v0.7 A1)", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Eater", "1,1");
  grant(a, { khal: 1, sivet: 2 });

  a.sustenance = 40;
  tick(world, 1, new Map([[a.id, consume("khal")]]));
  assert.deepEqual(a.lastActionOutcome, {
    type: "consume", result: "ok", why: "consumed 1 khal; it restored nothing",
  });
  const obs1 = observe(world, a.id, 2);
  assert.equal(obs1.self.lastActionOutcome.why, "consumed 1 khal; it restored nothing", "reaches the observation");

  tick(world, 2, new Map([[a.id, consume("sivet")]]));
  assert.deepEqual(a.lastActionOutcome, {
    type: "consume", result: "ok", why: "consumed 1 sivet; it restored 25 sustenance",
  });

  // Sivet at a full tank restores nothing, and says so — the outcome is
  // reported, never the resource's general properties.
  a.sustenance = world.vitals.sustenanceMax;
  tick(world, 3, new Map([[a.id, consume("sivet")]]));
  assert.deepEqual(a.lastActionOutcome, {
    type: "consume", result: "ok", why: "consumed 1 sivet; it restored nothing",
  });
});

// ---------- 2. vitalityTrend states ----------

test("vitalityTrend: recovering, holding, and falling each produced by a scripted upkeep sequence (v0.7 A2)", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Trender", "1,1");

  // Above threshold, below max: regen lands → recovering.
  a.vitality = 50;
  a.sustenance = 80;
  tick(world, 1, new Map([[a.id, wait()]]));
  assert.equal(observe(world, a.id, 2).self.vitalityTrend, "recovering");

  // At max, fed: upkeep changes nothing → holding.
  a.vitality = world.vitals.vitalityMax;
  a.sustenance = 80;
  tick(world, 2, new Map([[a.id, wait()]]));
  assert.equal(observe(world, a.id, 3).self.vitalityTrend, "holding");

  // Starving: damage lands → falling.
  a.sustenance = 0;
  tick(world, 3, new Map([[a.id, wait()]]));
  assert.equal(observe(world, a.id, 4).self.vitalityTrend, "falling");
});

// ---------- 3. trend containment ----------

test("GATE trend containment: vitalityTrend never appears for any agent other than self — string-scan (v0.7 A2)", () => {
  const world = makeWorld();
  const faller = addAgentAt(world, "Faller", "1,1");
  const witness = addAgentAt(world, "Witness", "1,1");
  faller.sustenance = 0; // falling every tick
  witness.sustenance = 80;
  witness.vitality = 50; // recovering every tick
  for (let n = 1; n <= 3; n++) tick(world, n, new Map([[faller.id, wait()], [witness.id, wait()]]));

  const obs = observe(world, witness.id, 4);
  assert.equal(obs.self.vitalityTrend, "recovering", "own trend is present on self");

  // Everything except self: no trend field, no raw delta, for anyone.
  const outsideSelf = JSON.stringify({ ...obs, self: null });
  assert.ok(!outsideSelf.includes("vitalityTrend"), "no trend outside self");
  assert.ok(!outsideSelf.includes("lastUpkeepVitalityDelta"), "no raw delta outside self");
  assert.ok(!outsideSelf.includes("falling"), "another agent's direction is not readable anywhere");
  const wholeObs = JSON.stringify(obs);
  assert.ok(!wholeObs.includes("lastUpkeepVitalityDelta"), "the raw delta never ships at all");
});

// ---------- 4. threshold opacity ----------

test("GATE threshold opacity: no observation or /scenario response carries regenThreshold, the regen rate, or a derived figure — scanned (v0.7 A2)", async () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Opaque", "1,1");
  a.sustenance = 80;
  a.vitality = 50;
  tick(world, 1, new Map([[a.id, wait()]]));
  const dump = JSON.stringify(observe(world, a.id, 2));
  // Anchored field-name scan (no bare-digit matching): the vitality regen
  // mechanic must not be named or carried in any form.
  assert.ok(!/regen/i.test(dump), "no regen field of any kind in an observation");
  assert.ok(!/threshold/i.test(dump), "no threshold in an observation");

  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    const sdump = JSON.stringify(scenario);
    assert.ok(!/regenThreshold/i.test(sdump), "no regenThreshold at /scenario");
    assert.ok(!/threshold/i.test(sdump), "no threshold figure at /scenario");
    // The vitals regen rate must not ship. `regenSupply`/`regenPerTick` on
    // viability describe deposit regeneration — public per protocol §6.2 —
    // so the assertion is that no vitals block leaks, not that the word
    // regen is absent from resource arithmetic.
    assert.equal(sdump.includes("vitals"), false, "no vitals block at /scenario");
    assert.equal(scenario.viability.capacity !== undefined, true, "viability itself remains public");
  } finally {
    await daemon.close();
  }
});

// ---------- 5. capacity headline ----------

test("GATE capacity headline: a world that cannot sustain its expected population boots, and the shortfall is a headline figure; the ratio floor still refuses (v0.7 A3)", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "fogline-v07-log-"));
  const daemon = createDaemon(
    { slots: 12, minAgents: 2, expectedAgents: 40, startPaused: true },
    { logDir }
  );
  try {
    const server = daemon.listen(0);
    await new Promise((r) => server.once("listening", r));
    const via = daemon.engine.viability;
    assert.ok(via.capacity < 40, `test premise: capacity ${via.capacity} below 40 expected`);
    assert.equal(via.deathsRequired, 40 - Math.floor(via.capacity), "deaths structurally required, in whole agents");
    assert.ok(via.deathsRequired > 0);
    assert.ok(Math.abs(via.capacityMargin - (via.capacity - 40)) < 1e-9, "capacity − expectedAgents");

    // Exposed at /scenario beside the existing viability numbers.
    const base = `http://127.0.0.1:${server.address().port}`;
    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(scenario.viability.deathsRequired, via.deathsRequired);

    await daemon.close();
    // And in the boot log's run header — the postmortem number, at boot.
    const header = JSON.parse(readFileSync(join(logDir, "ticks.log"), "utf8").split("\n")[0]);
    assert.equal(header.event, "run_started");
    assert.equal(header.viability.deathsRequired, via.deathsRequired, "headline reaches the run header");
  } finally {
    await daemon.close();
    rmSync(logDir, { recursive: true, force: true });
  }

  // Unchanged: a config below the ratio floor still refuses to boot.
  assert.throws(
    () =>
      createDaemon(
        {
          slots: 5, minAgents: 2, startPaused: true,
          viability: { targetRatio: 0.5, viabilityFloor: 1.0, minSpringsPerResource: 2 },
        },
        { logs: false }
      ),
    /viabilityFloor/
  );
});

// ---------- 6. tripDistance ----------

test("GATE tripDistance: orrum in a far corner with khal adjacent to food produces the worst-case trip, not the adjacent one (v0.7 A4)", () => {
  const world = makeWorld({ gridSize: 4 });
  for (const cell of world.cells.values()) cell.deposit = null;
  const place = (coord, resource) => {
    world.cells.get(coord).deposit = { resource, quantity: 10, capacity: 10, regenAccum: 0 };
  };
  place("0,0", "sivet");
  place("0,1", "khal"); // distance 1 — the material the builder needs least is close
  place("3,3", "orrum"); // distance 6 — the binding material is the far corner

  const slack = computeConstructionSlack(world, 100, 2, typicalStructureCost());
  assert.equal(slack.tripDistance, 6, "the furthest required material decides the trip");

  // A world missing one required material entirely cannot complete any
  // two-material recipe: the trip is unbounded and the factor collapses.
  world.cells.get("3,3").deposit = null;
  const noOrrum = computeConstructionSlack(world, 100, 2, typicalStructureCost());
  assert.equal(noOrrum.tripDistance, null);
  assert.equal(noOrrum.travelFactor, 0);
});

// ---------- 7. corpse gather ----------

test("GATE corpse gather: a corpse holding nothing is distinguished from an empty cell, and a loose pile beside a corpse gathers normally (v0.7 A5)", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Scavenger", "1,1");
  const cell = world.cells.get("1,1");
  cell.deposit = null;
  cell.corpses.push({ authored: { name: "Departed" }, appearance: {}, diedAtTick: 1, causeAgentId: null });

  tick(world, 1, new Map([[a.id, mk("gather")]]));
  assert.deepEqual(a.lastActionOutcome, {
    type: "gather", result: "failed", why: "a corpse holds nothing", attempts: 1,
  });

  // The same refusal in a corpseless empty cell keeps the old wording.
  const b = addAgentAt(world, "Elsewhere", "2,2");
  world.cells.get("2,2").deposit = null;
  tick(world, 2, new Map([[a.id, wait()], [b.id, mk("gather")]]));
  assert.equal(b.lastActionOutcome.why, "nothing here to gather");

  // A loose pile in the corpse's cell — the dead agent's dropped inventory —
  // is gatherable exactly as before.
  addLoose(cell, { sivet: 2 });
  tick(world, 3, new Map([[a.id, mk("gather")], [b.id, wait()]]));
  assert.equal(a.lastActionOutcome.result, "ok");
  assert.match(a.lastActionOutcome.why, /took .*2 sivet/);
});
