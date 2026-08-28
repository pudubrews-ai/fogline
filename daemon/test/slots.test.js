// Slot lifecycle and reaping (daemon spec §4.5, §9 tests 6 and 9): reaping
// frees the slot but the world remembers — structures, history entries, and
// speech in others' streams all survive. And unmanned never becomes stalled.

import { defaultDefinition } from "../world/definition.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, createAgent, snapshotCurrentCell } from "../world/world.js";
import { TickEngine } from "../engine/tick.js";
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

function makeEngine(configOverrides = {}, defs = []) {
  const barrier = [];
  const config = { ...baseConfig, ...configOverrides };
  const engine = new TickEngine({
    worldFactory: () => createWorld({ defaults: defaultDefinition(),  gridSize: config.gridSize, slots: config.slots }),
    config,
    barrierLog: (line) => barrier.push(line),
  });
  const byName = {};
  for (const def of defs) {
    const body = createAgent(engine.world, persona(def.name), 0);
    body.coord = def.coord;
    body.knownCells.clear();
    snapshotCurrentCell(engine.world, body, 0);
    if (def.connected) {
      body.connection.token = `test-token-${def.name}`;
      body.connection.state = "active";
    } else {
      body.connection.state = "unmanned";
      body.connection.unmannedSinceTick = def.unmannedSinceTick ?? 0;
    }
    byName[def.name] = body;
  }
  return { engine, byName, barrier };
}

function waitForTick(engine, tickNumber) {
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

test("reap: an unmanned body is auto-released after reapAfterTicks; its works survive", async () => {
  const { engine, byName, barrier } = makeEngine(
    { reapAfterTicks: 2, maxTicks: 6, actionDeadlineMs: 400 },
    [
      { name: "Ghost", coord: "1,1", connected: true },
      { name: "Witness", coord: "1,1", connected: true },
    ]
  );
  const ghost = byName.Ghost;
  const witness = byName.Witness;
  engine.start();
  await new Promise((r) => setTimeout(r, 20));

  // Tick 1: Ghost builds and speaks its farewell over two ticks.
  ghost.inventory.orrum += 1;
  act(engine, ghost, { type: "build", structure: { form: "marker", name: "GHOST-CAIRN", description: "left behind" } });
  act(engine, witness, {});
  await waitForTick(engine, 1);
  await new Promise((r) => setTimeout(r, 20));

  // Tick 2: Ghost says something Witness will keep.
  act(engine, ghost, { type: "say", text: "REMEMBER-ME when the grass grows back" });
  act(engine, witness, {});
  await waitForTick(engine, 2);

  // Ghost's client detaches (leave): unmanned from tick 2.
  ghost.connection.state = "unmanned";
  ghost.connection.token = null;
  ghost.connection.unmannedSinceTick = 2;
  const slotsBefore = engine.world.slots.used;

  // reapAfterTicks=2: reaped at the first RESOLVED where tick - 2 > 2 → tick 5.
  for (let t = 3; t <= 5; t++) {
    await new Promise((r) => setTimeout(r, 20));
    act(engine, witness, {});
    await waitForTick(engine, t);
  }
  engine.dispose();

  assert.equal(engine.world.agents.has(ghost.id), false, "body destroyed");
  assert.equal(engine.world.slots.used, slotsBefore - 1, "slot freed");
  assert.ok(engine.world.reclaimedIds.has(ghost.id), "attach will answer SLOT_RECLAIMED");
  assert.ok(barrier.some((l) => l.event === "reaped" && l.agentId === ghost.id));

  // The world remembers people who have gone.
  const cairn = engine.world.cells.get("1,1").structure;
  assert.equal(cairn.authored.name, "GHOST-CAIRN", "structure persists");
  assert.deepEqual(cairn.history[0], { agentId: ghost.id, tick: 1, action: "build" }, "history entry persists");
  const witnessStream = JSON.stringify(witness.memories);
  assert.ok(witnessStream.includes("REMEMBER-ME"), "speech persists in the hearer's stream");
});

test("unmanned never stalls, no matter how many ticks it misses", async () => {
  const { engine, byName, barrier } = makeEngine(
    { maxTicks: 5, reapAfterTicks: 1000 },
    [
      { name: "Empty", coord: "0,0", connected: false },
      { name: "Also", coord: "3,3", connected: false },
    ]
  );
  engine.start();
  await waitForTick(engine, 5);
  engine.dispose();
  assert.equal(byName.Empty.connection.consecutiveMisses, 5);
  assert.equal(byName.Empty.connection.state, "unmanned", "misses counted, state unchanged");
  assert.ok(
    barrier.filter((l) => l.event === "action_missed").every((l) => l.state === "unmanned"),
    "every miss logged with state unmanned"
  );
});

test("a world emptied by reaping pauses rather than ticking nobody", async () => {
  const { engine, byName, barrier } = makeEngine(
    { reapAfterTicks: 1, maxTicks: 50, actionDeadlineMs: 40, minAgents: 2 },
    [
      { name: "One", coord: "0,0", connected: false, unmannedSinceTick: 0 },
      { name: "Two", coord: "3,3", connected: false, unmannedSinceTick: 0 },
    ]
  );
  engine.start();
  // Both reaped at tick 2 RESOLVED (2 - 0 > 1). The engine must then hold.
  await waitForTick(engine, 2);
  await new Promise((r) => setTimeout(r, 150));
  engine.dispose();
  assert.equal(engine.world.agents.size, 0);
  assert.ok(engine.tick <= 2, "no tick opened on an empty world");
  assert.ok(barrier.some((l) => l.event === "waiting_for_agents"), "engine reports the hold");
});
