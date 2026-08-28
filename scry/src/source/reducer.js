// events -> world state. SHARED by live.js and replay.js, and that is the
// point: live and replay produce identical state from identical records. A
// bug that appears in one and not the other means something reconstructed
// state outside this file.
//
// Inputs are the daemon's own records, verbatim:
//   run_started  — the bootstrap line at the head of every run in ticks.log,
//                  also emitted on the operator stream at boot and reset.
//   tick         — the per-tick resolved record: summary, events, memory
//                  writes, actions (with latency), bodies, non-empty cells.
//   snapshot     — live only: full world state at connect. Folded into the
//                  same state shape so a mid-run connect starts complete.
//
// The reducer renders nothing and decides nothing. It never invents state:
// everything here is copied from a daemon record, and anything the records
// do not carry stays absent.

export function createState() {
  return {
    runId: null,
    tick: 0,
    simTime: null,
    paused: false,
    stopped: false, // v0.8: snapshot-only flags for the tab title
    waitingForAgents: false,
    slots: null, // v0.8: {total, used, free} from run_started / snapshot
    lastSituations: [], // v0.8: per-agent situationChanged from the tick record
    gridSize: 0,
    premise: null,
    carryLimit: null,
    maxTicks: null,
    cells: new Map(), // "x,y" -> {coord, deposit, loose, structure, corpses, fragment}
    agents: new Map(), // agentId -> agent (see foldBody)
    departed: new Map(), // agentId -> {name, appearance, diedAtTick|null} — for lineage thumbnails and feed names
    events: [], // append-only: {tick, simTime, type, ...payload}
    lineage: { edges: [] }, // {parent, child, bornAtTick, fosteredBy}
    personas: new Map(), // agentId -> full persona, from registered/claimed events or snapshot
    viability: null, // boot arithmetic from run_started / snapshot (v0.5)
    constructionSlack: null, // v0.6: material-affordability arithmetic
    inscriptionMax: null, // v0.6: the permanent per-structure budget
    spend: [], // latest per-surface call counts [{surface, calls, callsTotal}]
    liveSince: null, // tick of the live snapshot this state was folded from;
    // null in replay. Non-zero means events before it live only in replay.
  };
}

const emptyCell = (coord) => ({ coord, deposit: null, loose: null, structure: null, corpses: [], fragment: null });

function blankGrid(state) {
  state.cells = new Map();
  const w = state.width ?? state.gridSize;
  const h = state.height ?? state.gridSize;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const coord = `${x},${y}`;
      state.cells.set(coord, emptyCell(coord));
    }
  }
}

// ---------- run_started ----------

export function applyRunStarted(state, line) {
  const fresh = createState();
  fresh.runId = line.runId ?? null;
  // v0.9: worlds may be non-square (width/height); gridSize stays for
  // square worlds and legacy records.
  fresh.gridSize = line.gridSize ?? line.width ?? 0;
  fresh.width = line.width ?? line.gridSize ?? 0;
  fresh.height = line.height ?? line.gridSize ?? 0;
  fresh.premise = line.premise ?? null;
  fresh.carryLimit = line.carryLimit ?? null;
  fresh.maxTicks = line.maxTicks ?? null;
  fresh.simTime = line.startSimTime ?? null;
  fresh.viability = line.viability ? { ...line.viability } : null;
  fresh.constructionSlack = line.constructionSlack ? { ...line.constructionSlack } : null;
  fresh.inscriptionMax = line.inscriptionMax ?? null;
  fresh.slots = line.slots ? { ...line.slots } : null;
  blankGrid(fresh);
  for (const d of line.deposits ?? []) {
    const cell = fresh.cells.get(d.coord);
    if (cell) cell.deposit = { resource: d.resource, quantity: d.quantity };
  }
  return fresh;
}

// ---------- tick ----------

function foldBody(prev, b, tick) {
  return {
    agentId: b.agentId,
    name: b.name ?? null,
    coord: b.coord,
    prevCoord: prev?.coord ?? b.coord, // for the renderer's move glide; derived from records, not invented
    lifeStage: b.lifeStage,
    connectionState: b.connectionState ?? prev?.connectionState ?? null,
    clientName: b.clientName ?? prev?.clientName ?? null,
    modelHint: b.modelHint ?? prev?.modelHint ?? null,
    // Billing surface (v0.5): operator-record data, for the roster and the
    // spend panel. Never appears in-world.
    surface: b.surface ?? prev?.surface ?? null,
    // v0.6 A8: the typed client status from the operator record — the roster
    // reads this, never a reason string.
    clientStatus: b.clientStatus ?? null,
    vitality: b.vitality,
    sustenance: b.sustenance,
    inventory: { ...b.inventory },
    appearance: b.appearance ? { ...b.appearance } : prev?.appearance ?? null,
    currentIntent: b.currentIntent ?? null,
    lastReason: b.lastReason ?? null,
    sponsorId: b.sponsorId ?? null,
    bornAtTick: b.bornAtTick ?? null,
    unsponsoredAtTick: b.unsponsoredAtTick ?? null,
    heritage: b.heritage ?? prev?.heritage ?? null,
    memories: prev?.memories ?? [],
    knownCells: prev?.knownCells ?? new Map(),
    consecutiveMisses: prev?.consecutiveMisses ?? 0,
    lastActionType: prev?.lastActionType ?? null,
    lastActionLatencyMs: prev?.lastActionLatencyMs ?? null,
    lastSeenTick: tick,
  };
}

const cloneStructure = (s) =>
  s
    ? {
        form: s.form ?? null,
        authored: { ...s.authored },
        // v0.6: ordered entry list with the running character count, straight
        // from the record (operator-side, authorId included).
        inscription: s.inscription
          ? { entries: (s.inscription.entries ?? []).map((e) => ({ ...e })), charactersUsed: s.inscription.charactersUsed ?? 0 }
          : null,
        demolishProgress: s.demolishProgress ? { ...s.demolishProgress } : null,
        builtAtTick: s.builtAtTick ?? s.history?.[0]?.tick ?? null,
        history: (s.history ?? []).map((h) => ({ ...h })),
      }
    : null;

export function applyTick(state, rec) {
  state.tick = rec.tick;
  state.simTime = rec.simTime ?? state.simTime;
  if (rec.runId) state.runId = rec.runId;
  if (rec.spend) state.spend = rec.spend.map((s) => ({ ...s }));
  // v0.8: the situationChanged flags computed at this tick's OPEN — the
  // lever the analyst's watch mode and the ticker's notability gate ride.
  state.lastSituations = (rec.situations ?? []).map((s) => ({ ...s }));

  // 1. Events, appended in daemon order, stamped for the feed and the norm
  //    tracker. Personas and lineage fall out of specific event types.
  for (const ev of rec.events ?? []) {
    state.events.push({ tick: rec.tick, simTime: rec.simTime, ...ev });
    if ((ev.type === "registered" || ev.type === "claimed") && ev.persona) {
      state.personas.set(ev.agentId, { ...ev.persona });
    }
    if (ev.type === "beget") {
      state.lineage.edges.push({
        parent: ev.agentId,
        child: ev.infantId,
        bornAtTick: ev.tick ?? rec.tick,
        fosteredBy: null,
        // Knowledge inheritance (scry spec v0.9 §4): marked on the lineage
        // node only — the inherited content is the child's memory now.
        inherited: ev.inherited === true,
      });
    }
    if (ev.type === "foster") {
      const edge = state.lineage.edges.find((e) => e.child === ev.infantId);
      if (edge) edge.fosteredBy = ev.agentId;
    }
    if (ev.type === "death") {
      state.departed.set(ev.agentId, {
        name: ev.name ?? null,
        appearance: state.agents.get(ev.agentId)?.appearance ?? null,
        diedAtTick: ev.tick ?? rec.tick,
        // v0.6 §8: whether reachable food existed at death, from the record.
        foodAtDeath: ev.foodAtDeath ?? null,
        foodReachable: ev.foodReachable ?? null,
      });
    }
    if (ev.type === "released" || ev.type === "reaped") {
      state.departed.set(ev.agentId, {
        name: ev.name ?? state.agents.get(ev.agentId)?.name ?? null,
        appearance: state.agents.get(ev.agentId)?.appearance ?? null,
        diedAtTick: null,
      });
    }
  }

  // 2. Cells: the record carries every non-empty cell in full; everything
  //    else is empty. Authoritative, no drift.
  blankGrid(state);
  for (const c of rec.cells ?? []) {
    state.cells.set(c.coord, {
      coord: c.coord,
      deposit: c.deposit ? { ...c.deposit } : null,
      loose: c.loose ? { ...c.loose } : null,
      structure: cloneStructure(c.structure),
      corpses: (c.corpses ?? []).map((k) => ({ ...k, authored: { ...k.authored }, appearance: { ...k.appearance } })),
      fragment: c.fragment ? structuredClone(c.fragment) : null,
    });
  }

  // 3. Bodies: authoritative roster. Agents absent from the record are gone
  //    (death, release, reaping — the event above said which).
  const next = new Map();
  for (const b of rec.bodies ?? []) {
    next.set(b.agentId, foldBody(state.agents.get(b.agentId), b, rec.tick));
  }
  state.agents = next;

  // 4. Memory writes of this tick, appended to their agents' streams.
  for (const m of rec.memories ?? []) {
    const agent = state.agents.get(m.agentId);
    if (agent) {
      const { agentId, ...entry } = m;
      agent.memories.push(entry);
    }
  }

  // 5. knownCells reconstruction — the same rule the daemon applies: at
  //    RESOLVED every agent re-snapshots the cell it now stands in, deep
  //    copy, stale everywhere else. Fold from the authoritative cells above.
  for (const agent of state.agents.values()) {
    if (!(agent.knownCells instanceof Map)) agent.knownCells = new Map(agent.knownCells);
    const seenCell = state.cells.get(agent.coord);
    agent.knownCells.set(agent.coord, {
      structure: cloneStructure(seenCell?.structure ?? null),
      // v0.9 cell hover: the believed deposit and loose pile as of this
      // stand — what "Rook last saw here" is made of.
      deposit: seenCell?.deposit ? { ...seenCell.deposit } : null,
      loose: seenCell?.loose ? { ...seenCell.loose } : null,
      lastSeenTick: rec.tick,
    });
  }

  // 6. Actions: latency for the thinking-state renderer, miss counting for
  //    the roster, last action type for the feed.
  for (const a of rec.actions ?? []) {
    const agent = state.agents.get(a.agentId);
    if (!agent) continue;
    agent.lastActionType = a.type;
    agent.lastActionLatencyMs = a.latencyMs ?? null;
    agent.consecutiveMisses = a.assigned ? agent.consecutiveMisses + 1 : 0;
  }

  return state;
}

// ---------- snapshot (live connect / reconnect) ----------

export function applySnapshot(state, snap) {
  const fresh = createState();
  fresh.runId = snap.runId ?? null;
  fresh.tick = snap.tick ?? 0;
  fresh.simTime = snap.simTime ?? null;
  fresh.paused = snap.paused === true;
  fresh.stopped = snap.stopped === true;
  fresh.waitingForAgents = snap.waitingForAgents === true;
  fresh.crosscheckStatus = snap.crosscheck ?? null; // v0.8: supervision state at connect
  fresh.slots = snap.slots ? { ...snap.slots } : null;
  fresh.gridSize = snap.gridSize ?? 0;
  fresh.premise = snap.premise ?? null;
  fresh.maxTicks = snap.maxTicks ?? null;
  fresh.viability = snap.viability ? { ...snap.viability } : null;
  fresh.constructionSlack = snap.constructionSlack ? { ...snap.constructionSlack } : null;
  fresh.inscriptionMax = snap.inscriptionMax ?? null;
  fresh.spend = (snap.spend ?? []).map((s) => ({ ...s }));
  // A live connect at tick N has no event history before N — replay owns it.
  fresh.liveSince = snap.tick ?? 0;
  blankGrid(fresh);
  for (const c of snap.cells ?? []) {
    fresh.cells.set(c.coord, {
      coord: c.coord,
      deposit: c.deposit ? { resource: c.deposit.resource, quantity: c.deposit.quantity } : null,
      loose: c.loose ? { ...c.loose } : null,
      structure: cloneStructure(c.structure),
      corpses: (c.corpses ?? []).map((k) => ({ ...k, authored: { ...k.authored }, appearance: { ...k.appearance } })),
      fragment: c.fragment ? structuredClone(c.fragment) : null,
    });
  }
  for (const a of snap.agents ?? []) {
    if (a.persona) fresh.personas.set(a.id, { ...a.persona });
    fresh.agents.set(a.id, {
      agentId: a.id,
      name: a.persona?.name ?? null,
      coord: a.coord,
      prevCoord: a.coord,
      lifeStage: a.lifeStage,
      connectionState: a.connection?.state ?? null,
      clientName: a.connection?.clientName ?? null,
      modelHint: a.connection?.modelHint ?? null,
      surface: a.connection?.surface ?? null,
      clientStatus: a.clientStatus ?? null,
      vitality: a.vitality,
      sustenance: a.sustenance,
      inventory: { ...a.inventory },
      appearance: a.appearance ? { ...a.appearance } : null,
      currentIntent: a.currentIntent ?? null,
      lastReason: a.lastReason ?? null,
      sponsorId: a.sponsorId ?? null,
      bornAtTick: a.bornAtTick ?? null,
      unsponsoredAtTick: a.unsponsoredAtTick ?? null,
      heritage: a.heritage ?? null,
      memories: (a.memories ?? []).map((m) => ({ ...m })),
      knownCells: new Map(
        (a.knownCells ?? []).map((k) => [k.coord, { structure: cloneStructure(k.structure), lastSeenTick: k.lastSeenTick }])
      ),
      consecutiveMisses: a.connection?.consecutiveMisses ?? 0,
      lastActionType: a.lastActionOutcome?.type ?? null,
      lastActionLatencyMs: a.connection?.lastActionLatencyMs ?? null,
      lastSeenTick: snap.tick ?? 0,
    });
    // Heritage in a snapshot implies a birth this run or an earlier one; the
    // lineage panel folds edges from events, and a mid-run connect only has
    // what the snapshot can prove. Reconstruct the birth edge when visible.
    if (a.heritage && a.sponsorId == null && a.bornAtTick != null) {
      // parent id is not in the heritage brief (by design); leave the edge to
      // event folding when available.
    }
  }
  return fresh;
}

// ---------- one entry point for any record ----------

// Both sources push their records through this. `state` may be null (before
// the first bootstrap arrives).
export function reduce(state, record) {
  if (!record || typeof record !== "object") return state;
  if (record.event === "run_started" || record.type === "run_started") {
    return applyRunStarted(state, record);
  }
  if (record.tick != null && (record.bodies || record.cells || record.summary)) {
    if (!state) return state; // a tick with no bootstrap yet: nothing to fold onto
    return applyTick(state, record);
  }
  return state;
}

// ---------- deep clone (keyframes) and canonical serialization (diffing) ----------

export function cloneState(state) {
  const c = createState();
  c.runId = state.runId;
  c.tick = state.tick;
  c.simTime = state.simTime;
  c.paused = state.paused;
  c.stopped = state.stopped;
  c.waitingForAgents = state.waitingForAgents;
  c.slots = state.slots ? { ...state.slots } : null;
  c.lastSituations = state.lastSituations.map((s) => ({ ...s }));
  c.gridSize = state.gridSize;
  c.premise = state.premise;
  c.carryLimit = state.carryLimit;
  c.maxTicks = state.maxTicks;
  c.cells = new Map([...state.cells].map(([k, v]) => [k, structuredClone(v)]));
  c.agents = new Map(
    [...state.agents].map(([k, a]) => [
      k,
      { ...structuredClone({ ...a, knownCells: null }), knownCells: new Map([...a.knownCells].map(([kk, vv]) => [kk, structuredClone(vv)])) },
    ])
  );
  c.departed = new Map([...state.departed].map(([k, v]) => [k, structuredClone(v)]));
  c.viability = state.viability ? { ...state.viability } : null;
  c.constructionSlack = state.constructionSlack ? { ...state.constructionSlack } : null;
  c.inscriptionMax = state.inscriptionMax;
  c.spend = state.spend.map((s) => ({ ...s }));
  c.liveSince = state.liveSince;
  c.events = state.events.map((e) => ({ ...e }));
  c.lineage = { edges: state.lineage.edges.map((e) => ({ ...e })) };
  c.personas = new Map([...state.personas].map(([k, v]) => [k, structuredClone(v)]));
  return c;
}

// A stable JSON form for acceptance test 3: live and replay must serialize
// identically at the same tick.
export function serializeState(state) {
  return JSON.stringify({
    runId: state.runId,
    tick: state.tick,
    simTime: state.simTime,
    gridSize: state.gridSize,
    cells: [...state.cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    agents: [...state.agents.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, a]) => [id, { ...a, knownCells: [...a.knownCells.entries()].sort(([x], [y]) => (x < y ? -1 : 1)) }]),
    events: state.events,
    lineage: state.lineage,
    personas: [...state.personas.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  });
}
