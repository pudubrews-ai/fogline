// PRIVATE WORLD KNOWLEDGE (protocol §2, §8.2; daemon spec §3).
//
// v0.9: the recipe TABLE lives in the world definition (engine spec §2.4)
// and rides on the world object; this module is the engine machinery that
// reads it. The containment rule moved with the table: neither this module
// nor the definition may be imported by anything under api/, and no recipe
// may reach /scenario, an observation, or any other client-visible response.
// The containment test greps the import graph; the only sanctioned leak is a
// build shortfall, formatted here, naming ONLY the missing amounts — never
// the full cost, never other forms.

export const recipeFor = (world, form) => world.recipes[form] ?? null;

// The median total material cost across all forms — a single aggregate for
// the construction-slack ratio (daemon spec v0.6 §4). Deliberately not any
// one form's cost: this number may appear in operator-side logs, and an
// aggregate leaks no row of the table.
export function typicalStructureCost(world) {
  const totals = Object.values(world.recipes)
    .map((cost) => Object.values(cost).reduce((s, n) => s + n, 0))
    .sort((a, b) => a - b);
  const mid = totals.length / 2;
  return totals.length % 2 === 1 ? totals[Math.floor(mid)] : (totals[mid - 1] + totals[mid]) / 2;
}

// null when the inventory covers the cost; otherwise a map of ONLY the
// missing amounts. This is the discovery channel and its entire bandwidth.
export function shortfall(world, form, inventory) {
  const cost = world.recipes[form];
  const missing = {};
  for (const [resource, needed] of Object.entries(cost)) {
    const gap = needed - (inventory[resource] ?? 0);
    if (gap > 0) missing[resource] = gap;
  }
  return Object.keys(missing).length > 0 ? missing : null;
}

// "short 2 orrum, 1 khal" — the exact wording of protocol §9.3. Ordered by
// the world's resource list so the phrasing is deterministic.
export function formatShortfall(world, missing) {
  const parts = world.resourceTypes.filter((r) => missing[r]).map((r) => `${missing[r]} ${r}`);
  return `short ${parts.join(", ")}`;
}

// Materials are consumed only on success, by the resolver, through this.
export function consumeMaterials(world, form, inventory) {
  for (const [resource, needed] of Object.entries(world.recipes[form])) {
    inventory[resource] -= needed;
  }
}

// v0.4 build resolution with byproduct substitution (protocol §8.2, daemon
// spec §3.5). The world's byproduct covers a gap in the resource it declares
// it substitutes for, at its declared ratio, automatically — and the
// substitution is reported ONLY on success. The failure branch computes the
// shortfall from primary materials alone — the byproduct never enters a
// failure message, because a helpful failure would hand agents the discovery.
export function buildPlan(world, form, inventory) {
  const recipe = world.recipes[form];
  const missing = shortfall(world, form, inventory);
  if (missing === null) {
    return { ok: true, consume: { ...recipe }, substitution: null };
  }
  const byproduct = world.byproduct;
  if (byproduct) {
    const target = byproduct.substitutesFor;
    const targetGap = missing[target] ?? 0;
    const onlyTargetMissing = Object.keys(missing).every((r) => r === target);
    const byproductNeeded = targetGap * byproduct.ratio;
    if (onlyTargetMissing && targetGap > 0 && (inventory[byproduct.name] ?? 0) >= byproductNeeded) {
      const consume = { ...recipe, [target]: recipe[target] - targetGap, [byproduct.name]: byproductNeeded };
      return {
        ok: true,
        consume,
        substitution: { byproduct: byproduct.name, byproductAmount: byproductNeeded, target, targetAmount: targetGap },
      };
    }
  }
  return { ok: false, missing };
}

// Consume the exact amounts a successful buildPlan chose.
export function consumePlan(consume, inventory) {
  for (const [resource, amount] of Object.entries(consume)) {
    if (amount > 0) inventory[resource] -= amount;
  }
}
