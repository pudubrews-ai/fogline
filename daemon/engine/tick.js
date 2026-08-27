// The tick lifecycle state machine. One authoritative owner of phase
// transitions; no other module may advance it. The engine NEVER awaits a
// client: the deadline is a timer, and resolution runs on that timer whether
// or not any action arrived.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { simTimeAtTick } from "./clock.js";
import { captureRoster, resolveTick } from "./resolve.js";
import { computeSituations } from "../world/situation.js";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { STRUCTURE_FORMS, hasControlChars, releaseAgent } from "../world/world.js";
import { RESOURCE_TYPES } from "../world/resources.js";
import { computeViability, computeConstructionSlack } from "../world/viability.js";
import { typicalStructureCost } from "../world/recipes.js";

const ACTION_TYPES = new Set([
  "move", "say", "build", "wait", "attack",
  "gather", "drop", "give", "consume", "inscribe", "beget", "foster",
  "demolish", "raze",
]);
// Reserved, not unknown: rejected, never silently coerced (protocol §10).
const RESERVED_TYPES = new Set(["modify"]);

export const STRUCTURE_LIMITS = { name: 40, description: 300 };

// A resource map is {sivet?, orrum?, khal?} with positive integers and at
// least one entry. Returns an error detail string, or null when valid.
function badResourceMap(resources, forAction) {
  if (resources === null || typeof resources !== "object" || Array.isArray(resources)) {
    return `resources is required for ${forAction}`;
  }
  const keys = Object.keys(resources);
  if (keys.length === 0) return `resources must name at least one resource for ${forAction}`;
  for (const key of keys) {
    if (!RESOURCE_TYPES.includes(key)) return `unknown resource "${key}"`;
    if (!Number.isInteger(resources[key]) || resources[key] < 1) {
      return `resources.${key} must be a positive integer`;
    }
  }
  return null;
}

// Structural validation (protocol §10). Returns {error, detail} on schema
// violation, otherwise {action, coercedWait, coerceReason}. Unknown types,
// bad move destinations, and blocked builds are NOT schema violations — they
// resolve to wait at resolution time.
export function validateAction(payload, config = {}) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: true, detail: "body must be a JSON object" };
  }
  const { protocol, type, coord, text, structure, target, resources, resource, intent, reason, reflections, calls, clientStatus } = payload;
  if (typeof protocol !== "string" || !/^0\.\d+$/.test(protocol)) {
    return { error: true, detail: "protocol must be a \"0.x\" string" };
  }
  // intent and reason are NULLABLE (protocol §10.1): a well-formed action is
  // never rejected or coerced for missing metadata. A live run lost 44
  // agent-ticks to the old required-string rule.
  if (intent != null && typeof intent !== "string") return { error: true, detail: "intent must be a string or null" };
  if (reason != null && typeof reason !== "string") return { error: true, detail: "reason must be a string or null" };
  if (reflections != null && !(Array.isArray(reflections) && reflections.every((r) => typeof r === "string"))) {
    return { error: true, detail: "reflections must be null or an array of strings" };
  }
  // Client-reported inference call count for this tick (daemon spec §4):
  // envelope metadata like intent/reason — optional, never coerced for being
  // absent. Aggregated per surface onto the operator stream, nothing else.
  if (calls != null && (!Number.isInteger(calls) || calls < 0)) {
    return { error: true, detail: "calls must be a non-negative integer or null" };
  }
  // clientStatus (v0.6 A8): operator-channel metadata beside `calls`,
  // validated as leniently as intent/reason — never sink an action for its
  // absence, and never let its value alter world behavior.
  if (clientStatus != null && typeof clientStatus !== "string") {
    return { error: true, detail: "clientStatus must be a string or null" };
  }
  if (typeof type !== "string") return { error: true, detail: "type must be a string" };

  if (RESERVED_TYPES.has(type)) {
    return { error: true, detail: `"${type}" is reserved` };
  }
  if (!ACTION_TYPES.has(type)) {
    // Protocol §10: unknown types resolve to wait and are logged.
    return {
      action: { type: "wait", coord: null, text: null, structure: null, intent: intent ?? null, reason: reason ?? null, reflections: reflections ?? null, calls: calls ?? null, clientStatus: clientStatus ?? null },
      coercedWait: true,
      coerceReason: `unknown_type:${type}`,
    };
  }

  if (type === "move") {
    if (typeof coord !== "string" || coord.length === 0) return { error: true, detail: "coord is required for move" };
    if (text != null) return { error: true, detail: "text must be null unless type is say" };
    if (structure != null) return { error: true, detail: "structure must be null unless type is build" };
  } else if (type === "say") {
    if (typeof text !== "string" || text.length === 0) return { error: true, detail: "text is required for say" };
    if (coord != null) return { error: true, detail: "coord must be null unless type is move" };
    if (structure != null) return { error: true, detail: "structure must be null unless type is build" };
  } else if (type === "build") {
    // Build applies to the current cell; a coordinate is a structural error.
    if (coord != null) return { error: true, detail: "build must not include a coordinate" };
    if (text != null) return { error: true, detail: "text must be null unless type is say" };
    if (structure === null || typeof structure !== "object" || Array.isArray(structure)) {
      return { error: true, detail: "structure is required for build" };
    }
    if (!STRUCTURE_FORMS.includes(structure.form)) {
      return { error: true, detail: `structure.form must be one of: ${STRUCTURE_FORMS.join(", ")}` };
    }
    if (typeof structure.name !== "string" || structure.name.length < 1 || structure.name.length > STRUCTURE_LIMITS.name) {
      return { error: true, detail: `structure.name must be 1-${STRUCTURE_LIMITS.name} chars` };
    }
    if (typeof structure.description !== "string" || structure.description.length > STRUCTURE_LIMITS.description) {
      return { error: true, detail: `structure.description must be a string of at most ${STRUCTURE_LIMITS.description} chars` };
    }
    if (hasControlChars(structure.name) || hasControlChars(structure.description)) {
      return { error: true, detail: "structure text contains control characters" };
    }
  } else if (type === "inscribe") {
    const inscriptionMax = config.inscriptionMax ?? 500;
    if (typeof text !== "string" || text.length === 0) return { error: true, detail: "text is required for inscribe" };
    if (text.length > inscriptionMax) {
      // Reject, never truncate (protocol §16).
      return { error: true, detail: `inscription must be at most ${inscriptionMax} chars` };
    }
    if (hasControlChars(text)) return { error: true, detail: "inscription contains control characters" };
    if (coord != null) return { error: true, detail: "coord must be null unless type is move" };
    if (structure != null) return { error: true, detail: "structure must be null unless type is build" };
    if (target != null || resources != null || resource != null) {
      return { error: true, detail: "inscribe takes only text" };
    }
  } else if (type === "foster") {
    if (typeof target !== "string" || target.length === 0) return { error: true, detail: "target is required for foster" };
    if (coord != null || text != null || structure != null) return { error: true, detail: "foster takes only a target" };
    if (resources != null || resource != null) return { error: true, detail: "foster carries no resources" };
  } else if (type === "attack") {
    if (typeof target !== "string" || target.length === 0) return { error: true, detail: "target is required for attack" };
    if (coord != null) return { error: true, detail: "coord must be null unless type is move" };
    if (text != null) return { error: true, detail: "text must be null unless type is say" };
    if (structure != null) return { error: true, detail: "structure must be null unless type is build" };
    if (resources != null || resource != null) return { error: true, detail: "attack carries no resources" };
  } else if (type === "give") {
    if (typeof target !== "string" || target.length === 0) return { error: true, detail: "target is required for give" };
    const bad = badResourceMap(resources, "give");
    if (bad) return { error: true, detail: bad };
  } else if (type === "drop") {
    if (target != null) return { error: true, detail: "target must be null unless the action takes one" };
    const bad = badResourceMap(resources, "drop");
    if (bad) return { error: true, detail: bad };
  } else if (type === "consume") {
    if (!RESOURCE_TYPES.includes(resource)) {
      return { error: true, detail: `resource must be one of: ${RESOURCE_TYPES.join(", ")}` };
    }
    if (target != null || resources != null) return { error: true, detail: "consume takes only a resource" };
  } else {
    if (coord != null) return { error: true, detail: "coord must be null unless type is move" };
    if (text != null) return { error: true, detail: "text must be null unless type is say" };
    if (structure != null) return { error: true, detail: "structure must be null unless type is build" };
    if (target != null) return { error: true, detail: "target must be null unless the action takes one" };
    if (resources != null || resource != null) return { error: true, detail: "this action carries no resources" };
  }

  return {
    action: {
      type,
      coord: coord ?? null,
      text: text ?? null,
      structure: type === "build" ? { form: structure.form, name: structure.name, description: structure.description } : null,
      target: target ?? null,
      resources: type === "give" || type === "drop" ? { ...resources } : null,
      resource: type === "consume" ? resource : null,
      intent: intent ?? null,
      reason: reason ?? null,
      reflections: reflections ?? null,
      calls: calls ?? null,
      clientStatus: clientStatus ?? null,
    },
    coercedWait: false,
    coerceReason: null,
  };
}

// How a cell serializes into the resolved-tick record (operator-side only).
// Full contents including history, cause, and fragments: ticks.log is replay
// material for the observatory, which sits outside every fog.
function cellRecord(cell) {
  return {
    coord: cell.coord,
    deposit: cell.deposit ? { resource: cell.deposit.resource, quantity: cell.deposit.quantity } : null,
    loose: cell.loose ? { ...cell.loose } : null,
    structure: cell.structure
      ? {
          form: cell.structure.form,
          authored: { ...cell.structure.authored },
          // Full entries INCLUDING authorId — this record is operator-side
          // replay material, outside every fog.
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
    corpses: cell.corpses.map((c) => ({
      authored: { ...c.authored },
      appearance: { ...c.appearance },
      diedAtTick: c.diedAtTick,
      causeAgentId: c.causeAgentId,
    })),
    fragment: cell.fragment ? structuredClone(cell.fragment) : null,
  };
}

const cellIsEmpty = (cell) =>
  cell.deposit === null && cell.loose === null && cell.structure === null &&
  cell.corpses.length === 0 && cell.fragment === null;

export class TickEngine extends EventEmitter {
  constructor({ worldFactory, config, barrierLog = () => {}, worldLog = () => {}, tickLog = () => {} }) {
    super();
    this.worldFactory = worldFactory;
    this.config = config;
    this.world = worldFactory();
    this._barrierLog = barrierLog;
    this._worldLog = worldLog;
    this._tickLog = tickLog;

    this.phase = "IDLE"; // IDLE | OPEN | COLLECTING | CLOSED | RESOLVED
    this.tick = 0;
    this.simTime = config.startSimTime;
    this.paused = config.startPaused === true;
    this.stopped = false;
    this.speed = 1;
    this.deadline = null;
    this.lastResolved = null;
    this.waitingForAgents = false;

    this._actions = new Map();
    this._rosterAtOpen = null;
    this._lastObservations = new Map();
    this._openedAtMs = null;
    this._deadlineTimer = null;
    this._nextOpenTimer = null;
    this._pendingEvents = [];
    // Cumulative client-reported call counts per billing surface (daemon
    // spec §4). Operator-side accounting only; never alters world behavior.
    this._surfaceCalls = new Map();
    this._beginRun();
  }

  // A run boundary in ticks.log (daemon spec §4.4): written at boot and on
  // every reset, with a fresh run id and the bootstrap the observatory needs
  // to segment runs and replay without a daemon.
  _beginRun() {
    this.runId = `r_${crypto.randomBytes(4).toString("hex")}`;
    // Boot computation (protocol §6.2 as amended by v0.6 A5/A6): demand
    // over expectedAgents (config, default minAgents), computed before
    // tick 1 ever opens, logged in the run header, exposed at /scenario.
    // Both expectedAgents and slots are logged. The floor refusal itself
    // lives in createDaemon, before listen.
    const expectedAgents = this.config.expectedAgents ?? this.config.minAgents ?? 2;
    this.viability = computeViability(this.world, this.config.maxTicks, expectedAgents);
    // Construction slack beside subsistence (daemon spec v0.6 §4): whether
    // surplus exists to leave the springs and gather building material.
    this.constructionSlack = computeConstructionSlack(
      this.world,
      this.config.maxTicks,
      expectedAgents,
      typicalStructureCost()
    );
    const deposits = [];
    for (const cell of this.world.cells.values()) {
      if (cell.deposit) {
        deposits.push({ coord: cell.coord, resource: cell.deposit.resource, quantity: cell.deposit.quantity });
      }
    }
    const line = {
      ts: new Date().toISOString(),
      event: "run_started",
      runId: this.runId,
      configHash: crypto.createHash("sha256").update(JSON.stringify(this.config)).digest("hex").slice(0, 16),
      gridSize: this.world.gridSize,
      slots: { ...this.world.slots },
      premise: this.config.premise,
      maxTicks: this.config.maxTicks,
      startSimTime: this.config.startSimTime,
      minutesPerTick: this.config.minutesPerTick,
      carryLimit: this.world.carryLimit,
      inscriptionMax: this.world.inscriptionMax,
      deposits,
      viability: { ...this.viability },
      constructionSlack: { ...this.constructionSlack },
    };
    this._tickLog(line);
    // Retained for late subscribers (v0.8): the archive recorder attaches
    // after this constructor-time boot and must not miss the first run.
    this.lastRunStarted = line;
    this.emitOperator("run_started", line);
    this.wlog("viability", { runId: this.runId, ...this.viability });
    this.wlog("construction_slack", { runId: this.runId, ...this.constructionSlack });
  }

  // World events buffered into the current tick's resolved record — the same
  // stream the operator channel sees, so live and replay fold identically.
  recordEvent(type, data) {
    this._pendingEvents.push({ type, ...data });
  }

  barrier(event, data = {}) {
    const line = { ts: new Date().toISOString(), event, ...data };
    this._barrierLog(line);
    this.emitOperator("barrier", line);
  }

  wlog(event, data = {}) {
    this._worldLog({ ts: new Date().toISOString(), event, ...data });
  }

  emitOperator(event, data) {
    this.emit("operator", { event, data });
  }

  clientState(body) {
    const c = body.connection;
    return {
      agentId: body.id,
      state: c.state,
      clientName: c.clientName,
      modelHint: c.modelHint,
      // Billing surface (protocol §15.3): operator channel and roster only —
      // it never enters an observation and never alters world behavior.
      surface: c.surface ?? null,
      consecutiveMisses: c.consecutiveMisses,
      lastActionLatencyMs: c.lastActionLatencyMs,
      // Client-reported status enum (v0.6 A8): operator channel only.
      clientStatus: body.clientStatus ?? null,
    };
  }

  lastObservationFor(agentId) {
    return this._lastObservations.get(agentId) ?? null;
  }

  start() {
    if (!this.paused) this._open();
  }

  // Called by the registry when a slot is consumed. The world may have been
  // waiting on the minAgents gate (or emptied out mid-run); a registration is
  // what un-sticks it. startPaused still applies after the gate is met.
  agentRegistered() {
    if (this.waitingForAgents && !this.paused && !this.stopped && !this._nextOpenTimer) {
      this._scheduleOpen();
    }
  }

  play(speed) {
    if (typeof speed === "number" && speed > 0) this.setSpeed(speed);
    if (this.stopped) return;
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.barrier("resumed", { tick: this.tick });
    if ((this.phase === "IDLE" || this.phase === "RESOLVED") && !this._nextOpenTimer) {
      this._scheduleOpen();
    }
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    // Never interrupts a tick in progress; only holds before the next OPEN.
    if (this._nextOpenTimer) {
      clearTimeout(this._nextOpenTimer);
      this._nextOpenTimer = null;
    }
    this.barrier("pause_requested", { tick: this.tick, phase: this.phase });
  }

  // Runs exactly one full cycle and re-pauses. Mid-tick, it just pauses after
  // the current cycle completes.
  step() {
    if (this.stopped) return;
    this.paused = true;
    if (this._nextOpenTimer) {
      clearTimeout(this._nextOpenTimer);
      this._nextOpenTimer = null;
    }
    if (this.phase === "IDLE" || this.phase === "RESOLVED") {
      this.barrier("step", { fromTick: this.tick });
      this._open();
    }
  }

  reset() {
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    if (this._nextOpenTimer) clearTimeout(this._nextOpenTimer);
    this._deadlineTimer = null;
    this._nextOpenTimer = null;
    this.world = this.worldFactory();
    this.phase = "IDLE";
    this.tick = 0;
    this.simTime = this.config.startSimTime;
    this.paused = this.config.startPaused === true;
    this.stopped = false;
    this.deadline = null;
    this.lastResolved = null;
    this.waitingForAgents = false;
    this._actions = new Map();
    this._rosterAtOpen = null;
    this._lastObservations = new Map();
    this._pendingEvents = [];
    this._surfaceCalls = new Map();
    this._beginRun();
    this.barrier("reset");
    this.emit("reset");
    if (!this.paused) this._scheduleOpen();
  }

  setSpeed(speed) {
    this.speed = Math.min(50, Math.max(0.1, speed));
  }

  // Operator overtime: raise maxTicks and clear the hard stop. The world
  // resumes from held state — memory, positions, connections all intact.
  extend(ticks = 20) {
    const n = Math.floor(ticks);
    if (!Number.isFinite(n) || n < 1) return;
    this.config.maxTicks += n;
    const wasStopped = this.stopped;
    this.stopped = false;
    this.barrier("extended", { tick: this.tick, maxTicks: this.config.maxTicks });
    if (wasStopped && !this.paused && (this.phase === "RESOLVED" || this.phase === "IDLE")) {
      this._scheduleOpen();
    }
  }

  dispose() {
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    if (this._nextOpenTimer) clearTimeout(this._nextOpenTimer);
  }

  _scheduleOpen() {
    this._nextOpenTimer = setTimeout(() => {
      this._nextOpenTimer = null;
      this._open();
    }, 0);
  }

  _open() {
    if (this.stopped || (this.phase !== "IDLE" && this.phase !== "RESOLVED")) return;
    if (this._nextOpenTimer) {
      clearTimeout(this._nextOpenTimer);
      this._nextOpenTimer = null;
    }
    // The world boots empty: tick 1 waits for minAgents, and a world emptied
    // by release/reaping pauses rather than ticking nobody (daemon spec §8).
    const needed = this.tick === 0 ? this.config.minAgents ?? 2 : 1;
    if (this.world.agents.size < needed) {
      if (!this.waitingForAgents) {
        this.waitingForAgents = true;
        this.barrier("waiting_for_agents", {
          tick: this.tick,
          registered: this.world.agents.size,
          needed,
        });
      }
      return;
    }
    this.waitingForAgents = false;

    this.tick += 1;
    this.phase = "OPEN";
    this._actions = new Map();
    this.simTime = simTimeAtTick(this.config.startSimTime, this.config.minutesPerTick, this.tick);

    writePerceptions(this.world, this.tick, this.simTime);
    this._rosterAtOpen = captureRoster(this.world);
    for (const body of this.world.agents.values()) {
      body.reflectionRequested = body.importanceSinceLastReflection > this.config.reflectionThreshold;
    }
    // After perceptions (first inscription reads) and the reflection flag,
    // before observations: the situation diff that gates client inference.
    const situations = computeSituations(this.world, this.tick, {
      attentionBudget: this.config.attentionBudget ?? null,
    });
    // Held for the resolved record (v0.8): the observatory's watch mode
    // and ticker ride the same situationChanged lever that gates client
    // inference. Operator-side only — the record never crosses the fog.
    this._situationsAtOpen = situations;

    const deadlineMs = Math.max(25, Math.round(this.config.actionDeadlineMs / this.speed));
    this._openedAtMs = Date.now();
    this.deadline = new Date(this._openedAtMs + deadlineMs).toISOString();

    this.barrier("tick_open", { tick: this.tick, simTime: this.simTime, deadline: this.deadline });
    this.emitOperator("tick_open", {
      tick: this.tick,
      simTime: this.simTime,
      deadline: this.deadline,
      agents: [...this.world.agents.values()].map((b) => ({
        agentId: b.id,
        coord: b.coord,
        state: b.connection.state,
        reflectionRequested: b.reflectionRequested,
      })),
    });

    for (const body of this.world.agents.values()) {
      // Infants receive no observation and generate no client traffic
      // (protocol §11.4): their entire cost is in-world. A matured body
      // nobody has claimed has no persona to observe with yet either.
      if (body.lifeStage === "infant" || body.persona === null) continue;
      const obs = buildObservation(this.world, body.id, this.tick, {
        simTime: this.simTime,
        deadline: this.deadline,
        retrievalK: this.config.retrievalK,
        situation: situations.get(body.id) ?? null,
      });
      this._lastObservations.set(body.id, obs);
      this.barrier("observation_emitted", { tick: this.tick, agentId: body.id });
      this.emit("observation", body.id, obs);
    }

    this.phase = "COLLECTING";
    this._deadlineTimer = setTimeout(() => this._close("deadline"), deadlineMs);
  }

  submitAction(agentId, payload) {
    const tickInPayload = payload && typeof payload === "object" ? payload.tick : undefined;
    if (this.phase !== "COLLECTING") {
      const code = tickInPayload === this.tick ? "TICK_CLOSED" : "WRONG_TICK";
      this.barrier("action_rejected", { tick: this.tick, agentId, code });
      return { ok: false, code };
    }
    if (tickInPayload !== this.tick) {
      this.barrier("action_rejected", { tick: this.tick, agentId, code: "WRONG_TICK" });
      return { ok: false, code: "WRONG_TICK" };
    }
    // An agent registered mid-COLLECTING has no observation for this tick and
    // no place in its roster; it acts from the next tick (protocol §7.3).
    if (!this._rosterAtOpen?.coordOf.has(agentId)) {
      this.barrier("action_rejected", { tick: this.tick, agentId, code: "WRONG_TICK", detail: "not in this tick's roster" });
      return { ok: false, code: "WRONG_TICK" };
    }
    if (this._actions.has(agentId)) {
      this.barrier("action_rejected", { tick: this.tick, agentId, code: "ALREADY_ACTED" });
      return { ok: false, code: "ALREADY_ACTED" };
    }
    const v = validateAction(payload, this.config);
    if (v.error) {
      this.barrier("action_rejected", { tick: this.tick, agentId, code: "INVALID_ACTION", detail: v.detail });
      return { ok: false, code: "INVALID_ACTION", detail: v.detail };
    }

    const latencyMs = Date.now() - this._openedAtMs;
    this._actions.set(agentId, {
      action: v.action,
      assigned: false,
      coercedWait: v.coercedWait,
      coerceReason: v.coerceReason,
      latencyMs,
      // Captured now: the body may be dead by the time the record is built.
      surface: this.world.agents.get(agentId)?.connection.surface ?? null,
    });

    const body = this.world.agents.get(agentId);
    if (body) {
      body.connection.consecutiveMisses = 0;
      body.connection.lastActionLatencyMs = latencyMs;
      if (body.connection.state !== "active") body.connection.state = "active";
      // Stored on the body, surfaced via clientState — never read by the
      // resolver, never in an observation (v0.6 A8).
      body.clientStatus = v.action.clientStatus ?? null;
      this.emitOperator("client_state", this.clientState(body));
    }
    this.barrier("action_received", {
      tick: this.tick,
      agentId,
      type: v.action.type,
      latencyMs,
      ...(v.coercedWait ? { coerced: v.coerceReason } : {}),
    });

    // Protocol §8: the tick MAY close early once every agent with an active
    // connection has submitted. Unmanned bodies never block an early close;
    // a tick with no submissions at all always runs to its deadline. Agents
    // registered after OPEN are not in the roster and never block it either.
    let pendingConnected = 0;
    for (const id of this._rosterAtOpen.coordOf.keys()) {
      const b = this.world.agents.get(id);
      if (b && b.connection.token !== null && !this._actions.has(id)) pendingConnected += 1;
    }
    if (pendingConnected === 0) {
      clearTimeout(this._deadlineTimer);
      this._close("all_acted");
    }
    return { ok: true, tick: this.tick };
  }

  _close(reason) {
    if (this.phase !== "COLLECTING") return;
    clearTimeout(this._deadlineTimer);
    this._deadlineTimer = null;
    this.phase = "CLOSED";
    this.barrier("tick_closed", { tick: this.tick, reason });
    this.emit("tick_closed", { tick: this.tick, resolved: true });

    // Only agents that were present at OPEN owe an action; a body registered
    // mid-tick simply hasn't started yet and accrues no miss.
    for (const agentId of this._rosterAtOpen.coordOf.keys()) {
      const body = this.world.agents.get(agentId);
      // Infants owe no action and accrue no misses; they take no actions at all.
      if (!body || body.lifeStage === "infant" || this._actions.has(agentId)) continue;
      this._actions.set(agentId, {
        action: { type: "wait", coord: null, text: null, structure: null, intent: null, reason: null, reflections: null },
        assigned: true,
        coercedWait: false,
        coerceReason: null,
      });
      body.connection.consecutiveMisses += 1;
      // Only a body with a client attached can stall. Unmanned means nothing
      // is connected; stalled means a client is connected and its model is
      // failing to respond in time. That distinction is the diagnostic the
      // client panel exists for — unmanned MUST NOT transition to stalled.
      const stalled =
        body.connection.state === "active" &&
        body.connection.consecutiveMisses >= this.config.stalledAfterMisses;
      if (stalled) body.connection.state = "stalled";
      this.barrier("action_missed", {
        tick: this.tick,
        agentId: body.id,
        consecutiveMisses: body.connection.consecutiveMisses,
        state: body.connection.state,
      });
      if (stalled) this.emitOperator("client_state", this.clientState(body));
    }

    this._resolve();
  }

  _resolve() {
    // Every world event goes three places: world.log, the operator stream,
    // and the current tick's event buffer — the buffer lands in ticks.log so
    // replay folds the same events live saw.
    const ev = (type) => (d) => {
      this.wlog(type, d);
      this.emitOperator(type, d);
      this.recordEvent(type, d);
    };
    const summary = resolveTick(this.world, this.tick, this.simTime, this._actions, this._rosterAtOpen, {
      speech: ev("speech"),
      build: ev("build"),
      invalidBuild: (d) => {
        this.wlog("invalid_build", d);
      },
      move: ev("move"),
      invalidMove: (d) => {
        this.wlog("invalid_move", d);
      },
      attack: ev("attack"),
      raze: ev("raze"),
      demolishProgress: ev("demolish_progress"),
      demolishComplete: ev("demolish_complete"),
      beget: (d) => {
        this.wlog("beget", d);
        this.barrier("birth", { tick: d.tick, agentId: d.agentId, infantId: d.infantId });
        const infant = this.world.agents.get(d.infantId);
        const payload = {
          ...d,
          appearance: infant ? { ...infant.appearance } : null,
          heritage: infant?.heritage ? structuredClone(infant.heritage) : null,
          slots: { ...this.world.slots },
        };
        this.emitOperator("beget", payload);
        this.recordEvent("beget", payload);
      },
      foster: ev("foster"),
      mature: ev("matured"),
      inscribe: ev("inscribe"),
      invalidInscribe: (d) => this.wlog("invalid_inscribe", d),
      give: (d) => {
        this.wlog("give", d);
        this.recordEvent("give", d);
      },
      drop: (d) => {
        this.wlog("drop", d);
        this.recordEvent("drop", d);
      },
      consume: (d) => {
        this.wlog("consume", d);
        this.recordEvent("consume", d);
      },
      gather: (d) => {
        this.wlog("gather", d);
        this.recordEvent("gather", d);
      },
      invalidAttack: (d) => {
        this.wlog("invalid_attack", d);
      },
      death: (d) => {
        this.wlog("death", d);
        this.barrier("death", { tick: d.tick, agentId: d.agentId, causeAgentId: d.causeAgentId });
        this.emitOperator("death", { ...d, slots: { ...this.world.slots } });
        this.recordEvent("death", d);
        this._lastObservations.delete(d.agentId);
        // The agent realm listens: the dead body's stream ends now, and its
        // next request answers SLOT_RECLAIMED.
        this.emit("death", d.agentId);
      },
      reflection: ev("reflection"),
    });

    // The reaper runs at RESOLVED: any body unmanned for longer than
    // reapAfterTicks is auto-released. Its structures, history entries, and
    // speech in others' streams survive (daemon spec §4.5).
    for (const body of [...this.world.agents.values()]) {
      if (
        body.connection.state === "unmanned" &&
        body.connection.unmannedSinceTick !== null &&
        this.tick - body.connection.unmannedSinceTick > this.config.reapAfterTicks
      ) {
        const name = body.persona.name;
        releaseAgent(this.world, body.id);
        this._lastObservations.delete(body.id);
        this.barrier("reaped", { tick: this.tick, agentId: body.id });
        this.wlog("reaped", { tick: this.tick, agentId: body.id, name });
        this.emitOperator("reaped", { tick: this.tick, agentId: body.id, name, slots: { ...this.world.slots } });
        this.recordEvent("reaped", { tick: this.tick, agentId: body.id, name });
      }
    }

    this.phase = "RESOLVED";
    this.lastResolved = { tick: this.tick, summary };
    this.barrier("tick_resolved", { tick: this.tick, summary });

    // The resolved-tick record: what everyone tried, what actually happened,
    // and where every body and every non-empty cell stands now. One line per
    // tick — this is the observatory's replay material, so it carries the
    // tick's world events and memory writes alongside the authoritative
    // state. Operator-side only; nothing here crosses the fog boundary.
    // Call counting per billing surface (daemon spec §4): sum this tick's
    // client-reported counts by the surface captured at submission, fold
    // into the cumulative totals, and put both on the operator stream. The
    // daemon holds no credentials and prices nothing; it counts calls and
    // attributes them.
    const callsThisTick = new Map();
    for (const rec of this._actions.values()) {
      const calls = rec.action?.calls;
      if (!Number.isInteger(calls) || calls <= 0) continue;
      const surface = rec.surface ?? "undeclared";
      callsThisTick.set(surface, (callsThisTick.get(surface) ?? 0) + calls);
    }
    for (const [surface, calls] of callsThisTick) {
      this._surfaceCalls.set(surface, (this._surfaceCalls.get(surface) ?? 0) + calls);
    }
    const spend = [...this._surfaceCalls]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([surface, callsTotal]) => ({ surface, calls: callsThisTick.get(surface) ?? 0, callsTotal }));

    const record = {
      ts: new Date().toISOString(),
      runId: this.runId,
      tick: this.tick,
      simTime: this.simTime,
      summary,
      spend,
      events: this._pendingEvents.splice(0),
      memories: this.world.memoryLog.splice(0),
      // situationChanged per agent, computed at this tick's OPEN (v0.8):
      // lets the observatory's watch mode skip model calls on ticks
      // where nothing changed for anyone — the lever that took the clients
      // from 1.0 calls per tick to 0.05, reused rather than reimplemented.
      situations: [...(this._situationsAtOpen ?? new Map())].map(([agentId, s]) => ({
        agentId,
        changed: s.situationChanged === true,
      })),
      actions: [...this._actions].map(([agentId, rec]) => ({
        agentId,
        type: rec.action.type,
        assigned: rec.assigned === true,
        coerced: rec.coercedWait ? rec.coerceReason ?? true : null,
        latencyMs: rec.latencyMs ?? null,
        outcome: this.world.agents.get(agentId)?.lastActionOutcome ?? null,
      })),
      bodies: [...this.world.agents.values()].map((b) => ({
        agentId: b.id,
        name: b.persona?.name ?? null,
        coord: b.coord,
        lifeStage: b.lifeStage,
        vitality: b.vitality,
        sustenance: b.sustenance,
        inventory: { ...b.inventory },
        appearance: { ...b.appearance },
        connectionState: b.connection.state,
        clientName: b.connection.clientName,
        modelHint: b.connection.modelHint,
        surface: b.connection.surface ?? null,
        clientStatus: b.clientStatus ?? null,
        currentIntent: b.currentIntent,
        lastReason: b.lastReason,
        sponsorId: b.sponsorId,
        bornAtTick: b.bornAtTick,
        unsponsoredAtTick: b.unsponsoredAtTick,
        heritage: b.heritage ? structuredClone(b.heritage) : null,
      })),
      cells: [...this.world.cells.values()].filter((c) => !cellIsEmpty(c)).map(cellRecord),
    };
    this._tickLog(record);
    // The identical record rides the operator stream: live and replay fold
    // the same input through the same reducer, which is the entire point.
    this.emitOperator("tick", record);

    if (this.tick >= this.config.maxTicks) {
      // Hard stop: hold state, keep serving. The process does not exit.
      this.stopped = true;
      this.barrier("run_complete", { tick: this.tick });
      return;
    }
    if (this.paused) return; // the pause gate: hold before the next OPEN
    this._scheduleOpen();
  }
}
