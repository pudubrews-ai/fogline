// PRIVATE WORLD KNOWLEDGE (protocol §2, §8.2; daemon spec §3).
//
// This module is the recipe table. It MUST NOT be imported by anything under
// api/, and no recipe may reach /scenario, an observation, or any other
// client-visible response. The containment test greps the import graph; the
// only sanctioned leak is a build shortfall, formatted here, naming ONLY the
// missing amounts — never the full cost, never other forms.

import { RESOURCE_TYPES } from "./resources.js";

const RECIPES = Object.freeze({
  marker: Object.freeze({ orrum: 1 }),
  wall: Object.freeze({ orrum: 3, khal: 1 }),
  platform: Object.freeze({ orrum: 4, khal: 1 }),
  pit: Object.freeze({ orrum: 1, khal: 2 }),
  hut: Object.freeze({ orrum: 5, khal: 2 }),
  tower: Object.freeze({ orrum: 8, khal: 3 }),
});

export const recipeFor = (form) => RECIPES[form] ?? null;

// The median total material cost across all forms — a single aggregate for
// the construction-slack ratio (daemon spec v0.6 §4). Deliberately not any
// one form's cost: this number may appear in operator-side logs, and an
// aggregate leaks no row of the table.
export function typicalStructureCost() {
  const totals = Object.values(RECIPES)
    .map((cost) => Object.values(cost).reduce((s, n) => s + n, 0))
    .sort((a, b) => a - b);
  const mid = totals.length / 2;
  return totals.length % 2 === 1 ? totals[Math.floor(mid)] : (totals[mid - 1] + totals[mid]) / 2;
}

// null when the inventory covers the cost; otherwise a map of ONLY the
// missing amounts. This is the discovery channel and its entire bandwidth.
export function shortfall(form, inventory) {
  const cost = RECIPES[form];
  const missing = {};
  for (const [resource, needed] of Object.entries(cost)) {
    const gap = needed - (inventory[resource] ?? 0);
    if (gap > 0) missing[resource] = gap;
  }
  return Object.keys(missing).length > 0 ? missing : null;
}

// "short 2 orrum, 1 khal" — the exact wording of protocol §9.3.
export function formatShortfall(missing) {
  const parts = RESOURCE_TYPES.filter((r) => missing[r]).map((r) => `${missing[r]} ${r}`);
  return `short ${parts.join(", ")}`;
}

// Materials are consumed only on success, by the resolver, through this.
export function consumeMaterials(form, inventory) {
  for (const [resource, needed] of Object.entries(RECIPES[form])) {
    inventory[resource] -= needed;
  }
}

// v0.4 build resolution with rubble substitution (protocol §8.2, daemon spec
// §3.5). Rubble covers an orrum gap at rubbleRatio, automatically, and the
// substitution is reported ONLY on success. The failure branch computes the
// shortfall from primary materials alone — rubble never enters a failure
// message, because a helpful failure would hand agents the discovery.
export function buildPlan(form, inventory, rubbleRatio) {
  const missing = shortfall(form, inventory);
  if (missing === null) {
    return { ok: true, consume: { ...RECIPES[form] }, substitution: null };
  }
  const orrumGap = missing.orrum ?? 0;
  const onlyOrrumMissing = Object.keys(missing).every((r) => r === "orrum");
  const rubbleNeeded = orrumGap * rubbleRatio;
  if (onlyOrrumMissing && orrumGap > 0 && (inventory.rubble ?? 0) >= rubbleNeeded) {
    const consume = { ...RECIPES[form], orrum: RECIPES[form].orrum - orrumGap, rubble: rubbleNeeded };
    return { ok: true, consume, substitution: { rubble: rubbleNeeded, orrum: orrumGap } };
  }
  return { ok: false, missing };
}

// Consume the exact amounts a successful buildPlan chose.
export function consumePlan(consume, inventory) {
  for (const [resource, amount] of Object.entries(consume)) {
    if (amount > 0) inventory[resource] -= amount;
  }
}
