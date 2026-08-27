// Analyst context assembly (observatory spec v0.8 §2.6): retrieval, not the
// whole log — the same treatment the agents got. Current state in full
// (small, always relevant); history by keyword retrieval with a bounded
// window around matches; archive SUMMARIES before archive logs — a
// cross-run question should be answerable from the indexed outcome
// summaries without opening a ticks.log.
//
// The reducer is the source: everything here reads the folded state, never
// a log file. Private objectives are included ONLY when the operator's
// toggle says so — settled at build time as default OFF, so by default the
// analyst describes behaviour and the interpretation stays with the
// operator.

const terms = (question) =>
  String(question ?? "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2);

// ---------- current state, in full ----------

export function summarizeCurrentState(state, { includeObjectives = false } = {}) {
  if (!state || !state.runId) return "No run is loaded.";
  const lines = [];
  lines.push(
    `Run ${state.runId}, tick ${state.tick}${state.maxTicks ? ` of ${state.maxTicks}` : ""}, sim time ${state.simTime ?? "?"}. ` +
      `Population ${state.agents.size}${state.slots ? ` of ${state.slots.total} slots` : ""}.`
  );
  if (state.viability) {
    const v = state.viability;
    lines.push(
      `Boot arithmetic: ratio ${v.ratio?.toFixed?.(2)}, capacity ${v.capacity?.toFixed?.(2)}, ` +
        `${v.deathsRequired ?? 0} deaths structurally required over ${v.expectedAgents} expected agents.`
    );
  }
  for (const a of state.agents.values()) {
    const persona = state.personas.get(a.agentId);
    lines.push(
      `- ${a.name ?? a.agentId} at ${a.coord}: vitality ${a.vitality}, sustenance ${a.sustenance}, ` +
        `carrying ${Object.entries(a.inventory)
          .filter(([, n]) => n > 0)
          .map(([r, n]) => `${n} ${r}`)
          .join(", ") || "nothing"}, connection ${a.connectionState ?? "?"}` +
        (a.currentIntent ? `, intent: ${a.currentIntent}` : "") +
        (includeObjectives && a.lastReason ? `, reason: ${a.lastReason}` : "") +
        (includeObjectives && persona?.privateObjective ? `, private objective: ${persona.privateObjective}` : "")
    );
  }
  const structures = [];
  for (const cell of state.cells.values()) {
    if (cell.structure) {
      structures.push(
        `- "${cell.structure.authored.name}" (${cell.structure.form ?? "?"}) at ${cell.coord}` +
          (cell.structure.inscription?.entries?.length
            ? `, ${cell.structure.inscription.entries.length} inscription entries`
            : "")
      );
    }
  }
  if (structures.length > 0) lines.push("Structures:", ...structures);
  for (const [id, d] of state.departed) {
    if (d.diedAtTick != null) {
      lines.push(`- departed: ${d.name ?? id} died at tick ${d.diedAtTick}` + (d.foodAtDeath ? ` (foodAtDeath ${d.foodAtDeath})` : ""));
    }
  }
  return lines.join("\n");
}

// ---------- history, by retrieval ----------

export function retrieveHistory(state, question, { k = 8, window = 2 } = {}) {
  const qs = terms(question);
  if (!state?.events?.length || qs.length === 0) return [];
  const scored = state.events
    .map((ev, i) => {
      const text = JSON.stringify(ev).toLowerCase();
      const score = qs.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      return { ev, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, k);
  // A bounded window of surrounding ticks per match, deduplicated, in order.
  const keep = new Set();
  for (const { ev } of scored) {
    for (const [i, other] of state.events.entries()) {
      if (other.tick != null && ev.tick != null && Math.abs(other.tick - ev.tick) <= window) keep.add(i);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => state.events[i]);
}

// Memory streams matching the question, per agent, bounded.
export function retrieveMemories(state, question, { k = 6 } = {}) {
  const qs = terms(question);
  if (qs.length === 0) return [];
  const hits = [];
  for (const a of state?.agents?.values() ?? []) {
    for (const m of a.memories ?? []) {
      const text = (m.text ?? "").toLowerCase();
      const score = qs.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      if (score > 0) hits.push({ agent: a.name ?? a.agentId, m, score });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || b.m.tick - a.m.tick)
    .slice(0, k)
    .map((h) => `[tick ${h.m.tick}] ${h.agent} (${h.m.type}): ${h.m.text}`);
}

// ---------- the archive, summaries first (§2.6) ----------

// Cross-run context from the INDEX alone. This function receives index
// entries and nothing else — it cannot open a ticks.log, which is the
// structural half of spec test 2.
export function summarizeArchive(index) {
  const runs = index?.runs ?? [];
  if (runs.length === 0) return "The archive holds no runs.";
  const lines = [`The archive holds ${runs.length} runs:`];
  for (const r of runs) {
    lines.push(
      `- ${r.runId}${r.configName ? ` "${r.configName}"` : ""}: ` +
        (r.complete
          ? `${r.finalTick} ticks (${r.endedBy}), ${r.survivors} survivors, ${r.deaths} deaths, ` +
            `${r.structuresBuilt} structures, ${r.inscriptions} inscriptions`
          : `INCOMPLETE — boot recorded, no outcome`) +
        (r.viabilityRatio != null
          ? `; boot ratio ${r.viabilityRatio.toFixed(2)}, capacity ${r.capacity?.toFixed?.(2)}, ${r.deathsRequired} deaths required`
          : "") +
        (r.crosscheck ? `; crosscheck ${r.crosscheck.status}` : "")
    );
  }
  return lines.join("\n");
}

// ---------- one context for one question ----------

export function buildContext(question, { state = null, index = null, includeObjectives = false } = {}) {
  const parts = [];
  parts.push("== CURRENT RUN ==", summarizeCurrentState(state, { includeObjectives }));
  const events = retrieveHistory(state, question);
  if (events.length > 0) {
    parts.push(
      "== RETRIEVED HISTORY (events matching the question, with surrounding ticks) ==",
      ...events.map((ev) => JSON.stringify(ev))
    );
  }
  const memories = retrieveMemories(state, question);
  if (memories.length > 0 && includeObjectives) {
    // Memory streams carry agents' inner narration; they follow the same
    // toggle as objectives — off means the analyst sees behaviour, not minds.
    parts.push("== RETRIEVED MEMORIES ==", ...memories);
  }
  if (index) parts.push("== RUN ARCHIVE (indexed summaries) ==", summarizeArchive(index));
  return parts.join("\n");
}
