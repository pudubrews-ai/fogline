// Cheap ticks (protocol v0.3 §12, client spec v0.3 §3). A state machine,
// not a planner: it continues an intent the model already stated, and it
// MUST NOT invent goals. Anything it cannot mechanically continue escalates
// to inference.
//
// The decision state lives in process memory for the life of this client —
// it is the client's own note-to-self about its last decision, not world
// state, and it is never persisted. Losing it (a restart) just means the
// next tick escalates.

import { selfBands } from "./prompt.js";

// Escalation triggers, checked before any continuation. The band triggers
// are non-negotiable: a cheap tick that walks an agent past a starvation
// threshold is the failure mode this whole mechanism exists to avoid.
//   - crossing INTO hungry or hurt (worse than the previous tick's band)
//     escalates that tick, every time, regardless of situationChanged;
//   - starving or failing escalates EVERY tick — survival outranks cost;
//   - an unsponsored infant present escalates every tick it is present:
//     the choice to act or not act on that must be the model's, each tick.
const SUSTENANCE_RANK = { fed: 0, hungry: 1, starving: 2 };
const VITALITY_RANK = { hale: 0, hurt: 1, failing: 2 };

export function escalationReason(observation, state, scenario, config = {}) {
  const bands = selfBands(observation.self, scenario);
  const prev = state.prevBands;

  if (bands.sustenance === "starving") return "sustenance band is starving";
  if (bands.vitality === "failing") return "vitality band is failing";
  if (
    (config.escalateOnHungry ?? true) &&
    prev &&
    SUSTENANCE_RANK[bands.sustenance] > SUSTENANCE_RANK[prev.sustenance]
  ) {
    return `crossed into ${bands.sustenance}`;
  }
  if (
    (config.escalateOnHurt ?? true) &&
    prev &&
    VITALITY_RANK[bands.vitality] > VITALITY_RANK[prev.vitality]
  ) {
    return `crossed into ${bands.vitality}`;
  }
  if ((observation.present ?? []).some((p) => p.lifeStage === "infant" && p.dependencyState === "unsponsored")) {
    return "an unsponsored infant is present";
  }
  if (observation.self.lastActionOutcome?.result === "failed") return "last action failed";

  // Demolish continuation (client spec §4.1): progress on the structure here
  // changes every tick of the work, so situationChanged is true throughout —
  // honestly. The one piece of news that is OUR OWN doing (progress advanced
  // by exactly one, same structure, same company, nothing said) continues
  // cheaply; anything else about the scene escalates. An agent that
  // cheap-continued into anything else would silently abandon its own
  // demolition, which looks like indecision and is actually a client bug.
  if (state.intent?.kind === "demolish") {
    const structure = observation.cell?.structure;
    if (!structure) return "the structure is gone: demolish intent complete or preempted";
    const progress = structure.demolishProgress;
    const expected = (state.demolishSeen ?? 0) + 1;
    if (!progress || progress.ticks !== expected) return "demolish progress reset unexpectedly";
    const here = (observation.present ?? []).map((p) => p.agentId).sort().join(",");
    if (state.prevPresent != null && here !== state.prevPresent) return "company changed mid-demolition";
    if ((observation.heard ?? []).length > 0) return "someone spoke mid-demolition";
    return null; // our own progress is the only news; keep at it
  }

  // attentionGranted === false is the daemon saying "not you, this tick"
  // (protocol §13.3). Respect it when a mechanical continuation exists —
  // it is advice, and it never outranks the survival triggers above.
  if (observation.situationChanged !== false && observation.attentionGranted !== false) {
    return "situation changed";
  }
  if (!state.intent || !state.intent.kind) return "no continuable intent";
  return null; // no reason to think; continue the stated intent
}

// One greedy step toward a coordinate: the exit that most reduces Manhattan
// distance. On an open grid every neighbour is an exit, so greedy is exact;
// if no exit improves the distance, the continuation has run out of road.
function stepToward(cell, target) {
  const [tx, ty] = target.split(",").map(Number);
  const dist = (coord) => {
    const [x, y] = coord.split(",").map(Number);
    return Math.abs(x - tx) + Math.abs(y - ty);
  };
  const here = dist(cell.coord);
  let best = null;
  for (const exit of cell.exits) {
    const d = dist(exit.coord);
    if (d < here && (best === null || d < best.d)) best = { coord: exit.coord, d };
  }
  return best?.coord ?? null;
}

const carried = (inventory) => Object.values(inventory ?? {}).reduce((sum, n) => sum + n, 0);

// Returns {mode: "cheap", action} or {mode: "escalate", reason}. The action
// carries the same fields a parsed model action would; reason strings are
// honest about being mechanical continuations ("reason" is private).
export function continueIntent(observation, state, scenario, config = {}) {
  const reason = escalationReason(observation, state, scenario, config);
  if (reason) return { mode: "escalate", reason };

  const intent = state.intent;
  const base = {
    type: "wait",
    coord: null,
    text: null,
    structure: null,
    target: null,
    resources: null,
    resource: null,
    intent: intent.summary,
    reason: `continuing without thinking: ${intent.summary}`,
    reflections: null,
  };

  if (intent.kind === "travel") {
    if (observation.cell.coord === intent.target) {
      return { mode: "escalate", reason: "arrived: travel intent complete" };
    }
    const next = stepToward(observation.cell, intent.target);
    if (!next) return { mode: "escalate", reason: "no exit brings the target closer" };
    return { mode: "cheap", action: { ...base, type: "move", coord: next } };
  }

  if (intent.kind === "gather") {
    const cell = observation.cell;
    const hasDeposit = cell.deposit != null && cell.deposit.quantity >= 1;
    const hasLoose = cell.loose != null && Object.values(cell.loose).some((n) => n > 0);
    if (!hasDeposit && !hasLoose) return { mode: "escalate", reason: "nothing left here to gather" };
    const carryLimit = scenario?.carryLimit ?? Infinity;
    if (carried(observation.self.inventory) >= carryLimit) {
      return { mode: "escalate", reason: "carrying all you can: gather intent complete" };
    }
    return { mode: "cheap", action: { ...base, type: "gather" } };
  }

  if (intent.kind === "demolish") {
    // escalationReason already verified: structure present, progress is ours
    // and advancing, nobody new, nothing said. The continuation is demolish
    // again — anything else would abandon the work and lose the progress.
    return { mode: "cheap", action: { ...base, type: "demolish" } };
  }

  if (intent.kind === "wait") {
    return { mode: "cheap", action: base };
  }

  // kind "other" (or a stale/unparseable shape): the model asked to think
  // each turn. The §3.2 prose-parsing table falls back to wait here, but
  // with structured intent the model has told us outright that this intent
  // is not mechanical — silently waiting could sit an agent beside its own
  // half-built plan forever. Escalate instead.
  return { mode: "escalate", reason: "intent is not mechanically continuable" };
}
