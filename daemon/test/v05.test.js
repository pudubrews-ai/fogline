// v0.5 gates: world viability (daemon spec §2), allocation fairness,
// fragment read semantics, the raze gate, surface containment, operator
// record containment, and the re-derived lean preset.

import { defaultDefinition } from "../world/definition.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../server.js";
import { createWorld, parseCoord } from "../world/world.js";
import { resourcesConfig } from "../world/resources.js";
import { computeViability } from "../world/viability.js";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { addAgentAt, bootDaemon, register, act, openSse } from "./helpers.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Deterministic rng for seeded worlds (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1. viability arithmetic ----------

test("GATE viability arithmetic: the v0.4 extinction config computes to ~0.70 ratio and 1.25 capacity", () => {
  // The first 200-tick run, reconstructed: 3 sivet springs seeding 43 units
  // (log-verified), regen 0.05/tick, decay 3, 5 agents, 200 ticks. Note:
  // the protocol formula (§6.2) computes demand over SLOTS; the extinction
  // analysis measured demand for its 5 live agents, so this fixture uses
  // slots = 5 to reproduce the published numbers.
  const world = createWorld({ defaults: defaultDefinition(), 
    gridSize: 8,
    slots: 5,
    resources: { seedDensity: 0.12, quantityRange: [10, 20], regenPerTick: 0.05, distribution: "clustered" },
    vitals: { sustenanceMax: 100, sustenanceDecayPerTick: 3, sivetRestores: 25 },
  });
  // Pin the deposits to the measured world: exactly 3 sivet springs, 43 total.
  for (const cell of world.cells.values()) cell.deposit = null;
  const quantities = [15, 14, 14];
  ["0,0", "1,0", "0,1"].forEach((coord, i) => {
    world.cells.get(coord).deposit = { resource: "sivet", quantity: quantities[i], capacity: quantities[i], regenAccum: 0 };
  });

  const v = computeViability(world, 200);
  assert.equal(v.seededSivet, 43);
  assert.equal(v.sivetSprings, 3);
  assert.equal(v.demand, 100, "5 agents × ((3 × 200) − 100) / 25");
  assert.equal(v.supply, 73, "43 seeded + 3 × 0.05 × 200 regenerated");
  assert.ok(Math.abs(v.ratio - 0.7) < 0.05, `ratio ${v.ratio} ≈ 0.70 — the run was decided at generation`);
  assert.ok(Math.abs(v.capacity - 1.25) < 1e-9, "the flow alone sustains 1.25 agents — the sharper number");
  // Closed-form optimal-play baseline: capacity + larder over the run.
  const expectedOptimal = 1.25 + (43 * 25) / (3 * 200);
  assert.ok(Math.abs(v.optimalSurvivors - expectedOptimal) < 1e-9);
  assert.ok(v.optimalSurvivors < 5, "even optimal play could not save all five");
});

// ---------- 2. floor enforcement ----------

test("GATE viability floor: a config below viabilityFloor refuses to boot with the arithmetic in the error", () => {
  // targetRatio 0.5 seeds a world at half subsistence; floor 1.0 must refuse.
  let ticksOpened = 0;
  assert.throws(
    () => {
      const daemon = createDaemon(
        { viability: { targetRatio: 0.5, viabilityFloor: 1.0, minSpringsPerResource: 2 } },
        { logs: false }
      );
      daemon.engine.on("operator", ({ event }) => {
        if (event === "tick_open") ticksOpened += 1;
      });
      daemon.listen(0);
    },
    (err) => {
      assert.match(err.message, /ratio 0\.5\d < viabilityFloor 1\.00/);
      assert.match(err.message, /supply = \d+ seeded sivet/, "the supply arithmetic is in the message");
      // v0.6 A5: demand computes over expected agents; both populations named.
      assert.match(err.message, /demand = \d+ expected agents \(\d+ slots\)/, "the demand arithmetic is in the message");
      assert.match(err.message, /carrying capacity/, "capacity is in the message");
      return true;
    }
  );
  assert.equal(ticksOpened, 0, "tick 1 never opened");
});

// ---------- 3. seed by ratio ----------

test("GATE seed by ratio: targetRatio 1.35 lands within tolerance across ten seeds and three grid sizes", () => {
  for (const gridSize of [6, 8, 10]) {
    for (let seed = 1; seed <= 10; seed++) {
      const world = createWorld({ defaults: defaultDefinition(), 
        gridSize,
        slots: 12,
        resources: { seedDensity: 0.12, quantityRange: [10, 20], regenPerTick: 0.15, distribution: "clustered" },
        seeding: { targetRatio: 1.35, minSpringsPerResource: 2, maxTicks: 200 },
        rng: rng(seed * 1000 + gridSize),
      });
      const v = computeViability(world, 200);
      assert.ok(
        Math.abs(v.ratio - 1.35) / 1.35 < 0.05,
        `grid ${gridSize} seed ${seed}: ratio ${v.ratio.toFixed(3)} within 5% of 1.35`
      );
    }
  }
});

// ---------- 4. allocation fairness ----------

test("GATE allocation fairness: minSpringsPerResource on a 25-cell grid, order-independent", () => {
  const layoutFor = (order = null) => {
    const base = defaultDefinition();
    const world = createWorld({
      defaults: order ? { ...base, seedableTypes: order } : base,
      gridSize: 5,
      slots: 5,
      resources: { seedDensity: 0.08, quantityRange: [10, 20], regenPerTick: 0.35, distribution: "clustered" },
      seeding: { targetRatio: 1.25, minSpringsPerResource: 2, maxTicks: 400 },
      rng: rng(42),
    });
    const counts = { sivet: 0, orrum: 0, khal: 0 };
    const layout = [];
    for (const cell of world.cells.values()) {
      if (cell.deposit) {
        counts[cell.deposit.resource] += 1;
        layout.push(`${cell.coord}:${cell.deposit.resource}:${cell.deposit.quantity}`);
      }
    }
    return { counts, layout: layout.sort().join("|") };
  };

  // v0.9: seedable order comes from the world definition; permuting the
  // declaration order must not change the map (the plan is name-sorted).
  const permutations = [
    ["sivet", "orrum", "khal"],
    ["khal", "orrum", "sivet"],
    ["orrum", "sivet", "khal"],
    ["khal", "sivet", "orrum"],
  ];
  const results = [];
  for (const order of permutations) {
    results.push(layoutFor(order));
  }

  for (const { counts } of results) {
    for (const r of ["sivet", "orrum", "khal"]) {
      assert.ok(counts[r] >= 2, `${r} received ${counts[r]} springs — minimum 2 guaranteed before any surplus`);
    }
  }
  // Stronger than the guarantee: identical rng + shuffled order = identical map.
  for (const { layout } of results.slice(1)) {
    assert.equal(layout, results[0].layout, "allocation is order-independent");
  }
});

// ---------- 5. fragment read once per fragment per agent ----------

test("GATE fragment reads once per agent: two readers each read once, a later arrival reads once", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 6 });
  const a = addAgentAt(world, "Asha", "1,1");
  const b = addAgentAt(world, "Boro", "1,1");
  const c = addAgentAt(world, "Ciro", "3,3");
  world.cells.get("1,1").loose = { sivet: 0, orrum: 0, khal: 0, rubble: 6 };
  world.cells.get("1,1").fragment = {
    entries: [{ id: "t_well", authorId: "a_gone", authorName: "Old Marle", tick: 2, text: "The well belongs to everyone" }],
  };

  const fragmentReads = (body) =>
    body.memories.filter((m) => m.type === "inscription" && m.source === "a broken fragment in the rubble").length;

  for (let tick = 1; tick <= 3; tick++) writePerceptions(world, tick, "09:00");
  assert.equal(fragmentReads(a), 1, "Asha read the fragment exactly once across three ticks");
  assert.equal(fragmentReads(b), 1, "Boro read it exactly once too — per agent, not once globally");
  assert.equal(fragmentReads(c), 0, "Ciro has not been there");

  c.coord = "1,1";
  for (let tick = 4; tick <= 6; tick++) writePerceptions(world, tick, "10:00");
  assert.equal(fragmentReads(c), 1, "a third agent arriving later reads it once");
  assert.equal(fragmentReads(a), 1, "and the earlier readers never re-read");
});

// ---------- 6. fragment destroyed with the rubble ----------

test("GATE fragment dies with the pile: gathering rubble to zero removes it from observations", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 6 });
  const a = addAgentAt(world, "Asha", "1,1");
  const cell = world.cells.get("1,1");
  cell.loose = { sivet: 0, orrum: 0, khal: 0, rubble: 4 };
  cell.fragment = { entries: [{ id: "t_xyl", authorId: "a_gone", authorName: "Nobody Left", tick: 1, text: "XYLOGRAPH-REMEMBER-ME" }] };

  const observe = () =>
    buildObservation(world, a.id, 1, { simTime: "09:00", deadline: null, retrievalK: 3 });
  assert.equal(observe().cell.fragment.entries[0].authored.text, "XYLOGRAPH-REMEMBER-ME");

  const actions = new Map([
    [a.id, { action: { type: "gather" }, assigned: false, coercedWait: false, coerceReason: null }],
  ]);
  resolveTick(world, 1, "09:00", actions, captureRoster(world), {});
  assert.equal(cell.loose, null, "the pile is gone");
  assert.equal(cell.fragment, null, "carry off the pile, carry off the record");
  assert.ok(!JSON.stringify(observe()).includes("XYLOGRAPH"), "no trace in any later observation");
});

// ---------- 7. raze vitality gate ----------

test("GATE raze gate: an actor at vitality <= razeCost fails, structure stands, no vitality is lost", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 6 });
  const a = addAgentAt(world, "Asha", "1,1");
  const cell = world.cells.get("1,1");
  cell.structure = {
    form: "marker",
    authored: { name: "The Claim", description: "A claim stone." },
    inscription: { entries: [{ id: "t_mine", authorId: a.id, authorName: "Asha", tick: 0, text: "Mine" }], charactersUsed: 4 },
    demolishProgress: null,
    history: [{ agentId: a.id, tick: 0, action: "build" }],
  };
  a.vitality = world.destruction.razeCost; // exactly at the gate: <= fails
  a.sustenance = 40; // below regenThreshold: upkeep neither heals nor starves this tick

  const actions = new Map([
    [a.id, { action: { type: "raze" }, assigned: false, coercedWait: false, coerceReason: null }],
  ]);
  resolveTick(world, 1, "09:00", actions, captureRoster(world), {});

  assert.ok(cell.structure, "the structure still stands");
  assert.equal(cell.structure.inscription.entries[0].text, "Mine", "inscription untouched");
  assert.equal(a.vitality, world.destruction.razeCost, "no vitality was charged for the refusal");
  assert.equal(a.lastActionOutcome.result, "failed");
  assert.match(a.lastActionOutcome.why, /vitality/);
});

// ---------- 8. surface isolation ----------

test("GATE surface isolation: no observation carries any agent's surface; the operator stream does", async () => {
  const { daemon, base } = await bootDaemon({ actionDeadlineMs: 300, startPaused: false });
  try {
    const observations = [];
    daemon.engine.on("observation", (agentId, obs) => observations.push(obs));
    const operatorEvents = [];
    daemon.engine.on("operator", (e) => operatorEvents.push(e));

    const s1 = "claude-cli:sub:a3f9";
    const s2 = "codex-cli:sub:7b21";
    const r1 = await register(base, "Vara", { surface: s1, modelHint: "claude" });
    const r2 = await register(base, "Wex", { surface: s2, modelHint: "gpt" });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    // Let ticks run until a call report lands: submissions can race a tick
    // boundary, so retry with the current tick until one is accepted.
    let reported = false;
    for (let i = 0; i < 12 && !reported; i++) {
      const res = await act(base, r1.body.token, { tick: daemon.engine.tick, calls: 2 }).catch(() => null);
      if (res?.status === 200) reported = true;
      else await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(reported, "a call-reporting action was accepted");
    await new Promise((r) => setTimeout(r, 700));

    assert.ok(observations.length >= 2, "observations were emitted");
    for (const obs of observations) {
      const dump = JSON.stringify(obs);
      assert.ok(!dump.includes(s1) && !dump.includes(s2), "no surface string in any observation");
      // Boundary-anchored, not bare substring: a random hex agent id like
      // a_a3f9 would collide with a raw "a3f9" scan. The fingerprint as a
      // standalone token has boundaries; inside a hex id it has none.
      assert.ok(!/\b(a3f9|7b21)\b/.test(dump), "no fingerprint fragment either");
      assert.ok(!dump.includes("surface"), "no surface field at all");
    }

    const clientStates = operatorEvents.filter((e) => e.event === "client_state");
    assert.ok(
      clientStates.some((e) => e.data.surface === s1) && clientStates.some((e) => e.data.surface === s2),
      "the operator stream carries both surfaces"
    );
    const tickRecords = operatorEvents.filter((e) => e.event === "tick");
    assert.ok(
      tickRecords.some((e) => e.data.spend?.some((s) => s.surface === s1 && s.callsTotal >= 2)),
      "client-reported call counts aggregate per surface on the operator stream"
    );
  } finally {
    await daemon.close();
  }
});

// ---------- 9. operator record containment ----------

test("GATE operator record containment: the operator record module is unreachable from world/observe.js", () => {
  // Walk the static import graph from the observation builder. The resolved
  // tick record (with every agent's memories, objectives, and reasons) is
  // assembled in engine/tick.js and served by api/operator.js; neither may
  // ever be importable — even transitively — from the fog boundary.
  const visited = new Set();
  const queue = [resolve(baseDir, "world/observe.js")];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/import\s+[^"']*["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  const forbidden = ["engine/tick.js", "api/operator.js", "server.js"].map((p) => resolve(baseDir, p));
  for (const f of forbidden) {
    assert.ok(!visited.has(f), `${f} must not be reachable from world/observe.js`);
  }
  assert.ok(visited.has(resolve(baseDir, "world/memory.js")), "sanity: the walk actually followed imports");
});

// ---------- 10. lean preset varies ----------

test("GATE lean preset: survivor counts vary across ten probe seeds — not a constant", () => {
  // The probe from the v0.4 tuning pass: the real resolver, fog-honest
  // solitary foragers — they discover springs by standing on them, remember
  // what they have seen, travel directly to remembered food, and eat at the
  // right threshold. The old lean preset produced 3 survivors in 10/10
  // trials — deterministic, so it discriminated nothing. The re-derived
  // preset must vary: spawn and spring geometry decide who finds food in
  // time, and geometry differs by seed.
  const lean = JSON.parse(readFileSync(join(baseDir, "config.lean.json"), "utf8"));
  const AGENTS = 5;
  const survivorCounts = [];

  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed * 7919);
    const world = createWorld({ defaults: defaultDefinition(), 
      gridSize: lean.gridSize,
      slots: lean.slots,
      resources: resourcesConfig(lean),
      vitals: lean.vitals,
      seeding: { ...lean.viability, maxTicks: lean.maxTicks },
      carryLimit: lean.carryLimit,
      rng: r,
    });
    const knowledge = new Map(); // agentId -> Map(coord -> "sivet" | "none")
    for (let i = 0; i < AGENTS; i++) {
      const coord = `${Math.floor(r() * lean.gridSize)},${Math.floor(r() * lean.gridSize)}`;
      const body = addAgentAt(world, `Probe${seed}x${i}`, coord);
      knowledge.set(body.id, new Map());
    }

    const manhattan = (a, b) => {
      const p = parseCoord(a);
      const q = parseCoord(b);
      return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    };
    const stepToward = (from, to) => {
      const a = parseCoord(from);
      const b = parseCoord(to);
      if (a.x !== b.x) return `${a.x + Math.sign(b.x - a.x)},${a.y}`;
      return `${a.x},${a.y + Math.sign(b.y - a.y)}`;
    };

    for (let tick = 1; tick <= lean.maxTicks && world.agents.size > 0; tick++) {
      const actions = new Map();
      for (const body of world.agents.values()) {
        const known = knowledge.get(body.id);
        const cell = world.cells.get(body.coord);
        // Fog-honest perception: only the cell under your feet updates the map.
        known.set(body.coord, cell.deposit?.resource === "sivet" && cell.deposit.quantity >= 1 ? "sivet" : "none");

        let action = { type: "wait" };
        const hungry = body.sustenance <= lean.vitals.sustenanceMax - lean.vitals.sivetRestores;
        if (hungry && body.inventory.sivet >= 1) {
          action = { type: "consume", resource: "sivet" };
        } else if (cell.deposit?.resource === "sivet" && cell.deposit.quantity >= 1 && body.inventory.sivet < 6) {
          action = { type: "gather" };
        } else if (body.inventory.sivet < 2) {
          const rememberedSprings = [...known.entries()]
            .filter(([, v]) => v === "sivet")
            .map(([coord]) => coord)
            .filter((coord) => coord !== body.coord);
          const unexplored = [...world.cells.keys()].filter((coord) => !known.has(coord));
          const targets = rememberedSprings.length > 0 ? rememberedSprings : unexplored;
          if (targets.length > 0) {
            targets.sort((a, b) => manhattan(body.coord, a) - manhattan(body.coord, b) || (a < b ? -1 : 1));
            action = { type: "move", coord: stepToward(body.coord, targets[0]) };
          }
        }
        actions.set(body.id, { action, assigned: false, coercedWait: false, coerceReason: null });
      }
      resolveTick(world, tick, "09:00", actions, captureRoster(world), {});
    }
    survivorCounts.push(world.agents.size);
  }

  const distinct = new Set(survivorCounts);
  assert.ok(
    distinct.size >= 2,
    `survivor counts ${JSON.stringify(survivorCounts)} must vary across seeds — a constant teaches nothing when run twice`
  );
  assert.ok(
    survivorCounts.some((n) => n > 0),
    "the preset is survivable — this is contested scarcity, not an extinction chamber"
  );
});
