// THE FOG BOUNDARY (daemon spec §11, protocol §15).
// This file is the access control boundary. It enforces four independent fogs:
//   Spatial      — `present`, `heard`, `deposit`, `loose`, `corpses`, and
//                  `structure` are same-cell only; `exits` gives coordinates,
//                  never contents.
//   Cartographic — `knownCells` contains only cells this agent has occupied,
//                  with stale snapshots (inscriptions included) preserved,
//                  never silently refreshed.
//   Persona      — `present` carries the observable tier only: name,
//                  appearance, disposition. Never identity, discoverable,
//                  privateObjective, or reason.
//   Condition    — `present` carries BANDS only. No other agent's raw
//                  vitality, sustenance, or inventory, ever. What someone is
//                  carrying is unknowable except by being told.
// It reads ONLY: the agent's own body, its own memory stream, its own map,
// the live cell it stands in, and the observable tier of co-located agents.
// There is no global transcript in world/ to read from, no global agent-vitals
// object, and knownCells is per-agent state — never a view onto the global
// cell map. Adding a field to the returned object is a security decision.

import { retrieve, displayText } from "./memory.js";
import { exitsFor } from "./world.js";
import { depositView, looseView } from "./resources.js";
import { sustenanceBand, vitalityBand } from "./vitals.js";
import { inscriptionView, fragmentView } from "./inscription.js";

export const PROTOCOL_VERSION = "0.4";

// Agent-authored structure text is nested under `authored` (protocol §17).
// History is world bookkeeping and stays out of observations entirely —
// destruction actorship travels the same operator-only channel as corpse
// cause. Inscriptions ride along as ordered entry lists (v0.6 A9.4) with
// authorName and tick in-world — the deliberate opacity exception — and
// the budget state, so an agent can see a wall is nearly full. authorId
// and entry ids never cross this boundary. In the live cell entries are
// current; in knownCells they are snapshots and stay stale (protocol §8.3).
// demolishProgress appears ONLY in the live cell (protocol §9.2): anyone
// present sees how far along a demolition is, never who is driving it.
function structureView(structure, inscriptionMax, { withProgress = false } = {}) {
  if (!structure) return null;
  return {
    form: structure.form ?? null,
    authored: {
      name: structure.authored.name,
      description: structure.authored.description,
    },
    inscription: inscriptionView(structure, inscriptionMax),
    ...(withProgress
      ? {
          demolishProgress: structure.demolishProgress
            ? { ticks: structure.demolishProgress.ticks, required: structure.demolishProgress.required }
            : null,
        }
      : {}),
  };
}

export function buildObservation(world, agentId, tick, { simTime, deadline, retrievalK, situation = null }) {
  const body = world.agents.get(agentId);
  const cell = world.cells.get(body.coord);

  // Persona fog: observable tier only, and never the self. Condition fog:
  // BANDS, derived here and never stored — an observer sees that someone is
  // failing, never that they are at 7 (protocol §7). Infants have no persona:
  // name and disposition are null, and their dependencyState is the distress
  // signal that makes fostering possible — perceivable only from this cell.
  const present = [];
  for (const other of world.agents.values()) {
    if (other.id !== agentId && other.coord === body.coord) {
      present.push({
        agentId: other.id,
        authored: {
          name: other.persona?.name ?? null,
          appearance: { ...other.appearance },
          disposition: other.persona?.disposition ?? null,
        },
        vitalityBand: vitalityBand(other.vitality, world.vitals),
        sustenanceBand: sustenanceBand(other.sustenance, world.vitals),
        lifeStage: other.lifeStage,
        dependencyState:
          other.lifeStage === "infant" ? (other.sponsorId !== null ? "sponsored" : "unsponsored") : null,
      });
    }
  }

  // `heard` comes from this agent's own speech memories — speech is only ever
  // written to agents who were in the speaker's cell at that tick's OPEN, so
  // the agent's own stream is the complete and only source.
  const heard = [];
  const surfacedIds = new Set();
  for (const entry of body.memories) {
    if (entry.type === "speech" && entry.tick === tick - 1) {
      heard.push({ speakerId: entry.speaker, authored: { text: entry.text }, simTime: entry.simTime });
      surfacedIds.add(entry.id);
    }
    // This tick's perceptions are already visible as cell/present; don't
    // echo them back through `recalled`.
    if (entry.tick === tick) surfacedIds.add(entry.id);
  }

  const query = [
    body.currentIntent ?? "",
    body.coord,
    cell.structure?.authored.name ?? "",
    ...present.map((p) => p.authored.name),
  ].join(" ");
  const recalled = retrieve(body, query, tick, retrievalK, { excludeIds: surfacedIds }).map(
    (entry) => ({ text: displayText(entry, agentId), simTime: entry.simTime, type: entry.type })
  );

  // Cartographic fog: the agent's own snapshots, exactly as taken. The
  // snapshot for the current cell was refreshed at last RESOLVED, so it is
  // current; every other entry may be stale, and stays stale.
  const knownCells = [];
  for (const [coord, known] of body.knownCells) {
    knownCells.push({
      coord,
      structure: structureView(known.structureSnapshot, world.inscriptionMax),
      lastSeenTick: known.lastSeenTick,
    });
  }

  return {
    protocol: PROTOCOL_VERSION,
    tick,
    simTime,
    deadline,
    self: {
      agentId: body.id,
      authored: {
        name: body.persona.name,
        appearance: { ...body.appearance },
        disposition: body.persona.disposition,
        identity: body.persona.identity,
        discoverable: body.persona.discoverable,
        privateObjective: body.persona.privateObjective,
      },
      // Raw values appear ONLY here, on the self. Everyone else gets bands.
      inventory: { ...body.inventory },
      sustenance: body.sustenance,
      vitality: body.vitality,
      // vitalityTrend (v0.7 A2): the direction of this body's last upkeep,
      // derived here from the raw delta — never stored as a string, never
      // present for any other agent. The state is perceivable; the mechanic
      // (threshold, rate) is not, and must never be exposed or derivable.
      vitalityTrend:
        body.lastUpkeepVitalityDelta > 0
          ? "recovering"
          : body.lastUpkeepVitalityDelta < 0
            ? "falling"
            : "holding",
      lifeStage: body.lifeStage,
      sponsoring: sponsoringView(world, body),
      heritage: body.heritage ? structuredClone(body.heritage) : null,
      currentIntent: body.currentIntent,
      // On a failure, `attempts` counts THIS agent's identical prior
      // failures (v0.6 A7) — its own record, read from its own body and
      // nowhere else. Without it every attempt is the first attempt.
      lastActionOutcome: body.lastActionOutcome ? { ...body.lastActionOutcome } : null,
      // The non-trivial failure history itself (A7 as corrected by v0.7.1):
      // the record persists on the body, so it reaches the prompt whenever
      // the agent is contemplating, not only on the tick after a failure —
      // an interleaved success must not hide an accumulated record. Entries
      // with a single failure stay out (the plain failure line covers them),
      // and the key is OMITTED when there is nothing to tell, so an agent
      // with no history carries no trace of the field. Self-only, always.
      ...(() => {
        const history = body.failedAttempts
          .filter((f) => f.count > 1)
          .map(({ type, detail, why, count }) => ({ type, detail, why, count }));
        return history.length > 0 ? { failedAttempts: history } : {};
      })(),
    },
    cell: {
      coord: cell.coord,
      // Deposits, loose piles, and corpses are perceivable only from within
      // the cell (protocol §15). Corpses carry no cause: who did it is known
      // only to witnesses, and only as memory.
      deposit: depositView(cell),
      loose: looseView(cell),
      structure: structureView(cell.structure, world.inscriptionMax, { withProgress: true }),
      // A demolition's surviving inscription, riding on the rubble pile —
      // the entries with their attribution intact (v0.6 A9).
      fragment: cell.fragment ? fragmentView(cell.fragment) : null,
      corpses: cell.corpses.map((c) => ({
        authored: { name: c.authored.name },
        appearance: { ...c.appearance },
        diedAtTick: c.diedAtTick,
      })),
      // Exits list in-bounds coordinates only — never what is in them.
      exits: exitsFor(world, body.coord),
    },
    present,
    heard,
    recalled,
    knownCells,
    situationChanged: situation ? situation.situationChanged : true,
    ...(situation && situation.attentionGranted !== undefined
      ? { attentionGranted: situation.attentionGranted }
      : {}),
    reflectionRequested: body.reflectionRequested === true,
  };
}

// The agent's own dependents, by id and age — the cost it is carrying.
function sponsoringView(world, body) {
  const out = [];
  for (const other of world.agents.values()) {
    if (other.sponsorId === body.id) out.push({ agentId: other.id, bornAtTick: other.bornAtTick });
  }
  return out;
}
