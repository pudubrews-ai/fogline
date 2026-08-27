// Destruction (protocol §9, daemon spec §3): demolish progress, raze, rubble
// yield. Actorship is recorded in structure history and the operator log
// ONLY — it never reaches an observation, exactly like corpse cause.

import { addLoose } from "./resources.js";

export const DESTRUCTION_DEFAULTS = {
  demolishTicks: 3,
  razeCost: 12,
  rubbleYieldDemolish: 6,
  rubbleYieldRaze: 2,
  rubbleRatio: 3, // 3 rubble substitute for 1 orrum (recipes.buildPlan)
};

export const destructionConfig = (config) => ({
  ...DESTRUCTION_DEFAULTS,
  ...(config.destruction ?? {}),
});

// One consecutive demolish tick by one agent. Returns:
//   {progressed: {ticks, required}}          — progress advanced, structure stands
//   {completed: {form, name, inscription}}   — structure removed this tick
// A different agent's demolish replaces the progress record and starts at one
// (daemon spec §3.1).
export function applyDemolishTick(world, cell, agentId, tick) {
  const structure = cell.structure;
  const dc = world.destruction;
  const prior = structure.demolishProgress;
  const ticks = prior && prior.agentId === agentId ? prior.ticks + 1 : 1;

  if (ticks < dc.demolishTicks) {
    structure.demolishProgress = { agentId, ticks, required: dc.demolishTicks };
    structure.history.push({ agentId, tick, action: "demolish" });
    return { progressed: { ticks, required: dc.demolishTicks } };
  }

  // Completion: full rubble, and the inscription entries survive as a
  // fragment attached to the loose pile, attribution intact (v0.6 A9).
  const entries = structure.inscription?.entries ?? [];
  const removed = {
    form: structure.form,
    name: structure.authored.name,
    inscription: entries.length > 0 ? entries.map((e) => ({ ...e })) : null,
  };
  structure.history.push({ agentId, tick, action: "demolish" });
  addLoose(cell, { rubble: dc.rubbleYieldDemolish });
  if (removed.inscription !== null) {
    cell.fragment = { entries: removed.inscription };
  }
  cell.structure = null;
  return { completed: removed };
}

// Raze: one tick, vitality already paid by the resolver. Less rubble, and
// every inscription entry is destroyed entirely — no fragment. Raze is the
// ONLY erasure in the world (v0.6 A9.2): book-burning is total, expensive,
// and the only route.
export function applyRaze(world, cell, agentId, tick) {
  const structure = cell.structure;
  const dc = world.destruction;
  const removed = {
    form: structure.form,
    name: structure.authored.name,
    inscriptionDestroyed: (structure.inscription?.entries.length ?? 0) > 0,
  };
  structure.history.push({ agentId, tick, action: "raze" });
  addLoose(cell, { rubble: dc.rubbleYieldRaze });
  cell.structure = null;
  return removed;
}

// Silent reset (daemon spec §3.1): progress survives only when its agent
// submitted demolish on this structure again this tick. Any other action,
// leaving the cell, a missed tick, or death breaks the chain — the structure
// simply shows zero again.
export function sweepStalledDemolitions(world, sustainedBy) {
  for (const cell of world.cells.values()) {
    const progress = cell.structure?.demolishProgress;
    if (!progress) continue;
    if (sustainedBy.get(cell.coord) !== progress.agentId) {
      cell.structure.demolishProgress = null;
    }
  }
}
