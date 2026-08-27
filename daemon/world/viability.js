// World viability (protocol §6, daemon spec §2): subsistence arithmetic,
// steady-state carrying capacity, and the optimal-play survivor baseline.
// This module exists because the first 200-tick run went extinct at tick 180
// with supply at 0.70 of demand and a carrying capacity of 1.25 agents —
// the outcome was decided at generation, and nothing computed the product
// of the two knobs that decided it. A world that cannot sustain its
// population fails at boot, not at tick 180.

export const VIABILITY_DEFAULTS = {
  targetRatio: 1.35,
  viabilityFloor: 1.0,
  minSpringsPerResource: 2,
};

export const viabilityConfig = (config) => ({
  ...VIABILITY_DEFAULTS,
  ...(config.viability ?? {}),
});

// The boot computation (protocol §6.2 as amended by v0.6 A5), from the
// seeded world and the run parameters. All units are sivet except the two
// capacities, which are agents. `capacity` is the sharper number: a
// one-time larder moves the date of extinction, never the outcome.
//
// Demand computes over `expectedAgents` — the population the operator
// actually plans to run (config, default minAgents) — not over slots. A
// world with twelve slots and five clients is not feeding twelve bodies.
// Callers that pass nothing keep the old slots-based reading.
export function computeViability(world, maxTicks, expectedAgents = world.slots.total) {
  const v = world.vitals;
  const rc = world.resources;
  const slots = world.slots.total;

  let seededSivet = 0;
  let sivetSprings = 0;
  for (const cell of world.cells.values()) {
    if (cell.deposit?.resource === "sivet") {
      sivetSprings += 1;
      seededSivet += cell.deposit.capacity;
    }
  }

  // Perfect-play subsistence for the expected population over the whole run:
  // each body burns decay×maxTicks sustenance, arrives holding
  // sustenanceMax, and covers the rest with sivet at sivetRestores apiece.
  const demand = (expectedAgents * (v.sustenanceDecayPerTick * maxTicks - v.sustenanceMax)) / v.sivetRestores;
  const regenSupply = sivetSprings * rc.regenPerTick * maxTicks;
  const supply = seededSivet + regenSupply;
  const ratio = demand > 0 ? supply / demand : Infinity;

  // The population the regeneration flow alone sustains indefinitely.
  const capacity = (sivetSprings * rc.regenPerTick * v.sivetRestores) / v.sustenanceDecayPerTick;

  // The headline (v0.7 A3): capacity − expectedAgents, and in plain terms
  // how many deaths are structurally required. Run 10 booted at ratio 1.349
  // — clear of the floor — with capacity 10.0 against twelve expected
  // agents; two deaths were designed in and nobody noticed until the
  // postmortem. This is visibility, not prevention: a lethal world is a
  // legitimate configuration and MUST NOT be refused on this basis.
  const capacityMargin = capacity - expectedAgents;
  const deathsRequired = Math.max(0, expectedAgents - Math.floor(capacity));

  // Closed-form optimal-play baseline (daemon spec §2.6): efficient solitary
  // foragers with perfect knowledge. The flow sustains `capacity` agents
  // forever; the seeded larder feeds additional agents for the duration of
  // this run. An estimate, not a simulation — bounded by the slot count.
  const optimalSurvivors = Math.min(
    slots,
    capacity + (seededSivet * v.sivetRestores) / (v.sustenanceDecayPerTick * maxTicks)
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

// Construction slack (v0.6 A6, daemon spec §4): whether surplus exists for
// an agent to leave the springs and gather building material. A world can
// pass the subsistence floor and still be unable to build anything — one
// number cannot express both, so this is the second one.
//
//   buildDemand = expectedAgents × typicalStructureCost
//   buildSupply = seeded orrum + khal + their regeneration over maxTicks
//   travel      = sustenance burned on the round trip from the nearest
//                 sivet spring to the nearest material deposit, as a
//                 fraction of a full belly
//   slack       = (buildSupply / buildDemand) × (1 − travel)
//
// Below 1 means building is not affordable for the expected population.
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

  // The binding trip (v0.7 A4): every recipe except `marker` needs BOTH
  // orrum and khal, so the trip that decides buildability is to the
  // FURTHEST required material — per material, the nearest deposit to any
  // food spring; across materials, the worst of those. Run 10's minimum
  // over all pairs resolved to the material the builder needs least and
  // reported a comfortable number; on a seed with orrum in a far corner it
  // would pass a genuinely unbuildable world. A missing material type means
  // no trip can complete: distance is unbounded and the factor collapses.
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
  const travelFactor = Number.isFinite(travelCost)
    ? Math.max(0, 1 - travelCost / v.sustenanceMax)
    : 0;
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

// The refusal message (daemon spec §2.3): the arithmetic itself, so the
// operator can see exactly which knobs produced the failure.
export function viabilityFailureMessage(viability, floor, world) {
  const v = world.vitals;
  const rc = world.resources;
  return (
    `World not viable: subsistence ratio ${viability.ratio.toFixed(2)} < viabilityFloor ${floor.toFixed(2)}. ` +
    `supply = ${viability.seededSivet} seeded sivet + ${viability.sivetSprings} springs × ` +
    `${rc.regenPerTick}/tick × ${viability.maxTicks} ticks = ${viability.supply.toFixed(1)}; ` +
    `demand = ${viability.expectedAgents} expected agents (${viability.slots} slots) × ((${v.sustenanceDecayPerTick} decay × ${viability.maxTicks} ticks) − ` +
    `${v.sustenanceMax} starting sustenance) / ${v.sivetRestores} per sivet = ${viability.demand.toFixed(1)}; ` +
    `steady-state carrying capacity = ${viability.capacity.toFixed(2)} agents. ` +
    `Raise resources.regenPerTick or viability.targetRatio, or lower slots/maxTicks/decay.`
  );
}
