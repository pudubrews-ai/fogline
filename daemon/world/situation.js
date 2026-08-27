// situationChanged (protocol §12, daemon spec §10): the largest cost lever
// in the system. Computed by diffing a per-agent snapshot of the previous
// tick against the current one. A genuinely static tick MUST report false —
// if this flag is wrong in the true direction it silently burns money and
// nothing looks broken, which is why the false case has a dedicated test.
//
// On arrival: entering a cell is a change worth waking for only when the
// cell holds something perceivable (deposit, loose pile, structure, corpse).
// The protocol's §12.2 rationale is explicit that an agent alone, continuing
// a stated intent across empty ground, should not cost a model call — an
// unconditional arrived-trigger would make every tick of travel "changed"
// and delete the lever. Co-arrivals are caught by the present-set trigger.

import { sustenanceBand, vitalityBand } from "./vitals.js";

// Rubble rides `loose`, so arriving on a rubble pile triggers via the loose
// check (protocol §13.1 names rubble explicitly; here it is just a resource).
function cellHasNews(cell) {
  return (
    (cell.deposit !== null && cell.deposit.quantity >= 1) ||
    (cell.loose !== null && Object.values(cell.loose).some((n) => n > 0)) ||
    cell.structure !== null ||
    cell.corpses.length > 0 ||
    cell.fragment !== null
  );
}

// Runs once per tick at OPEN, after perceptions and the reflection flag are
// set, before observations are built. Returns Map<agentId, {situationChanged,
// attentionGranted?}> and updates each body's snapshot in place.
export function computeSituations(world, tick, { attentionBudget = null } = {}) {
  const result = new Map();

  for (const body of world.agents.values()) {
    if (body.lifeStage === "infant" || body.persona === null) continue; // no observation, no situation
    const cell = world.cells.get(body.coord);
    const presentIds = [];
    for (const other of world.agents.values()) {
      if (other !== body && other.coord === body.coord) presentIds.push(other.id);
    }
    const current = {
      coord: body.coord,
      present: presentIds.sort().join(","),
      vitalityBand: vitalityBand(body.vitality, world.vitals),
      sustenanceBand: sustenanceBand(body.sustenance, world.vitals),
      // Demolish progress on the structure here (protocol §13.1): a change —
      // including a silent reset or the structure vanishing — is news.
      demolishTicks: cell.structure?.demolishProgress?.ticks ?? null,
    };
    const prev = body.situationPrev;
    const heardSpeech = body.memories.some(
      (m) => m.type === "speech" && m.tick === tick - 1 && m.speaker !== body.id
    );
    const situationChanged =
      prev == null || // first observation ever: everything is new
      prev.present !== current.present ||
      heardSpeech ||
      body.firstReadTick === tick || // an inscription read for the first time
      body.lastActionOutcome?.result === "failed" ||
      (prev.coord !== current.coord && cellHasNews(cell)) ||
      (prev.coord === current.coord && prev.demolishTicks !== current.demolishTicks) ||
      prev.vitalityBand !== current.vitalityBand ||
      prev.sustenanceBand !== current.sustenanceBand ||
      body.eventTick === tick - 1 || // death, birth, or attack in the cell
      body.reflectionRequested === true;

    body.situationPrev = current;
    result.set(body.id, { situationChanged });
  }

  // attentionGranted (protocol §12.3): changed situations first, then the
  // longest-ungranted fill the rest. A ceiling of last resort, not a scheduler.
  if (attentionBudget != null) {
    const starved = (a, b) =>
      (world.agents.get(a).lastAttentionTick ?? 0) - (world.agents.get(b).lastAttentionTick ?? 0) ||
      (a < b ? -1 : 1);
    const ids = [...result.keys()];
    const granted = new Set(
      ids.filter((id) => result.get(id).situationChanged).sort(starved).slice(0, attentionBudget)
    );
    for (const id of ids.filter((id) => !result.get(id).situationChanged).sort(starved)) {
      if (granted.size >= attentionBudget) break;
      granted.add(id);
    }
    for (const id of ids) {
      result.get(id).attentionGranted = granted.has(id);
      if (granted.has(id)) world.agents.get(id).lastAttentionTick = tick;
    }
  }

  return result;
}
