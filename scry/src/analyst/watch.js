// Watch mode ("standing watch", observatory spec v0.8 §2.4): surfaces
// notable moments unprompted — and rides situationChanged. The daemon
// already computes it per agent and the tick record now carries it; a tick
// where nothing changed for anyone does not need a model call. This is the
// same lever that took the clients from 1.0 calls per tick to 0.05, and
// without it watching a thousand-tick run costs a thirteenth agent's worth
// of inference.

import { isNotable } from "../ticker.js";

// The gate: consult the model only when the tick record says something
// changed for someone, or an event the world classifies as notable landed.
export function shouldConsult(tickRecord) {
  if (!tickRecord) return false;
  const changed = (tickRecord.situations ?? []).some((s) => s.changed === true);
  const notable = (tickRecord.events ?? []).some((ev) => isNotable(ev));
  return changed || notable;
}

// The runner: fold tick records, call the model only past the gate. The
// model call itself is injected (the sidecar's ask function), so tests can
// assert a scripted static stretch produces ZERO calls.
export function createWatch({ ask, onFinding = () => {}, buildPrompt }) {
  let inFlight = false;
  return {
    async onTick(record) {
      if (!shouldConsult(record)) return false;
      if (inFlight) return false; // never stack calls; the next changed tick re-triggers
      inFlight = true;
      try {
        const finding = await ask(buildPrompt(record));
        if (finding) onFinding({ tick: record.tick, finding });
      } finally {
        inFlight = false;
      }
      return true;
    },
  };
}
