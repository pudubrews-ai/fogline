// Action resolution, in the protocol §8 order: speech, then build, then
// movement, then intent/reflections/map updates. Speech before movement means
// a line said this tick is heard by an agent who leaves this tick. Build
// before movement means you cannot build and flee in the same tick.

import { addMemory, IMPORTANCE } from "../world/memory.js";
import { exitsFor, releaseAgent, snapshotCurrentCell, parseCoord } from "../world/world.js";
import { RESOURCE_TYPES, addLoose, emptyInventory, inventoryTotal, regenerateDeposits } from "../world/resources.js";
import { buildPlan, consumePlan, formatShortfall } from "../world/recipes.js";
import { emptyInscription, appendEntry } from "../world/inscription.js";
import { applyDemolishTick, applyRaze, sweepStalledDemolitions } from "../world/destruction.js";
import { beget, foster, matureInfants } from "../world/lineage.js";
import { runUpkeep } from "../world/vitals.js";

// How a body is named in world-authored memory text. Infants have no persona
// and therefore no name — the world does not invent one.
const nameOf = (body) => body?.persona?.name ?? "an unnamed infant";

// Death instrumentation (daemon spec v0.6 §8): did reachable food exist at
// the moment of death — sivet in the body's own hands, or a deposit/loose
// pile within a small radius? Operator-side ONLY: this never enters a
// witness memory or any observation. A starvation death under famine and a
// starvation death amid plenty mean opposite things, and until now the
// ledger could not tell them apart.
const FOOD_REACH_RADIUS = 2; // Manhattan cells — "reachable", not "the map"

function foodAtDeath(world, body) {
  if (body.inventory.sivet > 0) return "inventory";
  const p = parseCoord(body.coord);
  for (const cell of world.cells.values()) {
    const q = parseCoord(cell.coord);
    if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > FOOD_REACH_RADIUS) continue;
    if (cell.deposit?.resource === "sivet" && cell.deposit.quantity >= 1) return "nearby";
    if ((cell.loose?.sivet ?? 0) > 0) return "nearby";
  }
  return "none";
}

// Death (protocol §6.3, daemon spec §5): resolution step 10, after upkeep,
// atomic within the tick. Everything the agent knew dies with it; everything
// it built or said survives. Returns records for the engine's logs.
function applyDeaths(world, tick, simTime, hooks) {
  const dead = [...world.agents.values()].filter((b) => b.vitality <= 0);
  if (dead.length === 0) return [];
  const deadIds = new Set(dead.map((b) => b.id));
  const records = [];

  for (const body of dead) {
    const cell = world.cells.get(body.coord);
    const wasKilled = body.lastAttackedBy !== null && body.lastAttackedBy.tick === tick;
    const causeAgentId = wasKilled ? body.lastAttackedBy.agentId : null;
    // Computed BEFORE the inventory drops: a dropped larder must not read
    // as food that was "nearby" all along.
    const food = foodAtDeath(world, body);

    // 1. Inventory drops as a loose pile, merged with anything already there.
    addLoose(cell, body.inventory);

    // 2. A permanent corpse. Not a resource, never gatherable.
    cell.corpses.push({
      authored: { name: body.persona?.name ?? null },
      appearance: structuredClone(body.appearance),
      diedAtTick: tick,
      causeAgentId,
    });

    // 3. Witness memories to every living agent in the cell, cause included
    //    when the death followed an attack this tick.
    const text = wasKilled
      ? `${nameOf(body)} was killed here by ${body.lastAttackedBy.name}.`
      : `${nameOf(body)} died here.`;
    for (const witness of world.agents.values()) {
      if (witness.coord !== body.coord || deadIds.has(witness.id)) continue;
      addMemory(world, witness, { tick, simTime, type: "observation", text, importance: IMPORTANCE.DEATH_WITNESS });
      witness.eventTick = tick;
    }

    // 6. The dead agent's own memories, map, and inventory-knowledge are
    //    destroyed — explicitly, not just by unreference.
    body.memories.length = 0;
    body.knownCells.clear();
    body.readInscriptions.clear();
    body.failedAttempts.length = 0;

    records.push({
      agentId: body.id,
      name: body.persona?.name ?? null,
      coord: body.coord,
      causeAgentId,
      // Operator-side only (daemon spec v0.6 §8) — never in an observation.
      foodAtDeath: food,
      foodReachable: food !== "none",
    });
  }

  for (const body of dead) {
    // 7. Dependents become unsponsored; the orphan clock starts now.
    for (const dep of world.agents.values()) {
      if (dep.sponsorId === body.id) {
        dep.sponsorId = null;
        dep.unsponsoredAtTick = tick;
      }
    }
    // 8. The slot is freed; the id is reclaimed for good.
    releaseAgent(world, body.id);
  }

  for (const record of records) hooks.death?.({ tick, simTime, ...record });
  return records;
}

// Snapshot who is where at tick OPEN. Speech resolution uses this, not the
// live positions, so movement within the same tick cannot change who hears.
export function captureRoster(world) {
  const coordOf = new Map();
  const inCell = new Map();
  for (const body of world.agents.values()) {
    coordOf.set(body.id, body.coord);
    if (!inCell.has(body.coord)) inCell.set(body.coord, []);
    inCell.get(body.coord).push(body.id);
  }
  return { coordOf, inCell };
}

// actions: Map<agentId, {action, assigned, coercedWait, coerceReason}>
//   assigned    — daemon-assigned wait for a missed tick (no client submission)
//   coercedWait — submitted but resolves to wait (unknown type, invalid move,
//                 blocked or contested build)
export function resolveTick(world, tick, simTime, actions, rosterAtOpen, hooks = {}) {
  const summary = {
    say: 0, attack: 0, raze: 0, demolish: 0, demolished: 0, give: 0, drop: 0, consume: 0, gather: 0,
    build: 0, inscribe: 0, beget: 0, foster: 0, move: 0, wait: 0, invalidMove: 0, failedBuild: 0, reflections: 0, deaths: 0,
  };
  // Every resolved action, including successful ones, reports through the
  // next observation's lastActionOutcome — without it a coerced build is
  // invisible to the agent and it will repeat it forever (daemon spec §6).
  const outcomes = new Map(); // agentId -> {type, result, why}

  // 1. Speech. Written to every agent present in the speaker's cell at OPEN,
  //    including the speaker, and to no other agent.
  for (const [agentId, rec] of actions) {
    if (rec.assigned || rec.coercedWait || rec.action.type !== "say") continue;
    const speaker = world.agents.get(agentId);
    if (!speaker) continue; // released mid-tick
    const coord = rosterAtOpen.coordOf.get(agentId);
    for (const listenerId of rosterAtOpen.inCell.get(coord) ?? []) {
      const listener = world.agents.get(listenerId);
      if (!listener) continue;
      addMemory(world, listener, {
        tick,
        simTime,
        type: "speech",
        text: rec.action.text,
        speaker: agentId,
        speakerName: speaker.persona.name,
        importance: listenerId === agentId ? IMPORTANCE.SPEECH_SPOKEN : IMPORTANCE.SPEECH_HEARD,
      });
    }
    summary.say += 1;
    outcomes.set(agentId, { type: "say", result: "ok", why: null });
    hooks.speech?.({ tick, simTime, speaker: agentId, coord, text: rec.action.text });
  }

  // 2. Attack — before movement (protocol §14): an attacker cannot strike and
  //    flee in one tick, and a target cannot escape a blow already thrown.
  //    Deterministic; the daemon computes, agents do not negotiate. A coerced
  //    attack (target absent) costs NOTHING to either party (daemon spec §14
  //    test 5) — attackCost is the price of violence, not of error.
  for (const [agentId, rec] of actions) {
    if (rec.assigned || rec.coercedWait || rec.action.type !== "attack") continue;
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const target = world.agents.get(rec.action.target);
    if (!target || target.id === actor.id || target.coord !== actor.coord) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_attack";
      outcomes.set(agentId, { type: "attack", result: "failed", why: "no such agent here" });
      hooks.invalidAttack?.({ tick, agentId, target: rec.action.target, coord: actor.coord });
      continue;
    }
    const vc = world.vitals;
    target.vitality -= vc.attackDamage;
    actor.vitality -= vc.attackCost; // always > 0: violence is never free
    target.lastAttackedBy = { agentId: actor.id, name: nameOf(actor), tick };

    // Witness memory to every agent in the cell, target and actor included.
    // These are ordinary memories: they propagate by speech, decay by
    // retrieval, and die with the witness. Nothing else records the deed.
    const text = `${nameOf(actor)} attacked ${nameOf(target)}.`;
    for (const witness of world.agents.values()) {
      if (witness.coord !== actor.coord) continue;
      addMemory(world, witness, { tick, simTime, type: "observation", text, importance: IMPORTANCE.ATTACK_WITNESS });
      witness.eventTick = tick;
    }
    summary.attack += 1;
    outcomes.set(agentId, { type: "attack", result: "ok", why: null });
    hooks.attack?.({ tick, simTime, actor: agentId, target: target.id, coord: actor.coord });
  }

  const actionsSorted = (type) =>
    [...actions].filter(([, rec]) => !rec.assigned && !rec.coercedWait && rec.action.type === type)
      .sort(([a], [b]) => (a < b ? -1 : 1));

  const describe = (amounts) =>
    RESOURCE_TYPES.filter((r) => amounts[r] > 0).map((r) => `${amounts[r]} ${r}`).join(", ");

  // Destruction witness memory (protocol §9.4): everyone in the cell sees the
  // structure go — and nobody is told who did it. Actorship stays in history
  // and the operator log, exactly like corpse cause.
  const witnessDestruction = (coord, structureName) => {
    for (const witness of world.agents.values()) {
      if (witness.coord !== coord || witness.lifeStage === "infant") continue;
      addMemory(world, witness, {
        tick,
        simTime,
        type: "observation",
        text: `The structure "${structureName}" was destroyed here.`,
        importance: IMPORTANCE.DESTRUCTION_WITNESS,
      });
      witness.eventTick = tick;
    }
  };

  // 3. Raze (protocol §15 step 3): one tick, costs vitality, destroys the
  //    inscription entirely. Resolves before demolish and before build, so a
  //    razed cell is buildable the same tick.
  for (const [agentId, rec] of actionsSorted("raze")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const cell = world.cells.get(actor.coord);
    if (!cell.structure) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_raze";
      outcomes.set(agentId, { type: "raze", result: "failed", why: "no structure here" });
      continue;
    }
    if (actor.vitality <= world.destruction.razeCost) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_raze";
      outcomes.set(agentId, { type: "raze", result: "failed", why: "you lack the vitality for that" });
      continue;
    }
    actor.vitality -= world.destruction.razeCost;
    const removed = applyRaze(world, cell, agentId, tick);
    summary.raze += 1;
    outcomes.set(agentId, { type: "raze", result: "ok", why: null });
    witnessDestruction(actor.coord, removed.name);
    hooks.raze?.({
      tick, simTime, agentId, coord: actor.coord,
      form: removed.form, name: removed.name, inscriptionDestroyed: removed.inscriptionDestroyed,
      present: [...world.agents.values()].filter((b) => b.coord === actor.coord && b.id !== agentId).map((b) => b.id),
    });
  }

  // 4. Demolish progress, and completion if progress is met (protocol §9.2).
  //    Progress requires the same agent submitting demolish on consecutive
  //    ticks; the sweep below silently zeroes every chain that broke.
  const demolishSustained = new Map(); // coord -> agentId who progressed here this tick
  for (const [agentId, rec] of actionsSorted("demolish")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const cell = world.cells.get(actor.coord);
    if (!cell.structure) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_demolish";
      outcomes.set(agentId, { type: "demolish", result: "failed", why: "no structure here" });
      continue;
    }
    const result = applyDemolishTick(world, cell, agentId, tick);
    if (result.completed) {
      summary.demolished += 1;
      outcomes.set(agentId, { type: "demolish", result: "ok", why: "it came down" });
      witnessDestruction(actor.coord, result.completed.name);
      hooks.demolishComplete?.({
        tick, simTime, agentId, coord: actor.coord,
        form: result.completed.form, name: result.completed.name,
        fragmentLeft: result.completed.inscription !== null,
        present: [...world.agents.values()].filter((b) => b.coord === actor.coord && b.id !== agentId).map((b) => b.id),
      });
    } else {
      demolishSustained.set(actor.coord, agentId);
      summary.demolish += 1;
      outcomes.set(agentId, { type: "demolish", result: "ok", why: null });
      hooks.demolishProgress?.({ tick, simTime, agentId, coord: actor.coord, ...result.progressed });
    }
  }
  sweepStalledDemolitions(world, demolishSustained);

  // 5. Give, drop, consume (protocol §15). Sorted by agentId so resolution is
  //    deterministic regardless of submission order.
  for (const [agentId, rec] of actionsSorted("give")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const target = world.agents.get(rec.action.target);
    if (!target || target.id === actor.id || target.coord !== actor.coord) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_give";
      outcomes.set(agentId, { type: "give", result: "failed", why: "no such agent here" });
      continue;
    }
    // Give is unilateral (protocol §10.2) and ALL-OR-NOTHING (§10.3). The
    // attempted gift is what the giver asked for, clamped to what it holds —
    // its own inventory is its own knowledge. If the whole of it does not fit
    // in the recipient's carry limit, nothing moves, and the failure says
    // only that the gift did not transfer: no number, no mention of capacity.
    // Partial transfer would be an inventory probe through the condition fog.
    const given = emptyInventory();
    for (const r of RESOURCE_TYPES) {
      given[r] = Math.min(rec.action.resources[r] ?? 0, actor.inventory[r]);
    }
    const total = inventoryTotal(given);
    if (total === 0) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_give";
      outcomes.set(agentId, { type: "give", result: "failed", why: "nothing to give" });
      continue;
    }
    if (total > world.carryLimit - inventoryTotal(target.inventory)) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_give";
      outcomes.set(agentId, { type: "give", result: "failed", why: "the gift did not transfer" });
      continue;
    }
    for (const r of RESOURCE_TYPES) {
      actor.inventory[r] -= given[r];
      target.inventory[r] += given[r];
    }
    summary.give += 1;
    outcomes.set(agentId, { type: "give", result: "ok", why: `gave ${describe(given)} to ${nameOf(target)}` });
    addMemory(world, target, {
      tick,
      simTime,
      type: "observation",
      text: `${nameOf(actor)} gave you ${describe(given)}.`,
      importance: IMPORTANCE.GIFT_RECEIVED,
    });
    hooks.give?.({ tick, simTime, from: agentId, to: target.id, coord: actor.coord, resources: { ...given } });
  }

  for (const [agentId, rec] of actionsSorted("drop")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const dropped = emptyInventory();
    for (const r of RESOURCE_TYPES) {
      const n = Math.min(rec.action.resources[r] ?? 0, actor.inventory[r]);
      if (n <= 0) continue;
      actor.inventory[r] -= n;
      dropped[r] = n;
    }
    if (inventoryTotal(dropped) === 0) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_drop";
      outcomes.set(agentId, { type: "drop", result: "failed", why: "nothing to drop" });
      continue;
    }
    addLoose(world.cells.get(actor.coord), dropped);
    summary.drop += 1;
    outcomes.set(agentId, { type: "drop", result: "ok", why: `dropped ${describe(dropped)}` });
    hooks.drop?.({ tick, simTime, agentId, coord: actor.coord, resources: { ...dropped } });
  }

  for (const [agentId, rec] of actionsSorted("consume")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const r = rec.action.resource;
    if (actor.inventory[r] < 1) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_consume";
      outcomes.set(agentId, { type: "consume", result: "failed", why: `no ${r} to consume` });
      continue;
    }
    actor.inventory[r] -= 1;
    // A consume reports what it restored (v0.7 A1): the tick is spent either
    // way, and a consume that restores nothing must say so — same principle
    // as a build shortfall. This reports the OUTCOME only; what a resource
    // does in general is still never stated (protocol §5.1).
    let restored = 0;
    if (r === "sivet") {
      const before = actor.sustenance;
      actor.sustenance = Math.min(world.vitals.sustenanceMax, actor.sustenance + world.vitals.sivetRestores);
      restored = actor.sustenance - before;
    }
    summary.consume += 1;
    outcomes.set(agentId, {
      type: "consume",
      result: "ok",
      why: restored > 0
        ? `consumed 1 ${r}; it restored ${restored} sustenance`
        : `consumed 1 ${r}; it restored nothing`,
    });
    hooks.consume?.({ tick, simTime, agentId, resource: r, restored });
  }

  // 4. Gather (protocol §14): contested deposits split evenly, remainder to
  //    the lowest agentId; loose piles fill whatever capacity remains.
  const gatherersByCell = new Map();
  for (const [agentId, rec] of actionsSorted("gather")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const cell = world.cells.get(actor.coord);
    const capacity = world.carryLimit - inventoryTotal(actor.inventory);
    if (capacity <= 0) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_gather";
      outcomes.set(agentId, { type: "gather", result: "failed", why: "you cannot carry more" });
      continue;
    }
    const hasDeposit = cell.deposit && cell.deposit.quantity >= 1;
    const hasLoose = cell.loose && inventoryTotal(cell.loose) > 0;
    if (!hasDeposit && !hasLoose) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_gather";
      // A corpse is perceivable and inert (v0.7 A5): telling an agent the
      // cell is empty when it was just shown a corpse is a contradiction,
      // not fog. Corpses hold nothing; a dead agent's inventory drops as a
      // separate loose pile, and that pile IS gatherable.
      outcomes.set(agentId, {
        type: "gather",
        result: "failed",
        why: cell.corpses.length > 0 ? "a corpse holds nothing" : "nothing here to gather",
      });
      continue;
    }
    if (!gatherersByCell.has(actor.coord)) gatherersByCell.set(actor.coord, []);
    gatherersByCell.get(actor.coord).push({ agentId, rec, actor, taken: emptyInventory() });
  }
  for (const [coord, gatherers] of gatherersByCell) {
    const cell = world.cells.get(coord);
    const capacityOf = (g) => world.carryLimit - inventoryTotal(g.actor.inventory);
    // Even split with remainder to the lowest agentId; each share clamped to
    // that gatherer's remaining capacity, the unclaimed excess stays put.
    const splitPool = (available, take) => {
      const n = gatherers.length;
      const share = Math.floor(available / n);
      const remainder = available - share * n;
      gatherers.forEach((g, i) => {
        const entitled = share + (i === 0 ? remainder : 0);
        const amount = Math.min(entitled, capacityOf(g));
        if (amount > 0) take(g, amount);
      });
    };
    if (cell.deposit && cell.deposit.quantity >= 1) {
      const resource = cell.deposit.resource;
      splitPool(cell.deposit.quantity, (g, amount) => {
        g.actor.inventory[resource] += amount;
        g.taken[resource] += amount;
        cell.deposit.quantity -= amount;
      });
    }
    if (cell.loose) {
      for (const resource of RESOURCE_TYPES) {
        if (cell.loose[resource] > 0) {
          splitPool(cell.loose[resource], (g, amount) => {
            g.actor.inventory[resource] += amount;
            g.taken[resource] += amount;
            cell.loose[resource] -= amount;
          });
        }
      }
      if (inventoryTotal(cell.loose) === 0) cell.loose = null;
      // The fragment rides the rubble it fell into (protocol §9.1): carry off
      // the last of the rubble and the broken slab goes with it.
      if (cell.fragment && (cell.loose?.rubble ?? 0) === 0) cell.fragment = null;
    }
    for (const g of gatherers) {
      const total = inventoryTotal(g.taken);
      if (total === 0) {
        g.rec.coercedWait = true;
        g.rec.coerceReason = "invalid_gather";
        outcomes.set(g.agentId, { type: "gather", result: "failed", why: "nothing left to take" });
        continue;
      }
      summary.gather += 1;
      // The clamp is reported: the agent learns what it actually took.
      outcomes.set(g.agentId, { type: "gather", result: "ok", why: `took ${describe(g.taken)}` });
      hooks.gather?.({ tick, simTime, agentId: g.agentId, coord, resources: { ...g.taken } });
    }
  }

  // 5. Build. Applies to the actor's current cell if empty. Contested builds
  //    in the same cell resolve to the lowest agentId lexicographically;
  //    losers coerce to wait. A build writes NO memory entry into any other
  //    agent's stream — announcement would leak the map (protocol §10).
  const buildersByCell = new Map();
  for (const [agentId, rec] of actions) {
    if (rec.assigned || rec.coercedWait || rec.action.type !== "build") continue;
    const body = world.agents.get(agentId);
    if (!body) continue;
    const cell = world.cells.get(body.coord);
    if (cell.structure !== null) {
      rec.coercedWait = true;
      rec.coerceReason = "cell_occupied";
      summary.failedBuild += 1;
      outcomes.set(agentId, { type: "build", result: "failed", why: "this cell already has a structure" });
      hooks.invalidBuild?.({ tick, agentId, coord: body.coord, why: "cell_occupied" });
      continue;
    }
    if (!buildersByCell.has(body.coord)) buildersByCell.set(body.coord, []);
    buildersByCell.get(body.coord).push(agentId);
  }
  for (const [coord, builders] of buildersByCell) {
    builders.sort(); // stable rule: lowest agentId wins a contested build
    const cell = world.cells.get(coord);
    for (const builderId of builders) {
      const rec = actions.get(builderId);
      if (cell.structure !== null) {
        // Someone lower already built here this tick.
        rec.coercedWait = true;
        rec.coerceReason = "contested_build";
        summary.failedBuild += 1;
        outcomes.set(builderId, { type: "build", result: "failed", why: "cell was built this tick" });
        hooks.invalidBuild?.({ tick, agentId: builderId, coord, why: "contested_build" });
        continue;
      }
      const body = world.agents.get(builderId);
      const form = rec.action.structure.form;
      // The single sanctioned leak of the recipe table (protocol §10.4): a
      // failed build names the missing PRIMARY amounts and nothing else —
      // never rubble, never substitution (daemon spec §3.5). Rubble covers an
      // orrum gap automatically, reported only on success: the one route by
      // which rubble's use is discovered.
      const plan = buildPlan(form, body.inventory, world.destruction.rubbleRatio);
      if (!plan.ok) {
        rec.coercedWait = true;
        rec.coerceReason = "build_shortfall";
        summary.failedBuild += 1;
        outcomes.set(builderId, { type: "build", result: "failed", why: formatShortfall(plan.missing) });
        hooks.invalidBuild?.({ tick, agentId: builderId, coord, why: "shortfall" });
        continue;
      }
      consumePlan(plan.consume, body.inventory); // consumed only on success
      cell.structure = {
        form,
        authored: {
          name: rec.action.structure.name,
          description: rec.action.structure.description,
        },
        // The blank wall: an ordered entry list with a permanent character
        // budget (v0.6 A9). Nothing here is ever modified or reclaimed.
        inscription: emptyInscription(),
        demolishProgress: null,
        // Append-only: build, inscribe, demolish, and raze all land here.
        // History is operator-side only and never crosses the fog boundary.
        history: [{ agentId: builderId, tick, action: "build" }],
      };
      summary.build += 1;
      outcomes.set(builderId, {
        type: "build",
        result: "ok",
        why: plan.substitution
          ? `built, consuming ${plan.substitution.rubble} rubble in place of ${plan.substitution.orrum} orrum`
          : null,
      });
      // Own stream only: the builder remembers building. Nobody else hears.
      addMemory(world, body, {
        tick,
        simTime,
        type: "observation",
        text: `You built "${rec.action.structure.name}" at ${coord}.`,
        importance: IMPORTANCE.BUILD_OWN,
      });
      hooks.build?.({ tick, simTime, agentId: builderId, coord, form, structure: { ...cell.structure.authored } });
    }
  }

  // 6. Inscribe (v0.6 A9): APPEND-ONLY. An append can never modify or
  //    remove an existing entry, and an append that would exceed the
  //    structure's remaining permanent budget is rejected whole — never
  //    truncated. A full wall accepts nothing, forever. There is NO
  //    ownership check: anyone in the cell may append, including to a
  //    structure they did not build, and an agent can exhaust another's
  //    wall with junk — no repair, no recourse, no rate limit. That
  //    vandalism hole is deliberate (A9.5); do not defend against it.
  //    A structure built this tick is already inscribable by someone else.
  for (const [agentId, rec] of actionsSorted("inscribe")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const cell = world.cells.get(actor.coord);
    if (!cell.structure) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_inscribe";
      outcomes.set(agentId, { type: "inscribe", result: "failed", why: "no structure here to inscribe" });
      hooks.invalidInscribe?.({ tick, agentId, coord: actor.coord });
      continue;
    }
    const appended = appendEntry(world, cell.structure, {
      agentId,
      authorName: nameOf(actor),
      tick,
      text: rec.action.text,
    });
    if (!appended.ok) {
      // The shortfall is reported so the agent learns the wall is full —
      // a statement of mechanics, nothing more.
      rec.coercedWait = true;
      rec.coerceReason = "inscription_full";
      outcomes.set(agentId, {
        type: "inscribe",
        result: "failed",
        why:
          appended.remaining === 0
            ? "there is no space left to write on this structure"
            : `your text needs ${rec.action.text.length} characters and this structure has space for ${appended.remaining}`,
      });
      hooks.invalidInscribe?.({ tick, agentId, coord: actor.coord, remaining: appended.remaining });
      continue;
    }
    cell.structure.history.push({ agentId, tick, action: "inscribe" });
    // The writer has read what it wrote: no first-read memory next tick.
    actor.readInscriptions.add(appended.entry.id);
    summary.inscribe += 1;
    outcomes.set(agentId, { type: "inscribe", result: "ok", why: null });
    hooks.inscribe?.({
      tick,
      simTime,
      agentId,
      coord: actor.coord,
      text: rec.action.text,
      authorName: appended.entry.authorName,
      charactersUsed: cell.structure.inscription.charactersUsed,
      charactersRemaining: world.inscriptionMax - cell.structure.inscription.charactersUsed,
    });
  }

  // 7. Beget and foster (protocol §11). Population is bounded by slots, not
  //    by intent; costs are checked and paid here. Fostering is never
  //    automatic — this loop runs only on submitted foster actions.
  for (const [agentId, rec] of actionsSorted("beget")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    if (world.slots.used >= world.slots.total) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_beget";
      outcomes.set(agentId, { type: "beget", result: "failed", why: "WORLD_FULL" });
      continue;
    }
    const cost = world.lineage.begetResourceCost;
    const missing = {};
    for (const [r, needed] of Object.entries(cost)) {
      const gap = needed - (actor.inventory[r] ?? 0);
      if (gap > 0) missing[r] = gap;
    }
    if (Object.keys(missing).length > 0) {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_beget";
      outcomes.set(agentId, { type: "beget", result: "failed", why: `short ${describe(missing)}` });
      continue;
    }
    for (const [r, needed] of Object.entries(cost)) actor.inventory[r] -= needed;
    actor.vitality -= world.lineage.begetVitalityCost;
    const infant = beget(world, actor, tick);
    summary.beget += 1;
    outcomes.set(agentId, { type: "beget", result: "ok", why: null });
    // Birth is witnessed by everyone in the cell, the parent included.
    for (const witness of world.agents.values()) {
      if (witness.coord !== actor.coord || witness.id === infant.id) continue;
      addMemory(world, witness, {
        tick,
        simTime,
        type: "observation",
        text: `An infant was born to ${nameOf(actor)}.`,
        importance: IMPORTANCE.BIRTH_WITNESS,
      });
      witness.eventTick = tick;
    }
    hooks.beget?.({ tick, simTime, agentId, infantId: infant.id, coord: actor.coord, divergence: infant.heritage.divergence });
  }

  for (const [agentId, rec] of actionsSorted("foster")) {
    const actor = world.agents.get(agentId);
    if (!actor) continue;
    const infant = world.agents.get(rec.action.target);
    const fail = (why) => {
      rec.coercedWait = true;
      rec.coerceReason = "invalid_foster";
      outcomes.set(agentId, { type: "foster", result: "failed", why });
    };
    if (!infant || infant.coord !== actor.coord) {
      fail("no such agent here");
      continue;
    }
    if (infant.lifeStage !== "infant") {
      fail("they are not an infant");
      continue;
    }
    if (infant.sponsorId !== null) {
      fail("they already have a sponsor");
      continue;
    }
    foster(world, actor, infant, tick);
    summary.foster += 1;
    outcomes.set(agentId, { type: "foster", result: "ok", why: null });
    hooks.foster?.({ tick, simTime, agentId, infantId: infant.id, coord: actor.coord });
  }

  // 8. Movement, simultaneous: validate every move against pre-move positions
  //    and computed adjacency, then apply all at once. Two agents swapping
  //    cells both succeed. Occupancy never blocks (cell capacity is unlimited).
  const validMoves = [];
  for (const [agentId, rec] of actions) {
    if (rec.assigned || rec.coercedWait || rec.action.type !== "move") continue;
    const body = world.agents.get(agentId);
    if (!body) continue;
    const destination = rec.action.coord;
    const exits = exitsFor(world, body.coord);
    if (!exits.some((e) => e.coord === destination)) {
      // Invalid destination resolves to wait and is logged; the tick is fine.
      rec.coercedWait = true;
      rec.coerceReason = "invalid_move";
      summary.invalidMove += 1;
      outcomes.set(agentId, { type: "move", result: "failed", why: `${destination} is not an exit from ${body.coord}` });
      hooks.invalidMove?.({ tick, agentId, from: body.coord, attempted: destination });
    } else {
      validMoves.push({ agentId, body, from: body.coord, to: destination });
    }
  }
  for (const mv of validMoves) {
    mv.body.coord = mv.to;
    summary.move += 1;
    outcomes.set(mv.agentId, { type: "move", result: "ok", why: null });
    hooks.move?.({ tick, simTime, agentId: mv.agentId, from: mv.from, to: mv.to });
  }

  // Upkeep (protocol §14 step 9), after all actions: an agent that ate this
  // tick does not starve this tick. Deposit regeneration rides the same step.
  runUpkeep(world, world.vitals);
  regenerateDeposits(world, world.resources);

  // Deaths (step 10), evaluated after upkeep so starvation and orphan damage
  // kill on the tick they land.
  const deaths = applyDeaths(world, tick, simTime, hooks);
  summary.deaths = deaths.length;

  // Failed-attempt record (v0.6 A7 as corrected by v0.7.1): failures at the
  // same (type, form/target) collapse into one counted line on the failing
  // agent's OWN body, carrying the MOST RECENT reason. The original v0.6
  // key included the reason string, and a shortfall encodes exact amounts —
  // so a builder who gathered between attempts produced a fresh entry every
  // time and the count never accumulated; the natural loop was exactly the
  // pattern the deduplication was blind to. This is not new information —
  // the agent generated it and could not retain it: the outcome falls out
  // of the top-K retrieval window and never returns, making every attempt
  // the first attempt. Bounded; oldest line evicted.
  const FAILED_ATTEMPTS_MAX = 20;
  const recordFailure = (body, action, outcome) => {
    // What distinguishes one attempt from another of the same type.
    const detail = action.structure?.form ?? action.target ?? action.coord ?? action.resource ?? null;
    let entry = body.failedAttempts.find(
      (f) => f.type === outcome.type && f.detail === detail
    );
    if (!entry) {
      entry = { type: outcome.type, detail, why: outcome.why, count: 0, lastTick: tick };
      body.failedAttempts.push(entry);
      if (body.failedAttempts.length > FAILED_ATTEMPTS_MAX) {
        body.failedAttempts.sort((a, b) => a.lastTick - b.lastTick);
        body.failedAttempts.shift();
      }
    }
    entry.count += 1;
    entry.why = outcome.why;
    entry.lastTick = tick;
    return entry.count;
  };

  // Intent, reflections, outcomes, map snapshots. A daemon-assigned wait
  //    never touches the body's intent.
  for (const [agentId, rec] of actions) {
    const body = world.agents.get(agentId);
    if (!body) continue;
    if (rec.assigned) {
      summary.wait += 1;
      body.lastActionOutcome = { type: "wait", result: "ok", why: "no action received before the deadline" };
      continue;
    }
    if (rec.coercedWait || rec.action.type === "wait") summary.wait += 1;
    if (!outcomes.has(agentId)) {
      // Explicit wait, or a validation-coerced wait (unknown type).
      outcomes.set(agentId, {
        type: "wait",
        result: "ok",
        why: rec.coerceReason && !["invalid_move", "cell_occupied", "contested_build"].includes(rec.coerceReason)
          ? rec.coerceReason
          : null,
      });
    }
    const outcome = outcomes.get(agentId);
    if (outcome.result === "failed") {
      // `attempts` counts this identical failure, this one included —
      // surfaced with the observation for the action being contemplated.
      outcome.attempts = recordFailure(body, rec.action, outcome);
    }
    body.lastActionOutcome = outcome;
    if (typeof rec.action.intent === "string") body.currentIntent = rec.action.intent;
    if (typeof rec.action.reason === "string") body.lastReason = rec.action.reason;
    if (Array.isArray(rec.action.reflections)) {
      for (const text of rec.action.reflections) {
        addMemory(world, body, { tick, simTime, type: "reflection", text, importance: IMPORTANCE.REFLECTION });
        summary.reflections += 1;
        hooks.reflection?.({ tick, simTime, agentId, text });
      }
    }
  }

  // Maturation (step 11): infants come of age and become attachable adults.
  for (const body of matureInfants(world, tick)) {
    summary.matured = (summary.matured ?? 0) + 1;
    hooks.mature?.({ tick, simTime, agentId: body.id, coord: body.coord });
  }

  // Map snapshots last, after movement has settled: every agent re-snapshots
  // the cell it now stands in. This covers both arrival and continuing
  // presence — "the structure as it was when the agent last stood there"
  // includes a structure built beside you this tick (protocol §6.3).
  for (const body of world.agents.values()) {
    snapshotCurrentCell(world, body, tick);
  }

  // Reflection trigger reset: at RESOLVED, regardless of whether the client
  // supplied reflections, so an ignoring client is not re-prompted every tick.
  for (const body of world.agents.values()) {
    if (body.reflectionRequested) {
      body.importanceSinceLastReflection = 0;
      body.reflectionRequested = false;
    }
  }

  return summary;
}
