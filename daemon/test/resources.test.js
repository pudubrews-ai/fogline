// Deposits, clustering, regeneration, loose piles (daemon spec §2).

import { defaultDefinition } from "../world/definition.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../world/world.js";
import {
  addLoose,
  depositView,
  emptyInventory,
  inventoryTotal,
  looseView,
  regenerateDeposits,
  resourcesConfig,
  seedDeposits,
} from "../world/resources.js";

const rc = resourcesConfig({});
const RESOURCE_TYPES = defaultDefinition().resourceTypes;

test("seeding: density respected, quantities in range, all three resources present", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 8, slots: 5 });
  seedDeposits(world, rc);
  const deposits = [...world.cells.values()].filter((c) => c.deposit);
  assert.equal(deposits.length, Math.round(0.35 * 64));
  // v0.4: rubble is a resource type but is NEVER seeded (protocol §5.2) —
  // only the three seedable types appear on a generated map.
  const types = new Set(deposits.map((c) => c.deposit.resource));
  assert.deepEqual([...types].sort(), ["khal", "orrum", "sivet"], "every seedable type is on the map, rubble never");
  for (const c of deposits) {
    assert.ok(c.deposit.quantity >= 4 && c.deposit.quantity <= 12);
    assert.equal(c.deposit.capacity, c.deposit.quantity);
  }
});

test("clustered distribution is uneven: same-resource deposits are spatially adjacent", () => {
  // Distribution MUST be uneven (protocol §5.2). Measure: the mean distance
  // from a deposit to the nearest same-resource deposit must be far below
  // scattered's expectation. For clusters grown by adjacency it is ~1.
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 8, slots: 5 });
  seedDeposits(world, { ...rc, distribution: "clustered" });
  const byResource = new Map(RESOURCE_TYPES.map((r) => [r, []]));
  for (const c of [...world.cells.values()].filter((c) => c.deposit)) {
    const [x, y] = c.coord.split(",").map(Number);
    byResource.get(c.deposit.resource).push({ x, y });
  }
  let total = 0;
  let count = 0;
  for (const points of byResource.values()) {
    for (const p of points) {
      const nearest = Math.min(
        ...points.filter((q) => q !== p).map((q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y))
      );
      total += nearest;
      count += 1;
    }
  }
  assert.ok(total / count <= 2, `mean nearest same-resource distance ${total / count} — not clustered`);
});

test("regeneration: fractional accumulation floors into quantity and caps at capacity", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 2, slots: 2 });
  const cell = world.cells.get("0,0");
  cell.deposit = { resource: "orrum", quantity: 0, capacity: 5, regenAccum: 0 };

  assert.equal(depositView(cell), null, "a mined-out deposit reports as absent");
  for (let i = 0; i < 19; i++) regenerateDeposits(world, rc); // 19 * 0.05 = 0.95
  assert.equal(cell.deposit.quantity, 0, "not yet a whole unit");
  regenerateDeposits(world, rc); // 1.00
  assert.equal(cell.deposit.quantity, 1, "regenerated back into existence");
  assert.deepEqual(depositView(cell), { resource: "orrum", quantity: 1 });

  cell.deposit.quantity = 5;
  cell.deposit.regenAccum = 0.9;
  regenerateDeposits(world, rc);
  assert.equal(cell.deposit.quantity, 5, "never exceeds capacity");
});

test("loose piles merge and report only positive entries; never regenerate", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 2, slots: 2 });
  const cell = world.cells.get("1,1");
  assert.equal(looseView(cell), null);
  addLoose(cell, { sivet: 2 }, RESOURCE_TYPES);
  addLoose(cell, { sivet: 1, khal: 3 }, RESOURCE_TYPES);
  assert.deepEqual(looseView(cell), { sivet: 3, khal: 3 });
  regenerateDeposits(world, rc);
  assert.deepEqual(looseView(cell), { sivet: 3, khal: 3 }, "regen never touches loose piles");
});

test("inventory arithmetic", () => {
  const inv = emptyInventory(RESOURCE_TYPES);
  assert.deepEqual(inv, { sivet: 0, orrum: 0, khal: 0, rubble: 0 });
  inv.orrum = 4;
  inv.khal = 1;
  assert.equal(inventoryTotal(inv), 5);
});
