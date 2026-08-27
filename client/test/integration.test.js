// Client-vs-real-daemon integration: the v0.3 daemon package boots in-process
// on an ephemeral port, the client runs against it with mock adapters
// injected through the seam. Covers the v0.2 client conformance carried
// forward (attach-before-register, takeover continuity, explicit timeout
// waits, no-retry parsing, BAD_TOKEN discipline) plus the v0.3 additions:
// cheap ticks firing against a live world, the heir claim path, and waiting
// on a full world without burning a slot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createDaemon } from "../../daemon/server.js";
import { beget, matureInfants } from "../../daemon/world/lineage.js";
import { Session } from "../session.js";
import { makeDecide, connectWithPolling } from "../index.js";
import { memoryIdentityStore } from "../identity.js";
import { complete as scriptedComplete } from "../adapters/scripted.js";

const CONFIG = { budgetFactor: 0.75, maxTokens: 1000, cheapTicks: false };

function makePersona(name) {
  return {
    name,
    appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
    disposition: "neutral",
    identity: `You are ${name}, an integration fixture.`,
    discoverable: "You have run this gauntlet before.",
    privateObjective: "You want the acceptance criteria to hold.",
  };
}

async function bootDaemon(overrides = {}) {
  const daemon = createDaemon(
    { startPaused: false, actionDeadlineMs: 400, maxTicks: 40, minAgents: 2, reapAfterTicks: 1000, ...overrides },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { daemon, base: `http://127.0.0.1:${server.address().port}` };
}

function makeSession(base, name, complete, { store = memoryIdentityStore(), configOverrides = {}, personaProvider, scenario = null } = {}) {
  return new Session({
    server: base,
    persona: personaProvider ? null : makePersona(name),
    personaProvider,
    clientName: `test-${name}`,
    modelHint: "mock",
    decide: makeDecide({ complete, config: { ...CONFIG, ...configOverrides }, scenario }),
    identityStore: store,
    log: () => {},
  });
}

function waitForRunComplete(daemon) {
  return new Promise((resolve) => {
    daemon.engine.on("operator", ({ event, data }) => {
      if (event === "barrier" && data.event === "run_complete") resolve(data);
    });
  });
}

const agentDetail = (base, id) => fetch(`${base}/observatory/agent/${id}`).then((r) => r.json());
const getScenario = (base) => fetch(`${base}/scenario`).then((r) => r.json());

test("acceptance 1 (v0.2): two clients register and run 40 ticks against the daemon, no crash", async () => {
  const { daemon, base } = await bootDaemon();
  try {
    const done = waitForRunComplete(daemon);
    const sessions = [];
    for (const name of ["Rune", "Devi"]) {
      const s = makeSession(base, name, scriptedComplete);
      const joined = await s.connect();
      assert.equal(joined.mode, "register", "fresh identity registers");
      s.run();
      sessions.push(s);
    }
    const final = await done;
    assert.equal(final.tick, 40);
    for (const s of sessions) {
      const body = await agentDetail(base, s.agentId);
      assert.equal(body.connection.state, "active");
      assert.equal(body.connection.consecutiveMisses, 0, `${s.agentId} never missed a tick`);
      assert.ok(body.currentIntent, `${s.agentId} has a stored intent`);
    }
    for (const s of sessions) await s.leave();
  } finally {
    await daemon.close();
  }
});

test("acceptance 2 (v0.2): kill a client mid-run; a fresh one attaches via persisted identity, no discontinuity", async () => {
  // Instant scripted clients + early close race through ~150 ticks/second,
  // so pace the adapter and keep maxTicks far out of reach of the test.
  const paced = async (args) => {
    await sleep(25);
    return scriptedComplete(args);
  };
  const { daemon, base } = await bootDaemon({ maxTicks: 5000 });
  const advanceTo = async (tick) => {
    const t0 = Date.now();
    while (daemon.engine.tick < tick && Date.now() - t0 < 20000) await sleep(25);
    assert.ok(daemon.engine.tick >= tick, `world advanced to tick ${tick}`);
  };
  try {
    // The persisted identity outlives the process; the store is the file.
    const runeStore = memoryIdentityStore();
    const first = makeSession(base, "Rune", paced, { store: runeStore });
    await first.connect();
    first.run();
    const bystander = makeSession(base, "Devi", paced);
    await bystander.connect();
    bystander.run();
    const agentId = first.agentId;

    // Let it live a while, then kill it ungracefully: no leave, mid-run.
    await advanceTo(8);
    first._streamController.abort();
    first.stopped = true; // simulates process death: no leave() call
    const before = await agentDetail(base, agentId);
    assert.ok(before.memories.length > 0);

    // Fresh instance, same identity store — attaches (takeover: true),
    // reconstructs nothing. No persona is needed: the world owns it.
    const second = makeSession(base, "Rune", paced, { store: runeStore });
    second.persona = null; // prove attach never needs one
    const rejoined = await second.connect();
    assert.equal(rejoined.mode, "attach");
    assert.equal(second.agentId, agentId, "same body, not a new slot");
    second.run();
    await advanceTo(daemon.engine.tick + 5);

    const after = await agentDetail(base, agentId);
    assert.equal(after.connection.state, "active", "took over and is acting");
    assert.equal(after.connection.consecutiveMisses, 0);
    assert.deepEqual(after.persona, before.persona, "persona untouched by takeover");
    assert.ok(after.memories.length >= before.memories.length, "memory stream continued, not reset");
    assert.equal(
      JSON.stringify(after.memories.slice(0, before.memories.length)),
      JSON.stringify(before.memories),
      "no visible discontinuity: history identical up to the takeover"
    );
    await second.leave();
    await bystander.leave();
  } finally {
    await daemon.close();
  }
});

test("acceptance 3 (v0.2): artificially low budget produces explicit timeout waits, zero misses", async () => {
  const { daemon, base } = await bootDaemon({ actionDeadlineMs: 600, maxTicks: 6 });
  try {
    // An adapter slower than any budget, but abortable — like a real SDK call.
    const slowComplete = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const done = waitForRunComplete(daemon);
    const slow = makeSession(base, "Rune", slowComplete, { configOverrides: { budgetFactor: 0.1 } });
    await slow.connect();
    slow.run();
    const other = makeSession(base, "Devi", scriptedComplete);
    await other.connect();
    other.run();

    await done;
    const rune = await agentDetail(base, slow.agentId);
    assert.equal(rune.connection.consecutiveMisses, 0, "miss counter stayed at zero");
    assert.equal(rune.connection.state, "active");
    assert.equal(rune.lastReason, "model call exceeded budget");
    await slow.leave();
    await other.leave();
  } finally {
    await daemon.close();
  }
});

test("acceptance 5 (v0.2): malformed model output produces a wait — no crash, no retry", async () => {
  const { daemon, base } = await bootDaemon({ actionDeadlineMs: 400, maxTicks: 4 });
  try {
    let calls = 0;
    const garbageComplete = async () => {
      calls += 1;
      return "I think I will { definitely not emit JSON today";
    };
    const done = waitForRunComplete(daemon);
    const s = makeSession(base, "Rune", garbageComplete);
    await s.connect();
    s.run();
    const other = makeSession(base, "Devi", scriptedComplete);
    await other.connect();
    other.run();
    await done;
    const rune = await agentDetail(base, s.agentId);
    assert.equal(rune.connection.consecutiveMisses, 0, "waits were submitted, not missed");
    assert.equal(rune.lastReason, "unparseable model output");
    assert.equal(calls, 4, "exactly one model call per tick — never retried");
    await s.leave();
    await other.leave();
  } finally {
    await daemon.close();
  }
});

test("acceptance 6 (v0.2): BAD_TOKEN stops the session cleanly and never re-attaches", async () => {
  const { daemon, base } = await bootDaemon({ actionDeadlineMs: 300, maxTicks: 30 });
  try {
    let takeovers = 0;
    daemon.engine.on("operator", ({ event }) => {
      if (event === "takeover") takeovers += 1;
    });

    const store = memoryIdentityStore();
    const first = makeSession(base, "Rune", scriptedComplete, { store });
    await first.connect();
    const firstRun = first.run();
    const bystander = makeSession(base, "Devi", scriptedComplete);
    await bystander.connect();
    bystander.run();
    while (daemon.engine.tick < 3) await sleep(30);

    // A second client takes the body; the first one's token dies.
    const second = makeSession(base, "Rune", scriptedComplete, { store });
    await second.connect();
    second.run();

    const stopReason = await firstRun; // must resolve on its own, no re-attach
    assert.equal(stopReason, "BAD_TOKEN");
    assert.equal(first.stopped, true);
    await sleep(400);
    assert.equal(takeovers, 1, "exactly one takeover: the dead client never re-attached");
    const rune = await agentDetail(base, second.agentId);
    assert.equal(rune.connection.state, "active", "the new client keeps driving the body");
    await second.leave();
    await bystander.leave();
  } finally {
    await daemon.close();
  }
});

test("v0.2 acceptance 2: the model authors the persona; the world owns it from registration on", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    // The persona arrives through the same adapter seam as the tick loop.
    const authored = makePersona("Marrow");
    let generationCalls = 0;
    const provider = {
      create: async () => {
        generationCalls += 1;
        return authored;
      },
    };
    const s = makeSession(base, "gen", scriptedComplete, { personaProvider: provider });
    const joined = await s.connect();
    assert.equal(joined.mode, "register");
    assert.equal(joined.name, "Marrow");
    assert.equal(generationCalls, 1, "one model call, made once, before the agent exists");

    const body = await agentDetail(base, s.agentId);
    assert.deepEqual(body.persona.name, "Marrow", "the daemon holds the authored persona");

    // A restart attaches: the provider is never consulted again.
    const second = makeSession(base, "gen", scriptedComplete, {
      store: s.identityStore,
      personaProvider: { create: async () => assert.fail("attach must not regenerate a persona") },
    });
    const rejoined = await second.connect();
    assert.equal(rejoined.mode, "attach");
    await second.leave();
  } finally {
    await daemon.close();
  }
});

test("v0.2 NAME_TAKEN: the name is regenerated, the person is untouched, registration succeeds", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const first = makeSession(base, "a", scriptedComplete);
    await first.connect(); // claims its persona name
    const taken = first.persona.name;

    let renames = 0;
    const provider = {
      create: async () => makePersona(taken), // collides deliberately
      renameOnCollision: async (persona) => {
        renames += 1;
        return { ...persona, name: "Sill" };
      },
    };
    const s = makeSession(base, "b", scriptedComplete, { personaProvider: provider });
    const joined = await s.connect();
    assert.equal(joined.mode, "register");
    assert.equal(joined.name, "Sill");
    assert.equal(renames, 1);
    const body = await agentDetail(base, s.agentId);
    assert.equal(body.persona.identity, makePersona(taken).identity, "only the name changed");
    await s.leave();
    await first.leave();
  } finally {
    await daemon.close();
  }
});

test("v0.2 INVALID_PERSONA: daemon rejection is logged and regenerated once, then registration succeeds", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    // Control characters pass the client's local checks but hit the daemon's
    // injection chokepoint — the one violation class only the daemon sees.
    const poisoned = { ...makePersona("Vex"), identity: "You are\u0007poisoned." };
    let regenerations = 0;
    const provider = {
      create: async () => poisoned,
      regenerate: async (detail) => {
        regenerations += 1;
        assert.match(detail, /control characters/);
        return makePersona("Vex");
      },
    };
    const s = makeSession(base, "c", scriptedComplete, { personaProvider: provider });
    const joined = await s.connect();
    assert.equal(joined.mode, "register");
    assert.equal(regenerations, 1, "regenerated exactly once");
    await s.leave();
  } finally {
    await daemon.close();
  }
});

test("identity discipline: SLOT_RECLAIMED discards the persisted identity and registers fresh", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const store = memoryIdentityStore();
    const first = makeSession(base, "Rune", scriptedComplete, { store });
    await first.connect();
    const oldId = first.agentId;
    await first.release(); // explicit deletion: slot freed, id reclaimed

    assert.equal(store.load(), null, "release discards the persisted identity");

    // Simulate a stale copy of the identity surviving (e.g. an old file).
    store.save({ agentId: oldId, token: "stale" });
    const second = makeSession(base, "Rune", scriptedComplete, { store });
    const joined = await second.connect();
    assert.equal(joined.mode, "register", "SLOT_RECLAIMED fell through to a fresh registration");
    assert.notEqual(second.agentId, oldId);
    await second.leave();
  } finally {
    await daemon.close();
  }
});

// ---------- v0.3: cheap ticks against a live world ----------

test("v0.3 acceptance 1: cheap ticks fire — solitary travel costs materially fewer calls than ticks", async () => {
  // A quiet world: one agent, no deposits to stumble into, no decay to force
  // band crossings — the pure cost-lever case. The scripted adapter states
  // travel intents; cheap.js walks them without touching the adapter.
  const { daemon, base } = await bootDaemon({
    minAgents: 1,
    maxTicks: 60,
    gridSize: 8,
    resources: { seedDensity: 0, quantityRange: [0, 0], regenPerTick: 0, distribution: "clustered" },
    vitals: { sustenanceDecayPerTick: 0 },
  });
  try {
    let adapterCalls = 0;
    const counted = async (args) => {
      adapterCalls += 1;
      return scriptedComplete(args);
    };
    const scenario = await getScenario(base);
    const done = waitForRunComplete(daemon);
    const s = makeSession(base, "Walker", counted, { configOverrides: { cheapTicks: true }, scenario });
    await s.connect();
    s.run();
    const final = await done;
    assert.equal(final.tick, 60);
    const body = await agentDetail(base, s.agentId);
    assert.equal(body.connection.consecutiveMisses, 0, "cheap ticks still act every tick");
    assert.ok(
      adapterCalls < 30,
      `inference calls (${adapterCalls}) should be materially fewer than 60 ticks`
    );
    await s.leave();
  } finally {
    await daemon.close();
  }
});

// ---------- v0.3: the heir path against a live world ----------

// Grow a matured, unmanned, in-world-born body: beget an infant from a
// registered parent directly in the world (test scaffolding, not protocol),
// then mature it. /scenario lists it; a client claims it.
function growHeirBody(daemon, parentId) {
  const world = daemon.engine.world;
  const parent = world.agents.get(parentId);
  const infant = beget(world, parent, daemon.engine.tick || 1);
  matureInfants(world, (daemon.engine.tick || 1) + world.lineage.maturityTicks + 1);
  return infant;
}

test("v0.3 acceptance 4: claiming a matured body authors from the heritage brief and omits appearance", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const parentSession = makeSession(base, "Marrow", scriptedComplete);
    await parentSession.connect();
    const infant = growHeirBody(daemon, parentSession.agentId);
    const genotype = { ...daemon.engine.world.agents.get(infant.id).appearance };

    const scenario = await getScenario(base);
    assert.equal(scenario.attachable.length, 1, "the matured body is offered at /scenario");
    const offered = scenario.attachable[0];
    assert.equal(offered.agentId, infant.id);
    assert.equal(offered.heritage.parentName, "Marrow");
    assert.ok(!JSON.stringify(offered.heritage).includes("privateObjective"), "no objective leaks through a brief");

    // The heir provider receives the brief; the persona it returns carries
    // no appearance. (Scripted heir, same seam as the real one.)
    const logged = [];
    let sawBrief = null;
    const heirProvider = {
      create: async () => {
        sawBrief = offered.heritage;
        const raw = await scriptedComplete({ user: "Decide who you are. JSON only, no appearance field." });
        logged.push(raw);
        return JSON.parse(raw);
      },
    };
    const heirSession = makeSession(base, "heir", scriptedComplete, { personaProvider: heirProvider });
    const joined = await heirSession.claim(offered.agentId);
    assert.equal(joined.mode, "claim");
    assert.equal(sawBrief.parentName, "Marrow", "persona was authored FROM the brief");
    assert.ok(logged.length > 0, "generation captured for logRaw");

    const body = await agentDetail(base, infant.id);
    assert.equal(body.persona.name, joined.name, "the claimed body carries the authored persona");
    // The observatory shows the BODY's appearance — daemon-authored genotype.
    // The claim submitted none, and the genotype is exactly what it was.
    assert.deepEqual(daemon.engine.world.agents.get(infant.id).appearance, genotype, "genotype untouched by the claim");
    assert.deepEqual({ ...body.persona.appearance }, genotype, "what the world shows is the genotype, not anything the client sent");
    await heirSession.leave();
    await parentSession.leave();
  } finally {
    await daemon.close();
  }
});

test("v0.3 acceptance 8: a client on a full world polls, waits, and claims when a body matures — no slot burned", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, slots: 2 });
  try {
    // Fill the world.
    const a = makeSession(base, "A", scriptedComplete);
    await a.connect();
    const b = makeSession(base, "B", scriptedComplete);
    await b.connect();
    const scenarioFull = await getScenario(base);
    assert.equal(scenarioFull.slots.used, scenarioFull.slots.total);

    // The waiting client: registration is impossible, so it polls.
    const waiting = makeSession(base, "W", scriptedComplete);
    const connectPromise = connectWithPolling({
      session: waiting,
      server: base,
      scenario: scenarioFull,
      config: { pollIntervalMs: 100, pollWhenFull: true },
      heirOnly: false,
      makeHeirProvider: () => ({
        create: async () => JSON.parse(await scriptedComplete({ user: "Decide who you are. JSON only, no appearance field." })),
      }),
      log: () => {},
    });

    // Let it poll against a genuinely full world first, then mature a body
    // behind its back and watch it claim rather than register.
    await sleep(300);
    assert.equal(waiting.agentId, null, "still waiting, no slot burned");
    const infant = growHeirBody(daemon, a.agentId);

    const joined = await connectPromise;
    assert.equal(joined.mode, "claim", "attached to the matured body, never registered");
    assert.equal(joined.agentId, infant.id);
    await waiting.leave();
    await a.leave();
    await b.leave();
  } finally {
    await daemon.close();
  }
});

test("v0.3: losing a claim race answers NOT_ATTACHABLE and stays pollable", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const parent = makeSession(base, "P", scriptedComplete);
    await parent.connect();
    const infant = growHeirBody(daemon, parent.agentId);

    const heirProvider = () => ({
      create: async () => JSON.parse(await scriptedComplete({ user: `Decide who you are. JSON only, no appearance field. ${Math.random()}` })),
    });
    const winner = makeSession(base, "win", scriptedComplete, { personaProvider: heirProvider() });
    await winner.claim(infant.id);

    const loser = makeSession(base, "lose", scriptedComplete, { personaProvider: heirProvider() });
    await assert.rejects(
      () => loser.claim(infant.id),
      (err) => err.code === "NOT_ATTACHABLE",
      "the lost race is a coded, pollable condition"
    );
    assert.equal(loser.stopped, false, "the losing session is intact and can keep polling");
    await winner.leave();
    await parent.leave();
  } finally {
    await daemon.close();
  }
});
