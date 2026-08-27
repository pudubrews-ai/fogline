// Archive recorder (daemon spec v0.8 §2.3): folds the engine's operator
// stream into a per-run outcome accumulator. Boot material is written the
// moment run_started fires; the outcome summary is written when the run
// stops — at maxTicks (run_complete), or when a reset/operator stop begins
// the next run while this one is still open. A run killed by process death
// writes nothing further, which is exactly how the index learns to mark it
// incomplete.
//
// This module SUBSCRIBES; it never reaches into the engine's tick machinery.

export function attachArchiveRecorder({ engine, archive, config, logs = {}, onRunStopped = () => {} }) {
  let current = null; // accumulator for the open run

  function freshAccumulator(runId, startedAt) {
    return {
      runId,
      startedAt,
      finalTick: 0,
      finalizedAtTick: -1, // last tick an outcome was written at; -1 = never
      lastSimTime: null,
      survivors: [], // rewritten every tick from the record's bodies
      deaths: [], // {tick, agentId, name, cell, cause, foodAtDeath, foodReachable}
      structuresByForm: {},
      inscriptions: [], // {tick, coord, authorName, characters}
      destruction: [], // {tick, type, coord, form, name, agentId}
      actionCounts: {},
    };
  }

  // Re-entrant on purpose: a run that completes at maxTicks, is extended,
  // and completes again writes its outcome twice — the later write, with the
  // extension's ticks, wins. A finalize with nothing new since the last one
  // is a no-op, so run_started after run_complete never relabels endedBy.
  function finalize(endedBy) {
    if (!current || current.finalTick <= current.finalizedAtTick) return;
    const acc = current;
    acc.finalizedAtTick = acc.finalTick;
    const outcome = {
      endedAt: new Date().toISOString(),
      endedBy,
      finalTick: acc.finalTick,
      simTime: acc.lastSimTime,
      survivors: acc.survivors,
      deaths: acc.deaths,
      structuresByForm: acc.structuresByForm,
      inscriptions: acc.inscriptions,
      destruction: acc.destruction,
      actionCounts: acc.actionCounts,
    };
    archive.writeOutcome(acc.runId, outcome);
    onRunStopped(acc.runId, outcome);
  }

  function beginRun(runStarted) {
    // A new run beginning while the previous one is still open IS the
    // previous run stopping: reset and operator stop both land here.
    finalize("reset");
    current = freshAccumulator(runStarted.runId, runStarted.ts);
    archive.writeBoot(runStarted.runId, {
      config,
      viability: engine.viability ? { ...engine.viability } : null,
      constructionSlack: engine.constructionSlack ? { ...engine.constructionSlack } : null,
      runStarted,
      logs,
    });
  }

  engine.on("operator", ({ event, data }) => {
    if (event === "run_started") {
      beginRun(data);
      return;
    }

    if (event === "tick" && current && data.runId === current.runId) {
      current.finalTick = data.tick;
      current.lastSimTime = data.simTime ?? null;
      current.survivors = (data.bodies ?? []).map((b) => ({
        agentId: b.agentId,
        name: b.name,
        lifeStage: b.lifeStage,
        vitality: b.vitality,
        sustenance: b.sustenance,
      }));
      for (const a of data.actions ?? []) {
        current.actionCounts[a.type] = (current.actionCounts[a.type] ?? 0) + 1;
      }
      for (const ev of data.events ?? []) {
        if (ev.type === "death") {
          current.deaths.push({
            tick: ev.tick ?? data.tick,
            agentId: ev.agentId,
            name: ev.name ?? null,
            cell: ev.coord ?? null,
            cause: ev.causeAgentId ? "attack" : "starvation",
            causeAgentId: ev.causeAgentId ?? null,
            foodAtDeath: ev.foodAtDeath ?? null,
            foodReachable: ev.foodReachable ?? null,
          });
        } else if (ev.type === "build") {
          const form = ev.form ?? "unknown";
          current.structuresByForm[form] = (current.structuresByForm[form] ?? 0) + 1;
        } else if (ev.type === "inscribe") {
          current.inscriptions.push({
            tick: ev.tick ?? data.tick,
            coord: ev.coord ?? null,
            authorName: ev.authorName ?? null,
            characters: (ev.text ?? "").length,
          });
        } else if (ev.type === "raze" || ev.type === "demolish_complete") {
          current.destruction.push({
            tick: ev.tick ?? data.tick,
            type: ev.type,
            coord: ev.coord ?? null,
            form: ev.form ?? null,
            name: ev.name ?? null,
            agentId: ev.agentId ?? null,
          });
        }
      }
      return;
    }

    // The hard stop at maxTicks: the run is over, the daemon keeps serving.
    if (event === "barrier" && data?.event === "run_complete") {
      finalize("max_ticks");
    }
  });

  // The engine boots its first run in its constructor, before anything can
  // subscribe — catch up from the retained record so run one is archived too.
  if (engine.lastRunStarted) beginRun(engine.lastRunStarted);

  return {
    // Exposed for shutdown: a daemon closed mid-run records what it has,
    // so an orderly stop is never mistaken for a crash.
    finalizeOpenRun(endedBy = "shutdown") {
      finalize(endedBy);
    },
  };
}
