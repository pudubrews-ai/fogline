// Operator channel: /observatory/* and /control. Out of protocol contract,
// fully omniscient (private objectives visible by default), and unreachable
// with an agent token (protocol §14).

import { existsSync, readFileSync } from "node:fs";
import { Router, json } from "express";
import { sustenanceBand, vitalityBand } from "../world/vitals.js";

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function serializeCell(cell) {
  return {
    coord: cell.coord,
    deposit: cell.deposit ? { ...cell.deposit } : null,
    loose: cell.loose ? { ...cell.loose } : null,
    corpses: cell.corpses.map((c) => ({
      authored: { ...c.authored },
      appearance: { ...c.appearance },
      diedAtTick: c.diedAtTick,
      causeAgentId: c.causeAgentId,
    })),
    structure: cell.structure
      ? {
          form: cell.structure.form ?? null,
          authored: { ...cell.structure.authored },
          // Entries with authorId included: this realm is omniscient.
          inscription: cell.structure.inscription
            ? {
                entries: cell.structure.inscription.entries.map((e) => ({ ...e })),
                charactersUsed: cell.structure.inscription.charactersUsed,
              }
            : null,
          demolishProgress: cell.structure.demolishProgress ? { ...cell.structure.demolishProgress } : null,
          builtAtTick: cell.structure.history[0]?.tick ?? null,
          history: cell.structure.history.map((h) => ({ ...h })),
        }
      : null,
    fragment: cell.fragment ? structuredClone(cell.fragment) : null,
  };
}

function serializeBody(body, worldRef) {
  return {
    id: body.id,
    persona: body.persona
      ? {
          name: body.persona.name,
          appearance: { ...body.appearance },
          disposition: body.persona.disposition,
          identity: body.persona.identity,
          discoverable: body.persona.discoverable,
          privateObjective: body.persona.privateObjective,
        }
      : null, // infants and matured-but-unclaimed bodies have no persona
    appearance: { ...body.appearance },
    coord: body.coord,
    // Raw values are operator-realm only; agents see bands (protocol §7).
    vitality: body.vitality,
    sustenance: body.sustenance,
    vitalityBand: vitalityBand(body.vitality, worldRef.vitals),
    sustenanceBand: sustenanceBand(body.sustenance, worldRef.vitals),
    inventory: { ...body.inventory },
    lifeStage: body.lifeStage,
    bornAtTick: body.bornAtTick,
    sponsorId: body.sponsorId,
    unsponsoredAtTick: body.unsponsoredAtTick,
    heritage: body.heritage ? structuredClone(body.heritage) : null,
    currentIntent: body.currentIntent,
    lastReason: body.lastReason,
    lastActionOutcome: body.lastActionOutcome,
    reflectionRequested: body.reflectionRequested,
    importanceSinceLastReflection: body.importanceSinceLastReflection,
    knownCells: [...body.knownCells.entries()].map(([coord, known]) => ({
      coord,
      structure: known.structureSnapshot
        ? { form: known.structureSnapshot.form ?? null, authored: { ...known.structureSnapshot.authored } }
        : null,
      lastSeenTick: known.lastSeenTick,
    })),
    memories: body.memories.map((m) => ({
      id: m.id,
      tick: m.tick,
      simTime: m.simTime,
      type: m.type,
      text: m.text,
      importance: m.importance,
      speaker: m.speaker,
      speakerName: m.speakerName,
    })),
    connection: {
      state: body.connection.state,
      clientName: body.connection.clientName,
      modelHint: body.connection.modelHint,
      surface: body.connection.surface ?? null,
      consecutiveMisses: body.connection.consecutiveMisses,
      lastActionLatencyMs: body.connection.lastActionLatencyMs,
      unmannedSinceTick: body.connection.unmannedSinceTick,
      // token deliberately omitted — the operator view never needs it
    },
    // Client-reported status enum (v0.6 A8): operator realm only.
    clientStatus: body.clientStatus ?? null,
  };
}

export function createOperatorRouter({ engine, auth, config, archive = null, crosscheck = null }) {
  const router = Router();
  router.use(json());
  // CORS on the operator surface only (daemon spec §4.1): the observatory is
  // a separate origin now. Before auth, so preflights answer without a token.
  router.use(["/observatory", "/control"], (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  router.use(auth.operatorAuth);

  const clients = new Set();

  function snapshot() {
    return {
      tick: engine.tick,
      phase: engine.phase,
      simTime: engine.simTime,
      deadline: engine.deadline,
      paused: engine.paused,
      stopped: engine.stopped,
      waitingForAgents: engine.waitingForAgents,
      speed: engine.speed,
      maxTicks: config.maxTicks,
      minAgents: config.minAgents,
      premise: config.premise,
      gridSize: engine.world.gridSize,
      slots: { ...engine.world.slots },
      cells: [...engine.world.cells.values()].map(serializeCell),
      agents: [...engine.world.agents.values()].map((b) => serializeBody(b, engine.world)),
      runId: engine.runId,
      // Boot viability and cumulative per-surface call counts: the operator
      // realm's copies of what /scenario and the tick records carry, so the
      // observatory needs no cross-realm fetch.
      viability: { ...engine.viability },
      constructionSlack: engine.constructionSlack ? { ...engine.constructionSlack } : null,
      inscriptionMax: engine.world.inscriptionMax,
      spend: [...(engine._surfaceCalls ?? new Map())]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([surface, callsTotal]) => ({ surface, callsTotal })),
      // Crosscheck supervision state (daemon spec v0.8 §3.2a): idle, running
      // with elapsed time, done with the report path, failed, or timed_out.
      // Without this, a run finishing at 2am with a crosscheck silently dead
      // is indistinguishable from one where it never started.
      crosscheck: crosscheck ? crosscheck.status() : null,
    };
  }

  // Full world state as a plain fetch (daemon spec §4.2): reconnect must not
  // depend on SSE replay semantics.
  router.get("/observatory/snapshot", (req, res) => {
    res.json(snapshot());
  });

  router.get("/observatory/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseWrite(res, "snapshot", snapshot());
    clients.add(res);
    // SSE keep-alive (daemon spec v0.6 §7), same as the agent stream.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), config.sseKeepAliveMs ?? 25000);
    keepAlive.unref?.();
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  });

  router.get("/observatory/agent/:id", (req, res) => {
    const body = engine.world.agents.get(req.params.id);
    if (!body) {
      res.status(404).json({ error: "NO_SUCH_AGENT" });
      return;
    }
    res.json(serializeBody(body, engine.world));
  });

  // The run archive, read-only over the operator realm (daemon spec v0.8
  // §2.4): written by the daemon, read by the observatory, reachable by no
  // agent route — agent tokens are rejected by operatorAuth above, and the
  // agent router mounts no path under /observatory. GETs only; nothing here
  // writes, and no route accepts a file path from the client.
  router.get("/observatory/archive/index", (req, res) => {
    if (!archive) {
      res.status(404).json({ error: "NO_ARCHIVE" });
      return;
    }
    res.json(archive.readIndex());
  });

  router.get("/observatory/archive/:runId", (req, res) => {
    const record = archive?.readRecord(req.params.runId);
    if (!record) {
      res.status(404).json({ error: "NO_SUCH_RUN" });
      return;
    }
    res.json(record);
  });

  // The crosscheck report for a run, resolved from the run record's own
  // reportPath — the client names a run, never a path.
  router.get("/observatory/archive/:runId/crosscheck", (req, res) => {
    const record = archive?.readRecord(req.params.runId);
    const reportPath = record?.crosscheck?.reportPath;
    if (!reportPath || !existsSync(reportPath)) {
      res.status(404).json({ error: "NO_CROSSCHECK_REPORT" });
      return;
    }
    try {
      res.json(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch {
      res.status(500).json({ error: "UNREADABLE_REPORT" });
    }
  });

  router.post("/control", (req, res) => {
    const { action, speed } = req.body ?? {};
    if (typeof speed === "number" && speed > 0) engine.setSpeed(speed);
    switch (action) {
      case "play":
        engine.play();
        break;
      case "pause":
        engine.pause();
        break;
      case "step":
        engine.step();
        break;
      case "reset":
        engine.reset();
        break;
      case "extend":
        engine.extend(typeof req.body?.ticks === "number" ? req.body.ticks : 20);
        break;
      default:
        res.status(400).json({ error: "UNKNOWN_CONTROL", detail: "action must be play|pause|step|reset|extend" });
        return;
    }
    res.json({
      ok: true,
      state: {
        tick: engine.tick,
        phase: engine.phase,
        paused: engine.paused,
        stopped: engine.stopped,
        waitingForAgents: engine.waitingForAgents,
        speed: engine.speed,
        maxTicks: config.maxTicks,
      },
    });
  });

  const broadcast = (event, data) => {
    for (const res of clients) sseWrite(res, event, data);
  };
  engine.on("operator", ({ event, data }) => broadcast(event, data));
  engine.on("reset", () => broadcast("snapshot", snapshot()));

  return router;
}
