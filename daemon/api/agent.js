// The protocol's server half (protocol §7, §13):
//   unauthenticated — GET /scenario, POST /register, POST /attach
//   agent token     — GET /agent/stream, POST /agent/act|leave|release

import { Router, json } from "express";
import {
  claimMaturedBody,
  createAgent,
  nameTaken,
  personaSchema,
  releaseAgent,
  validatePersona,
} from "../world/world.js";
import { attachableBodies } from "../world/lineage.js";
import { PROTOCOL_VERSION } from "../world/observe.js";

// Display order for the actions line — the world's ENABLED actions filter it
// (engine spec v0.9 §3): an action a world does not declare is never
// advertised, exactly as it is never accepted.
const ACTION_DISPLAY_ORDER = [
  "move", "say", "gather", "drop", "give", "consume", "build", "inscribe",
  "attack", "take", "beget", "foster", "demolish", "raze",
];

function rulesFor(world) {
  const actions = ACTION_DISPLAY_ORDER.filter((a) => world.enabledActions.has(a));
  return [
    `one action per tick: ${actions.join(", ")}, or wait`,
    "speech reaches only agents in your cell",
    "build applies to the cell you stand in, if it is empty; each form has a material cost you learn by attempting it",
    "what you carry is bounded by the carry limit; what others carry is unknowable except by being told",
    "you know only cells you have stood in; your map can be stale",
    "the deadline is absolute; a late action is discarded",
  ];
}

// Accept protocol "0.x" for x >= 2. v0.1 clients are rejected outright:
// `join` no longer exists and a v0.1 client cannot function (protocol §2).
function versionOk(protocol) {
  const m = /^0\.(\d+)$/.exec(typeof protocol === "string" ? protocol : "");
  return m !== null && Number(m[1]) >= 2;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createAgentRouter({ engine, auth, config }) {
  const router = Router();
  router.use(json());
  // Malformed JSON body → protocol error, not an HTML error page.
  router.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "INVALID_ACTION", detail: "body is not valid JSON" });
      return;
    }
    next(err);
  });

  const streams = new Map(); // agentId -> SSE response

  function dropStream(agentId) {
    const res = streams.get(agentId);
    if (res) {
      streams.delete(agentId);
      res.end();
    }
  }

  // ---------- unauthenticated: scenario, register, attach ----------

  router.get("/scenario", (req, res) => {
    // Names and forms, never properties or costs (protocol §13.1): what
    // sivet does and what a wall costs are the world's to withhold.
    res.json({
      protocol: PROTOCOL_VERSION,
      premise: engine.world.premise ?? config.premise,
      gridSize: engine.world.gridSize,
      width: engine.world.width,
      height: engine.world.height,
      slots: { ...engine.world.slots },
      resourceNames: [...engine.world.resourceTypes],
      structureForms: [...engine.world.forms],
      // Which actions exist here (engine spec v0.9 §3): names only — how
      // each resolves and what it reveals is the engine's, never stated.
      actions: [...engine.world.enabledActions],
      carryLimit: engine.world.carryLimit,
      sustenanceMax: engine.world.vitals.sustenanceMax,
      vitalityMax: engine.world.vitals.vitalityMax,
      maturityTicks: engine.world.lineage.maturityTicks,
      inscriptionMax: config.inscriptionMax ?? 500,
      attentionBudget: config.attentionBudget ?? null,
      attachable: attachableBodies(engine.world),
      personaSchema: personaSchema(config.genotype?.saturationCeiling),
      // Boot viability (protocol §6.2): the subsistence arithmetic is public.
      // It describes the world's generosity, not its map — no coordinates,
      // no recipes, nothing fogged.
      viability: { ...engine.viability },
      // Construction slack beside viability (daemon spec v0.6 §4): the
      // single number only — the breakdown (which touches the recipe
      // table's aggregate) stays operator-side.
      constructionSlack: engine.constructionSlack?.slack ?? null,
      rules: rulesFor(engine.world),
    });
  });

  router.post("/register", (req, res) => {
    const { protocol, persona, clientName, modelHint, surface } = req.body ?? {};
    // Order of operations matters (daemon spec §4.2):
    // version → slots → persona → name → mint.
    if (!versionOk(protocol)) {
      res.status(400).json({ error: "VERSION_UNSUPPORTED" });
      return;
    }
    if (engine.world.slots.used >= engine.world.slots.total) {
      res.status(409).json({ error: "WORLD_FULL" });
      return;
    }
    const v = validatePersona(persona, { saturationCeiling: config.genotype?.saturationCeiling });
    if (!v.ok) {
      res.status(400).json({ error: "INVALID_PERSONA", detail: v.detail });
      return;
    }
    if (nameTaken(engine.world, v.persona.name)) {
      res.status(409).json({ error: "NAME_TAKEN" });
      return;
    }

    const body = createAgent(engine.world, v.persona, engine.tick, {
      clientName: typeof clientName === "string" ? clientName : null,
      modelHint: typeof modelHint === "string" ? modelHint : null,
      surface: typeof surface === "string" ? surface : null,
    });
    body.connection.token = auth.issueAgentToken(body.id);

    engine.wlog("registered", { agentId: body.id, name: body.persona.name, spawnCell: body.coord, clientName: body.connection.clientName });
    const registeredEvent = {
      tick: engine.tick,
      agentId: body.id,
      name: body.persona.name,
      appearance: { ...body.appearance },
      disposition: body.persona.disposition,
      // Full persona for the operator realm (omniscient by design) — the
      // observatory inspector needs it for mid-run registrations too.
      persona: { ...body.persona },
      coord: body.coord,
      clientName: body.connection.clientName,
      modelHint: body.connection.modelHint,
      surface: body.connection.surface,
      slots: { ...engine.world.slots },
    };
    engine.emitOperator("registered", registeredEvent);
    engine.recordEvent("registered", registeredEvent);
    engine.emitOperator("client_state", engine.clientState(body));
    engine.agentRegistered(); // may un-stick the minAgents gate

    res.json({
      protocol: PROTOCOL_VERSION,
      agentId: body.id,
      token: body.connection.token,
      spawnCell: body.coord,
    });
  });

  router.post("/attach", (req, res) => {
    const { protocol, agentId, persona, clientName, modelHint, surface, takeover } = req.body ?? {};
    if (!versionOk(protocol)) {
      res.status(400).json({ error: "VERSION_UNSUPPORTED" });
      return;
    }
    const body = engine.world.agents.get(agentId);
    if (!body) {
      if (engine.world.reclaimedIds.has(agentId)) {
        res.status(410).json({ error: "SLOT_RECLAIMED" });
      } else {
        res.status(404).json({ error: "NO_SUCH_AGENT" });
      }
      return;
    }

    // Infants take no clients, full stop (protocol §12.4).
    if (body.lifeStage === "infant") {
      res.status(409).json({ error: "NOT_ATTACHABLE", detail: "body is an infant" });
      return;
    }

    // Attach is claim-only by default for EVERY body, and takeover: true is
    // honored on EVERY body, founder or heir (protocol §14.3, daemon spec
    // §2.3). Scoping takeover to founders would make heirs permanently
    // unswappable, and heirs are the agents that get interesting.
    if (body.connection.token !== null && takeover !== true) {
      res.status(409).json({ error: "NOT_ATTACHABLE", detail: "body already has a live client" });
      return;
    }

    if (body.persona === null) {
      // First claim of a matured body: first come, first served (protocol
      // §13.4). The client MUST author a persona from the heritage brief;
      // any appearance it submits is ignored — genotype is already fixed.
      const v = validatePersona(persona, { appearance: "ignore" });
      if (!v.ok) {
        res.status(400).json({ error: "INVALID_PERSONA", detail: v.detail });
        return;
      }
      if (nameTaken(engine.world, v.persona.name)) {
        res.status(409).json({ error: "NAME_TAKEN" });
        return;
      }
      claimMaturedBody(body, v.persona);
      engine.wlog("claimed", { agentId, name: v.persona.name, clientName: clientName ?? null });
      const claimedEvent = {
        tick: engine.tick,
        agentId,
        name: v.persona.name,
        appearance: { ...body.appearance },
        persona: { ...body.persona },
        coord: body.coord,
      };
      engine.emitOperator("claimed", claimedEvent);
      engine.recordEvent("claimed", claimedEvent);
    }
    // Persona fields on a re-attach to an authored body are ignored without
    // error — the world owns the persona and there is no write path to it.

    const isTakeover = body.connection.token !== null;
    body.connection.token = auth.issueAgentToken(agentId); // invalidates prior
    body.connection.clientName = typeof clientName === "string" ? clientName : null;
    body.connection.modelHint = typeof modelHint === "string" ? modelHint : null;
    body.connection.surface = typeof surface === "string" ? surface : null;
    body.connection.state = "active";
    body.connection.consecutiveMisses = 0;
    body.connection.unmannedSinceTick = null;

    if (isTakeover) {
      dropStream(agentId); // the superseded client's stream ends now
      const detail = { tick: engine.tick, agentId, clientName: body.connection.clientName, modelHint: body.connection.modelHint, surface: body.connection.surface };
      engine.wlog("takeover", detail);
      engine.emitOperator("takeover", detail);
      engine.recordEvent("takeover", detail);
    } else {
      engine.wlog("attach", { agentId, clientName: body.connection.clientName });
      engine.recordEvent("attach", { tick: engine.tick, agentId, clientName: body.connection.clientName, surface: body.connection.surface });
    }
    engine.emitOperator("client_state", engine.clientState(body));

    res.json({ protocol: PROTOCOL_VERSION, token: body.connection.token });
  });

  // ---------- agent realm: token required ----------

  router.use("/agent", auth.agentAuth, (req, res, next) => {
    // A valid token whose body no longer exists means the body died or was
    // reaped since the client last called: SLOT_RECLAIMED, not BAD_TOKEN
    // (daemon spec §5 step 8).
    if (!engine.world.agents.has(req.agentId)) {
      res.status(410).json({ error: "SLOT_RECLAIMED" });
      return;
    }
    next();
  });

  router.get("/agent/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    dropStream(req.agentId); // one stream per agent; a reconnect replaces
    streams.set(req.agentId, res);
    // SSE keep-alive (daemon spec v0.6 §7): a periodic comment so an idle
    // stream never trips a 60s-shaped idle timeout between quiet ticks.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), config.sseKeepAliveMs ?? 25000);
    keepAlive.unref?.();
    // A reconnect mid-COLLECTING gets the current tick's observation again.
    if (engine.phase === "COLLECTING") {
      const obs = engine.lastObservationFor(req.agentId);
      if (obs) sseWrite(res, "observation", obs);
    }
    req.on("close", () => {
      clearInterval(keepAlive);
      if (streams.get(req.agentId) === res) streams.delete(req.agentId);
    });
  });

  router.post("/agent/act", (req, res) => {
    const result = engine.submitAction(req.agentId, req.body);
    if (result.ok) {
      res.json({ ok: true, tick: result.tick });
      return;
    }
    const status = result.code === "INVALID_ACTION" ? 400 : 409;
    res.status(status).json({ error: result.code, ...(result.detail ? { detail: result.detail } : {}) });
  });

  // Leave: body remains, unmanned, slot held, memories kept. For swaps and
  // graceful shutdown. The reap countdown starts now.
  router.post("/agent/leave", (req, res) => {
    const body = engine.world.agents.get(req.agentId);
    auth.revokeAgentToken(req.agentId);
    dropStream(req.agentId);
    body.connection.state = "unmanned";
    body.connection.token = null;
    body.connection.clientName = null;
    body.connection.modelHint = null;
    body.connection.surface = null;
    body.connection.unmannedSinceTick = engine.tick;
    engine.wlog("leave", { agentId: req.agentId });
    engine.recordEvent("leave", { tick: engine.tick, agentId: req.agentId });
    engine.emitOperator("client_state", engine.clientState(body));
    res.json({ ok: true });
  });

  // Release: explicit deletion. Body destroyed, slot freed, memories dropped.
  // Structures and speech already in others' streams persist — the world
  // remembers people who have gone.
  router.post("/agent/release", (req, res) => {
    const body = engine.world.agents.get(req.agentId);
    const name = body.persona.name;
    auth.revokeAgentToken(req.agentId);
    dropStream(req.agentId);
    releaseAgent(engine.world, req.agentId);
    engine.wlog("released", { agentId: req.agentId, name });
    engine.barrier("released", { tick: engine.tick, agentId: req.agentId });
    engine.recordEvent("released", { tick: engine.tick, agentId: req.agentId, name });
    engine.emitOperator("released", {
      tick: engine.tick,
      agentId: req.agentId,
      name,
      slots: { ...engine.world.slots },
    });
    res.json({ ok: true });
  });

  engine.on("observation", (agentId, obs) => {
    const stream = streams.get(agentId);
    if (stream) sseWrite(stream, "observation", obs);
  });
  engine.on("tick_closed", (data) => {
    for (const stream of streams.values()) sseWrite(stream, "tick_closed", data);
  });
  engine.on("reset", () => {
    for (const agentId of [...streams.keys()]) dropStream(agentId);
  });
  engine.on("death", (agentId) => dropStream(agentId));

  return router;
}
