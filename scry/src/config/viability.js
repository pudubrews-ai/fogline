// Browser-safe PORT of the daemon's boot arithmetic (observatory spec v0.8
// §3.2): viability, carrying capacity, deaths structurally required, and
// construction slack, plus the seeding plan needed to preview them from a
// drafted config. The daemon's world.js pulls node:crypto, so the modules
// are ported rather than shared — and test/v08.test.js asserts this port
// produces IDENTICAL output to daemon/world/viability.js on a fixture set,
// which is the spec's condition for porting at all. A preview that disagrees
// with the boot log is worse than no preview.
//
// NOTHING from recipes.js is ported or imported. The one recipe-derived
// number the slack arithmetic needs — typicalStructureCost, an aggregate the
// daemon already prints in operator logs — arrives at RUNTIME from the live
// snapshot or an archived run record, never from this bundle.

export const VITALS_DEFAULTS = {
  sustenanceMax: 100,
  sustenanceDecayPerTick: 1,
  sivetRestores: 25,
  vitalityMax: 100,
  starvationDamagePerTick: 3,
  regenThreshold: 50,
  regenPerTick: 1,
  attackDamage: 25,
  attackCost: 6,
  sponsorDrainPerTick: 1,
  orphanDamagePerTick: 4,
  vitalityHaleAbove: 66,
  vitalityFailingAtOrBelow: 25,
  sustenanceFedAbove: 60,
  sustenanceStarvingAtOrBelow: 20,
};

export const RESOURCE_DEFAULTS = {
  seedDensity: 0.35,
  quantityRange: [4, 12],
  regenPerTick: 0.05,
  distribution: "clustered",
};

export const VIABILITY_DEFAULTS = {
  targetRatio: 1.35,
  viabilityFloor: 1.0,
  minSpringsPerResource: 2,
};

const SEEDABLE_TYPES = ["sivet", "orrum", "khal"];

export const vitalsConfig = (config) => ({ ...VITALS_DEFAULTS, ...(config.vitals ?? {}) });
export const resourcesConfig = (config) => ({ ...RESOURCE_DEFAULTS, ...(config.resources ?? {}) });
export const viabilityConfig = (config) => ({ ...VIABILITY_DEFAULTS, ...(config.viability ?? {}) });

// Deterministic PRNG for preview sampling — the daemon seeds with
// Math.random, so a specific layout is a draw either way; the preview just
// makes its draws reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- seeding plan + placement (port of daemon resources.js) ----------

const randomInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function seedingPlan(world, rc, seeding, cellCount, rng) {
  const [qLo, qHi] = rc.quantityRange;
  const minSprings = Math.max(1, seeding?.minSpringsPerResource ?? 2);
  const types = [...SEEDABLE_TYPES].sort();
  const densityTarget = Math.max(types.length * minSprings, Math.round(rc.seedDensity * cellCount));
  const plan = new Map();

  const byRatio = seeding?.targetRatio != null && seeding?.maxTicks != null;
  if (byRatio) {
    const v = world.vitals;
    const expectedAgents = seeding.expectedAgents ?? world.slots.total;
    const demand = (expectedAgents * (v.sustenanceDecayPerTick * seeding.maxTicks - v.sustenanceMax)) / (world.consumable?.restores ?? v.sivetRestores);
    const required = seeding.targetRatio * demand;
    const regenPerSpring = rc.regenPerTick * seeding.maxTicks;
    const avgQ = (qLo + qHi) / 2;
    let springs = Math.max(minSprings, Math.round(required / (regenPerSpring + avgQ)));
    while (springs > minSprings && springs * regenPerSpring > required - springs) springs -= 1;
    springs = Math.min(springs, Math.max(minSprings, cellCount - (types.length - 1) * minSprings));
    const seedTotal = Math.max(springs, Math.round(required - springs * regenPerSpring));
    const base = Math.floor(seedTotal / springs);
    const quantities = Array.from({ length: springs }, (_, i) => base + (i < seedTotal % springs ? 1 : 0));
    plan.set("sivet", { springs, quantities });
  }

  const fallbackTypes = types.filter((r) => !plan.has(r));
  const alreadyPlaced = [...plan.values()].reduce((n, p) => n + p.springs, 0);
  const remaining = Math.max(fallbackTypes.length * minSprings, densityTarget - alreadyPlaced);
  fallbackTypes.forEach((resource, i) => {
    const springs = Math.floor(remaining / fallbackTypes.length) + (i < remaining % fallbackTypes.length ? 1 : 0);
    plan.set(resource, {
      springs,
      quantities: Array.from({ length: springs }, () => randomInt(rng, qLo, qHi)),
    });
  });
  return plan;
}

function seedDeposits(world, rc, rng, seeding) {
  const coords = [...world.cells.keys()];
  const plan = seedingPlan(world, rc, seeding, coords.length, rng);
  const types = [...plan.keys()].sort();
  const seedCell = (cell, resource, quantity) => {
    cell.deposit = { resource, quantity, capacity: quantity, regenAccum: 0 };
  };

  if (rc.distribution === "scattered") {
    const shuffled = [...coords].sort(() => rng() - 0.5);
    let next = 0;
    for (const resource of types) {
      for (const quantity of plan.get(resource).quantities) {
        if (next >= shuffled.length) return;
        seedCell(world.cells.get(shuffled[next++]), resource, quantity);
      }
    }
    return;
  }

  const dist = (a, b) => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  };

  const seeded = new Set();
  for (const resource of types) {
    const { quantities } = plan.get(resource);
    if (quantities.length === 0) continue;
    const open = coords.filter((c) => !seeded.has(c));
    if (open.length === 0) return;
    const center = open[Math.floor(rng() * open.length)];
    const nearest = open.sort((a, b) => dist(a, center) - dist(b, center) || (a < b ? -1 : 1));
    quantities.forEach((quantity, i) => {
      if (i >= nearest.length) return;
      seeded.add(nearest[i]);
      seedCell(world.cells.get(nearest[i]), resource, quantity);
    });
  }
}

// A minimal world-shaped object: exactly the fields the arithmetic reads.
export function buildPreviewWorld(config, rng = Math.random) {
  const gridSize = config.gridSize;
  const cells = new Map();
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      cells.set(`${x},${y}`, { coord: `${x},${y}`, deposit: null });
    }
  }
  const world = {
    gridSize,
    slots: { total: config.slots },
    vitals: vitalsConfig(config),
    resources: resourcesConfig(config),
    cells,
  };
  seedDeposits(world, world.resources, rng, {
    ...viabilityConfig(config),
    maxTicks: config.maxTicks,
    expectedAgents: config.expectedAgents ?? config.minAgents ?? 2,
  });
  return world;
}

// ---------- the arithmetic (verbatim port of daemon viability.js) ----------

export function computeViability(world, maxTicks, expectedAgents = world.slots.total) {
  const v = world.vitals;
  const rc = world.resources;
  const slots = world.slots.total;
  // v0.9: on a daemon world the restore amount lives on the consumable
  // declaration; preview worlds still carry the legacy vitals key.
  const restores = world.consumable?.restores ?? v.sivetRestores;

  let seededSivet = 0;
  let sivetSprings = 0;
  for (const cell of world.cells.values()) {
    if (cell.deposit?.resource === "sivet") {
      sivetSprings += 1;
      seededSivet += cell.deposit.capacity;
    }
  }

  const demand = (expectedAgents * (v.sustenanceDecayPerTick * maxTicks - v.sustenanceMax)) / restores;
  const regenSupply = sivetSprings * rc.regenPerTick * maxTicks;
  const supply = seededSivet + regenSupply;
  const ratio = demand > 0 ? supply / demand : Infinity;

  const capacity = (sivetSprings * rc.regenPerTick * restores) / v.sustenanceDecayPerTick;
  const capacityMargin = capacity - expectedAgents;
  const deathsRequired = Math.max(0, expectedAgents - Math.floor(capacity));

  // v0.9 fix 6.1, mirrored from the daemon: bounded by expectedAgents, the
  // same agent count demand computes over — not by the slot count.
  const optimalSurvivors = Math.min(
    expectedAgents,
    capacity + (seededSivet * restores) / (v.sustenanceDecayPerTick * maxTicks)
  );

  return {
    demand,
    supply,
    seededSivet,
    sivetSprings,
    regenSupply,
    ratio,
    capacity,
    capacityMargin,
    deathsRequired,
    optimalSurvivors,
    slots,
    expectedAgents,
    maxTicks,
  };
}

export function computeConstructionSlack(world, maxTicks, expectedAgents, typicalStructureCost) {
  const v = world.vitals;
  const rc = world.resources;

  let buildSeeded = 0;
  let materialSprings = 0;
  const sivetSprings = [];
  const materialCellsByResource = { orrum: [], khal: [] };
  for (const cell of world.cells.values()) {
    const dep = cell.deposit;
    if (!dep) continue;
    if (dep.resource === "sivet") sivetSprings.push(cell.coord);
    if (dep.resource === "orrum" || dep.resource === "khal") {
      materialSprings += 1;
      buildSeeded += dep.capacity;
      materialCellsByResource[dep.resource].push(cell.coord);
    }
  }
  const buildRegen = materialSprings * rc.regenPerTick * maxTicks;
  const buildSupply = buildSeeded + buildRegen;
  const buildDemand = Math.max(1e-9, expectedAgents * typicalStructureCost);

  const dist = (a, b) => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  };
  const nearestTripTo = (cells) => {
    let best = null;
    for (const s of sivetSprings) {
      for (const m of cells) {
        const d = dist(s, m);
        if (best === null || d < best) best = d;
      }
    }
    return best;
  };
  const tripOrrum = nearestTripTo(materialCellsByResource.orrum);
  const tripKhal = nearestTripTo(materialCellsByResource.khal);
  const trip = tripOrrum === null || tripKhal === null ? null : Math.max(tripOrrum, tripKhal);
  const travelCost = trip === null ? Infinity : 2 * trip * v.sustenanceDecayPerTick;
  const travelFactor = Number.isFinite(travelCost) ? Math.max(0, 1 - travelCost / v.sustenanceMax) : 0;
  const slack = (buildSupply / buildDemand) * travelFactor;

  return {
    slack,
    buildDemand,
    buildSupply,
    buildSeeded,
    buildRegen,
    materialSprings,
    typicalStructureCost,
    tripDistance: trip,
    travelCost: Number.isFinite(travelCost) ? travelCost : null,
    travelFactor,
    expectedAgents,
  };
}

// ---------- the preview (spec §3.2) ----------

// Ratio, capacity, and deaths required are seed-independent — the sivet plan
// is arithmetic — so they match the coming boot log exactly. Slack depends
// on where the materials land, which is a draw at boot too, so the preview
// samples layouts and reports the spread honestly rather than one number.
export function previewConfig(config, { typicalStructureCost = null, samples = 24 } = {}) {
  const expectedAgents = config.expectedAgents ?? config.minAgents ?? 2;
  const first = buildPreviewWorld(config, mulberry32(1));
  const viability = computeViability(first, config.maxTicks, expectedAgents);

  let slackSamples = null;
  if (typicalStructureCost != null) {
    const values = [];
    for (let i = 0; i < samples; i++) {
      const world = i === 0 ? first : buildPreviewWorld(config, mulberry32(i + 1));
      values.push(computeConstructionSlack(world, config.maxTicks, expectedAgents, typicalStructureCost).slack);
    }
    values.sort((a, b) => a - b);
    slackSamples = {
      median: values[Math.floor(values.length / 2)],
      min: values[0],
      max: values[values.length - 1],
    };
  }
  return { viability, slack: slackSamples };
}
