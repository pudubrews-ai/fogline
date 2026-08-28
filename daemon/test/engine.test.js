import { defaultDefinition } from "../world/definition.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, createAgent, snapshotCurrentCell } from "../world/world.js";
import { TickEngine, validateAction } from "../engine/tick.js";
import { persona } from "./helpers.js";

const baseConfig = {
  gridSize: 4,
  slots: 6,
  minAgents: 2,
  minutesPerTick: 15,
  actionDeadlineMs: 60,
  maxTicks: 100,
  startSimTime: "09:00",
  retrievalK: 5,
  reflectionThreshold: 40,
  stalledAfterMisses: 3,
  reapAfterTicks: 1000,
  startPaused: false,
};

// Register agents directly into the engine's world with pinned coordinates.
// `connect` gives an agent a token so the engine treats it as attached;
// without it the body is set unmanned (nothing driving it).
function makeEngine(configOverrides = {}, agentDefs = [{ name: "Rune", coord: "0,0" }, { name: "Devi", coord: "3,3" }], { barrier = [], connect = ["Rune", "Devi"] } = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const engine = new TickEngine({
    worldFactory: () => createWorld({ defaults: defaultDefinition(),  gridSize: config.gridSize, slots: config.slots }),
    config,
    barrierLog: (line) => barrier.push(line),
  });
  const byName = {};
  for (const def of agentDefs) {
    const body = createAgent(engine.world, persona(def.name), 0);
    body.coord = def.coord;
    body.knownCells.clear();
    snapshotCurrentCell(engine.world, body, 0);
    if (connect.includes(def.name)) {
      body.connection.token = `test-token-${def.name}`;
      body.connection.state = "active";
    } else {
      body.connection.state = "unmanned";
      body.connection.unmannedSinceTick = 0;
    }
    byName[def.name] = body;
  }
  return { engine, byName };
}

function waitForTick(engine, tickNumber) {
  // Early close can resolve a tick synchronously inside submitAction, before
  // this listener attaches — check the engine's record first.
  if (engine.lastResolved && engine.lastResolved.tick >= tickNumber) {
    return Promise.resolve(engine.lastResolved);
  }
  return new Promise((resolve) => {
    const listener = ({ event, data }) => {
      if (event === "barrier" && data.event === "tick_resolved" && data.tick >= tickNumber) {
        engine.off("operator", listener);
        resolve(data);
      }
    };
    engine.on("operator", listener);
  });
}

function act(engine, body, overrides = {}) {
  return engine.submitAction(body.id, {
    protocol: "0.2",
    tick: engine.tick,
    type: "wait",
    coord: null,
    text: null,
    structure: null,
    intent: "idling",
    reason: "test",
    reflections: null,
    ...overrides,
  });
}

test("no clients: agents resolve to wait, misses climb, they stay unmanned, clean barrier cycles", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ maxTicks: 5 }, undefined, { barrier, connect: [] });
  engine.start();
  await waitForTick(engine, 5);
  engine.dispose();

  const rune = byName.Rune;
  assert.equal(rune.connection.consecutiveMisses, 5);
  assert.equal(rune.connection.state, "unmanned", "nothing attached: unmanned, never stalled");
  assert.equal(engine.stopped, true);

  const opens = barrier.filter((l) => l.event === "tick_open").map((l) => l.tick);
  const closes = barrier.filter((l) => l.event === "tick_closed").map((l) => l.tick);
  const resolves = barrier.filter((l) => l.event === "tick_resolved").map((l) => l.tick);
  assert.deepEqual(opens, [1, 2, 3, 4, 5]);
  assert.deepEqual(closes, [1, 2, 3, 4, 5]);
  assert.deepEqual(resolves, [1, 2, 3, 4, 5]);
  assert.ok(
    barrier.filter((l) => l.event === "action_missed").every((l) => l.state === "unmanned"),
    "no miss ever transitions an unmanned body"
  );
  assert.ok(
    barrier.filter((l) => l.event === "tick_closed").every((l) => l.reason === "deadline"),
    "zero submissions never close a tick early"
  );
});

test("minAgents gate: the engine does not open tick 1 until enough agents are registered", async () => {
  const barrier = [];
  const config = { ...baseConfig, minAgents: 2, maxTicks: 3 };
  const engine = new TickEngine({
    worldFactory: () => createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 6 }),
    config,
    barrierLog: (line) => barrier.push(line),
  });
  engine.start(); // empty world: gate holds
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.tick, 0, "no tick with zero agents");
  assert.ok(barrier.some((l) => l.event === "waiting_for_agents"));

  createAgent(engine.world, persona("Solo"), 0);
  engine.agentRegistered();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.tick, 0, "one agent is still below minAgents=2");

  createAgent(engine.world, persona("Duo"), 0);
  engine.agentRegistered();
  await waitForTick(engine, 1);
  engine.dispose();
  assert.ok(engine.tick >= 1, "gate released at minAgents");
});

test("connected but silent clients go stalled at exactly 3 misses", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ maxTicks: 5 }, undefined, { barrier });
  engine.start();
  await waitForTick(engine, 5);
  engine.dispose();

  assert.equal(byName.Rune.connection.consecutiveMisses, 5);
  assert.equal(byName.Rune.connection.state, "stalled");
  const stalledAt = barrier.find((l) => l.event === "action_missed" && l.state === "stalled");
  assert.equal(stalledAt.tick, 3, "stalled exactly at the third consecutive miss");
});

test("unmanned body does not block an early close", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ actionDeadlineMs: 5000, maxTicks: 1 }, undefined, { barrier, connect: ["Rune"] });
  engine.start();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  act(engine, byName.Rune);
  await waitForTick(engine, 1);
  engine.dispose();
  assert.ok(Date.now() - t0 < 1000, "closed as soon as the only connected agent acted");
  assert.equal(barrier.find((l) => l.event === "tick_closed").reason, "all_acted");
  const deviMiss = barrier.find((l) => l.event === "action_missed" && l.agentId === byName.Devi.id);
  assert.equal(deviMiss.state, "unmanned");
});

test("late action is rejected TICK_CLOSED and never queued for the next tick", async () => {
  const { engine, byName } = makeEngine({ maxTicks: 3 });
  engine.start();
  await waitForTick(engine, 1);
  // Tick 1 just resolved; phase RESOLVED, tick still 1 → TICK_CLOSED.
  const r = act(engine, byName.Rune, { tick: 1, type: "say", text: "too late", coord: null });
  assert.deepEqual(r, { ok: false, code: "TICK_CLOSED" });
  await waitForTick(engine, 2);
  engine.dispose();
  assert.equal(byName.Rune.memories.filter((m) => m.type === "speech").length, 0, "late say never resolved");
  assert.equal(byName.Rune.connection.consecutiveMisses >= 1, true);
});

test("WRONG_TICK, ALREADY_ACTED, INVALID_ACTION", async () => {
  const { engine, byName } = makeEngine({ actionDeadlineMs: 500, maxTicks: 1 });
  engine.start();
  await new Promise((r) => setTimeout(r, 20)); // now COLLECTING tick 1

  assert.equal(act(engine, byName.Rune, { tick: 99 }).code, "WRONG_TICK");
  assert.equal(act(engine, byName.Rune, { type: "say", text: null, coord: null }).code, "INVALID_ACTION");
  assert.equal(act(engine, byName.Rune, { type: "say", text: "hi", coord: "1,0" }).code, "INVALID_ACTION");
  // v0.4: null intent/reason are VALID (protocol §10.1); a non-string,
  // non-null intent is still a structural violation.
  assert.equal(act(engine, byName.Rune, { intent: 42 }).code, "INVALID_ACTION");
  assert.equal(act(engine, byName.Rune).ok, true);
  assert.equal(act(engine, byName.Rune).code, "ALREADY_ACTED");
  await waitForTick(engine, 1);
  engine.dispose();
});

test("unknown action type is accepted and resolves to wait; the outcome reports it", async () => {
  const { engine, byName } = makeEngine({ actionDeadlineMs: 500, maxTicks: 1 });
  engine.start();
  await new Promise((r) => setTimeout(r, 20));
  const r = act(engine, byName.Rune, { type: "dance" });
  assert.equal(r.ok, true, "unknown type is not a schema violation");
  act(engine, byName.Devi);
  await waitForTick(engine, 1);
  engine.dispose();
  assert.equal(byName.Rune.coord, "0,0");
  assert.equal(byName.Rune.currentIntent, "idling", "intent still stored");
  assert.equal(byName.Rune.lastActionOutcome.type, "wait");
  assert.equal(byName.Rune.lastActionOutcome.why, "unknown_type:dance");
});

test("invalid move destination resolves to wait, is logged, and does not error the tick", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ actionDeadlineMs: 500, maxTicks: 2 }, undefined, { barrier });
  engine.start();
  await new Promise((r) => setTimeout(r, 20));
  const r = act(engine, byName.Rune, { type: "move", coord: "3,0", text: null }); // not adjacent to 0,0
  assert.equal(r.ok, true);
  act(engine, byName.Devi);
  const resolved = await waitForTick(engine, 1);
  assert.equal(byName.Rune.coord, "0,0", "did not move");
  assert.equal(resolved.summary.invalidMove, 1);
  assert.equal(byName.Rune.lastActionOutcome.result, "failed");
  await waitForTick(engine, 2);
  engine.dispose();
});

test("speech resolves before movement; both hear, mover leaves same tick; swap succeeds", async () => {
  const { engine, byName } = makeEngine(
    { actionDeadlineMs: 500, maxTicks: 3 },
    [{ name: "Rune", coord: "1,1" }, { name: "Devi", coord: "1,1" }]
  );
  engine.start();
  await new Promise((r) => setTimeout(r, 20));

  act(engine, byName.Rune, { type: "say", text: "goodbye then", coord: null });
  act(engine, byName.Devi, { type: "move", coord: "1,2", text: null });
  await waitForTick(engine, 1);

  assert.equal(byName.Devi.coord, "1,2");
  const heardEntry = byName.Devi.memories.find((m) => m.type === "speech");
  assert.equal(heardEntry.text, "goodbye then", "heard the line said as they walked out");

  // Simultaneous swap: rune -> 1,2, devi -> 1,1, both succeed.
  await new Promise((r) => setTimeout(r, 20));
  act(engine, byName.Rune, { type: "move", coord: "1,2", text: null });
  act(engine, byName.Devi, { type: "move", coord: "1,1", text: null });
  await waitForTick(engine, 2);
  engine.dispose();
  assert.equal(byName.Rune.coord, "1,2");
  assert.equal(byName.Devi.coord, "1,1");
});

test("pause gate: pause holds before next OPEN, never mid-tick; step runs exactly one cycle", async () => {
  const barrier = [];
  const { engine } = makeEngine({ startPaused: true, actionDeadlineMs: 40 }, undefined, { barrier });
  engine.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(engine.tick, 0, "startPaused holds before tick 1");

  engine.step();
  await waitForTick(engine, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.tick, 1, "step ran exactly one cycle and re-paused");
  assert.equal(engine.phase, "RESOLVED");

  engine.play();
  await waitForTick(engine, 3);
  engine.pause();
  const tickAtPause = engine.tick;
  await new Promise((r) => setTimeout(r, 150));
  engine.dispose();
  assert.ok(engine.tick <= tickAtPause + 1, "at most the in-flight tick completed after pause");
  const lastOpen = barrier.filter((l) => l.event === "tick_open").at(-1).tick;
  const lastResolve = barrier.filter((l) => l.event === "tick_resolved").at(-1).tick;
  assert.equal(lastOpen, lastResolve, "no tick left mid-flight by pause");
});

test("reflection trigger: requested once threshold crossed, counter reset even if ignored", async () => {
  // Agents apart: tick 1 perceptions give importance 2 (< 3). The say pushes
  // Rune over the threshold, so the request appears in tick 2's observation.
  const { engine, byName } = makeEngine({ actionDeadlineMs: 500, maxTicks: 4, reflectionThreshold: 3 });
  engine.start();
  await new Promise((r) => setTimeout(r, 20));
  act(engine, byName.Rune, { type: "say", text: "thinking hard about the tower", coord: null });
  act(engine, byName.Devi);
  await waitForTick(engine, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.lastObservationFor(byName.Rune.id).reflectionRequested, true);
  // Ignore the flag; counter must reset at RESOLVED — no re-prompt next tick.
  act(engine, byName.Rune);
  act(engine, byName.Devi);
  await waitForTick(engine, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.lastObservationFor(byName.Rune.id).reflectionRequested, false, "not re-prompted after ignoring");
  engine.dispose();
});

test("all agents acting closes the tick early", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ actionDeadlineMs: 5000, maxTicks: 1 }, undefined, { barrier });
  engine.start();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  act(engine, byName.Rune);
  act(engine, byName.Devi);
  await waitForTick(engine, 1);
  engine.dispose();
  assert.ok(Date.now() - t0 < 1000, "did not wait for the 5s deadline");
  assert.equal(barrier.find((l) => l.event === "tick_closed").reason, "all_acted");
});

test("an agent registered mid-COLLECTING accrues no miss and never blocks early close", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ actionDeadlineMs: 5000, maxTicks: 2 }, undefined, { barrier });
  engine.start();
  await new Promise((r) => setTimeout(r, 20)); // COLLECTING tick 1

  const walkIn = createAgent(engine.world, persona("WalkIn"), engine.tick);
  walkIn.connection.token = "test-token-WalkIn";
  engine.agentRegistered();

  // The walk-in cannot act this tick (not in the roster)…
  const r = act(engine, walkIn, {});
  assert.equal(r.code, "WRONG_TICK");

  // …and the tick still closes early once the roster has acted.
  act(engine, byName.Rune);
  act(engine, byName.Devi);
  await waitForTick(engine, 1);
  assert.equal(barrier.find((l) => l.event === "tick_closed").reason, "all_acted");
  assert.equal(walkIn.connection.consecutiveMisses, 0, "no miss for a tick it never saw");

  // Next tick it is a full participant.
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(act(engine, walkIn, {}).ok, true);
  act(engine, byName.Rune);
  act(engine, byName.Devi);
  await waitForTick(engine, 2);
  engine.dispose();
});

test("extend grants overtime: clears the hard stop and resumes the held world", async () => {
  const barrier = [];
  const { engine, byName } = makeEngine({ maxTicks: 2 }, undefined, { barrier, connect: [] });
  engine.start();
  await waitForTick(engine, 2);
  assert.equal(engine.stopped, true);
  const memoriesBefore = byName.Rune.memories.length;

  engine.extend(2);
  assert.equal(engine.stopped, false);
  assert.equal(engine.config.maxTicks, 4);
  await waitForTick(engine, 4);
  engine.dispose();
  assert.equal(engine.tick, 4, "ran exactly the granted overtime");
  assert.equal(engine.stopped, true, "hard stop applies again at the new cap");
  assert.ok(byName.Rune.memories.length >= memoriesBefore, "held world resumed, not reset");
  assert.ok(barrier.some((l) => l.event === "extended" && l.maxTicks === 4));
});

test("validateAction structural rules", () => {
  assert.ok(validateAction({ protocol: "0.2", type: "wait", intent: "", reason: "" }).action);
  assert.ok(validateAction({ protocol: "0.2", type: "wait", intent: "", reason: "", coord: "1,1" }).error);
  assert.ok(validateAction({ protocol: "1.0", type: "wait", intent: "", reason: "" }).error, "major version mismatch");
  assert.ok(validateAction({ protocol: "0.2", type: "move", coord: "1,1", intent: "", reason: "", text: "hi" }).error);
  assert.ok(validateAction({ protocol: "0.2", type: "move", intent: "", reason: "" }).error, "move requires coord");
  assert.ok(validateAction({ protocol: "0.2", type: "say", text: "hi", structure: { name: "x", description: "" }, intent: "", reason: "" }).error);
  const unknown = validateAction({ protocol: "0.2", type: "sing", intent: "", reason: "" });
  assert.equal(unknown.coercedWait, true);
  assert.equal(unknown.action.type, "wait");
});
