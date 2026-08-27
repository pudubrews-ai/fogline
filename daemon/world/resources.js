// Resources: deposits, regeneration, loose piles, inventory arithmetic
// (protocol §5, daemon spec §2). Resource NAMES are public at /scenario;
// their PROPERTIES are not — nothing in this module describes what a
// resource does, only where it sits and how much of it there is.

export const RESOURCE_TYPES = ["sivet", "orrum", "khal", "rubble"];

// Rubble is NEVER seeded (protocol §5.2, §9.5): it exists only as a product
// of destruction. Seeding draws from this list, not RESOURCE_TYPES.
export const SEEDABLE_TYPES = ["sivet", "orrum", "khal"];

export const RESOURCE_DEFAULTS = {
  seedDensity: 0.35, // fraction of cells carrying a deposit
  quantityRange: [4, 12],
  regenPerTick: 0.05, // fractional; accumulate and floor
  distribution: "clustered", // clustered | scattered
};

export const resourcesConfig = (config) => ({ ...RESOURCE_DEFAULTS, ...(config.resources ?? {}) });

export const emptyInventory = () => ({ sivet: 0, orrum: 0, khal: 0, rubble: 0 });

export const inventoryTotal = (inv) => RESOURCE_TYPES.reduce((sum, r) => sum + (inv[r] ?? 0), 0);

// Cell deposits: {resource, quantity, capacity, regenAccum}. Capacity is the
// seeded quantity — a mined-out deposit regenerates back toward it and never
// beyond, so scarcity is renewable but bounded.

function seedCell(cell, resource, quantity) {
  cell.deposit = { resource, quantity, capacity: quantity, regenAccum: 0 };
}

const randomInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// Per-resource spring counts and per-spring quantities (daemon spec §2.4-2.5).
// Two rules, both normative:
//   - sivet is governed by targetRatio, not density: the seeder computes the
//     supply the ratio requires and seeds exactly what regeneration will not
//     provide. Density's meaning shifts with grid, slots, decay, and run
//     length; a ratio does not.
//   - every resource gets minSpringsPerResource springs BEFORE any surplus is
//     distributed, and the allocation is order-independent: the plan is
//     computed over the name-sorted resource list, so no ordering of
//     SEEDABLE_TYPES (or of anything else) can starve a resource.
// v0.4's round-robin allocator gave the lean preset exactly one sivet cell,
// and raising density to fix it would have pushed khal off the map.
function seedingPlan(world, rc, seeding, cellCount, rng) {
  const [qLo, qHi] = rc.quantityRange;
  const minSprings = Math.max(1, seeding?.minSpringsPerResource ?? 2);
  const types = [...SEEDABLE_TYPES].sort();
  const densityTarget = Math.max(types.length * minSprings, Math.round(rc.seedDensity * cellCount));
  const plan = new Map(); // resource -> {springs, quantities: number[]}

  const byRatio = seeding?.targetRatio != null && seeding?.maxTicks != null;
  if (byRatio) {
    const v = world.vitals;
    // Demand over the expected population (v0.6 A5), matching the viability
    // arithmetic, so the boot ratio equals targetRatio by construction.
    const expectedAgents = seeding.expectedAgents ?? world.slots.total;
    const demand = (expectedAgents * (v.sustenanceDecayPerTick * seeding.maxTicks - v.sustenanceMax)) / v.sivetRestores;
    const required = seeding.targetRatio * demand;
    const regenPerSpring = rc.regenPerTick * seeding.maxTicks;
    const avgQ = (qLo + qHi) / 2;
    // Spring count: enough that per-spring seeds land near quantityRange,
    // but never so many that regeneration alone overshoots the target —
    // regen is the primary dial, seeding fills the gap to the ratio.
    let springs = Math.max(minSprings, Math.round(required / (regenPerSpring + avgQ)));
    while (springs > minSprings && springs * regenPerSpring > required - springs) springs -= 1;
    // Leave room on the grid for the other resources' guaranteed springs.
    springs = Math.min(springs, Math.max(minSprings, cellCount - (types.length - 1) * minSprings));
    const seedTotal = Math.max(springs, Math.round(required - springs * regenPerSpring));
    const base = Math.floor(seedTotal / springs);
    const quantities = Array.from({ length: springs }, (_, i) => base + (i < seedTotal % springs ? 1 : 0));
    plan.set("sivet", { springs, quantities });
  }

  // Non-ratio resources fall back to density: the guaranteed minimum first,
  // then the density surplus split evenly across the name-sorted list.
  const fallbackTypes = types.filter((r) => !plan.has(r));
  const alreadyPlaced = [...plan.values()].reduce((n, p) => n + p.springs, 0);
  const remaining = Math.max(
    fallbackTypes.length * minSprings,
    densityTarget - alreadyPlaced
  );
  fallbackTypes.forEach((resource, i) => {
    const springs = Math.floor(remaining / fallbackTypes.length) + (i < remaining % fallbackTypes.length ? 1 : 0);
    plan.set(resource, {
      springs,
      quantities: Array.from({ length: springs }, () => randomInt(rng, qLo, qHi)),
    });
  });
  return plan;
}

// Uneven distribution is normative (protocol §5.2): clustered deposits create
// places worth being, which creates places worth contesting. Each cluster
// carries a single resource; all three types are always represented.
// `seeding` (from viabilityConfig + maxTicks) enables the ratio path; without
// it the plan falls back to density for everything, minimums still guaranteed.
export function seedDeposits(world, rc, rng = Math.random, seeding = null) {
  const coords = [...world.cells.keys()];
  const plan = seedingPlan(world, rc, seeding, coords.length, rng);
  const types = [...plan.keys()].sort();

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

  // Clustered: one center per resource, springs placed outward from the
  // center by Manhattan distance. Name-sorted iteration keeps placement
  // independent of any caller-supplied ordering.
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

// Fractional regeneration: accumulate, floor into quantity, cap at capacity.
// A deposit at zero is reported as absent but regenerates back into existence.
export function regenerateDeposits(world, rc) {
  for (const cell of world.cells.values()) {
    const dep = cell.deposit;
    if (!dep || dep.quantity >= dep.capacity) continue;
    dep.regenAccum += rc.regenPerTick;
    const whole = Math.floor(dep.regenAccum);
    if (whole > 0) {
      dep.quantity = Math.min(dep.capacity, dep.quantity + whole);
      dep.regenAccum -= whole;
    }
  }
}

// Loose piles: dropped by death or the drop action; never regenerate.
export function addLoose(cell, resources) {
  for (const r of RESOURCE_TYPES) {
    const n = resources[r] ?? 0;
    if (n <= 0) continue;
    if (!cell.loose) cell.loose = emptyInventory();
    cell.loose[r] += n;
  }
}

export const looseTotal = (cell) => (cell.loose ? inventoryTotal(cell.loose) : 0);

// How a deposit reports through the fog: quantity as a whole number, absent
// entirely when mined out (protocol §5.2).
export function depositView(cell) {
  const dep = cell.deposit;
  if (!dep || dep.quantity < 1) return null;
  return { resource: dep.resource, quantity: dep.quantity };
}

export function looseView(cell) {
  if (!cell.loose) return null;
  const out = {};
  for (const r of RESOURCE_TYPES) if (cell.loose[r] > 0) out[r] = cell.loose[r];
  return Object.keys(out).length > 0 ? out : null;
}
