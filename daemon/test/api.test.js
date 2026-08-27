import { test } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, register, registerRaw, attach, act, openSse, persona } from "./helpers.js";

test("scenario: unauthenticated, callable before registration, carries the persona schema", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const res = await fetch(`${base}/scenario`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocol, "0.4");
    assert.equal(body.gridSize, 4);
    assert.deepEqual(body.slots, { total: 5, used: 0 });
    assert.ok(typeof body.premise === "string" && body.premise.length > 0);
    assert.ok(body.personaSchema.appearance.shell.includes("ridged"));
    assert.ok(Array.isArray(body.rules) && body.rules.length > 0);
  } finally {
    await daemon.close();
  }
});

test("register: version checked first, v0.1 rejected, daemon mints id and spawn", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    assert.equal((await register(base, "Rune", { protocol: "0.1" })).body.error, "VERSION_UNSUPPORTED");
    assert.equal((await register(base, "Rune", { protocol: "1.0" })).body.error, "VERSION_UNSUPPORTED");
    const ok = await register(base, "Rune", { modelHint: "test/none" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.protocol, "0.4");
    assert.match(ok.body.agentId, /^a_[0-9a-f]{4}$/);
    assert.match(ok.body.token, /^[0-9a-f]{64}$/);
    assert.match(ok.body.spawnCell, /^\d+,\d+$/);
    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.deepEqual(scenario.slots, { total: 5, used: 1 });
  } finally {
    await daemon.close();
  }
});

test("register guard: malformed personas rejected with the right code and no slot consumed", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const cases = [
      persona("x".repeat(25)), // oversized name
      persona("Okay", { appearance: { shell: "iridescent" } }), // out-of-enum
      persona("Okay", { appearance: { bodyColor: "#12345G" } }), // bad hex
      persona("Okay", { identity: "line one\u000Bline two" }), // control character
    ];
    for (const p of cases) {
      const r = await registerRaw(base, { protocol: "0.2", persona: p, clientName: "t" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "INVALID_PERSONA", JSON.stringify(p).slice(0, 50));
    }

    assert.equal((await register(base, "Devi")).status, 200);
    const dup = await register(base, "  devi "); // case-insensitive, trimmed
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "NAME_TAKEN");

    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(scenario.slots.used, 1, "only the one valid registration consumed a slot");
  } finally {
    await daemon.close();
  }
});

test("slot lifecycle: fill to WORLD_FULL, release one, register succeeds", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, slots: 2 });
  try {
    const a = (await register(base, "One")).body;
    assert.equal((await register(base, "Two")).status, 200);
    const full = await register(base, "Three");
    assert.equal(full.status, 409);
    assert.equal(full.body.error, "WORLD_FULL");

    const released = await fetch(`${base}/agent/release`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}` },
    });
    assert.equal(released.status, 200);
    assert.equal((await register(base, "Three")).status, 200);

    // The released identity is gone for good: attach says SLOT_RECLAIMED.
    const re = await attach(base, a.agentId);
    assert.equal(re.status, 410);
    assert.equal(re.body.error, "SLOT_RECLAIMED");
  } finally {
    await daemon.close();
  }
});

test("attach: NO_SUCH_AGENT for unknown ids; persona fields ignored without error; persona immutable", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    assert.equal((await attach(base, "a_9999")).body.error, "NO_SUCH_AGENT");

    const reg = await register(base, "Devi");
    const stored = () => fetch(`${base}/observatory/agent/${reg.body.agentId}`).then((r) => r.json());
    const before = JSON.stringify((await stored()).persona);

    // v0.4: attach is claim-only by default on EVERY body — a live client
    // means NOT_ATTACHABLE without takeover (protocol §14.3).
    const claimed = await attach(base, reg.body.agentId, { persona: persona("Impostor") });
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.error, "NOT_ATTACHABLE");

    // Attach with takeover and a full persona in the body: ignored, not an error.
    const re = await attach(base, reg.body.agentId, { persona: persona("Impostor"), takeover: true });
    assert.equal(re.status, 200);
    assert.match(re.body.token, /^[0-9a-f]{64}$/);
    const after = JSON.stringify((await stored()).persona);
    assert.equal(after, before, "stored persona byte-identical across attach");
  } finally {
    await daemon.close();
  }
});

test("auth: 403 in both directions, with two separate middlewares", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, operatorAuth: true, operatorToken: "op-secret" });
  try {
    const agentToken = (await register(base, "Rune")).body.token;

    // Agent token on operator routes → 403.
    const stream = await fetch(`${base}/observatory/stream`, { headers: { Authorization: `Bearer ${agentToken}` } });
    assert.equal(stream.status, 403);
    const control = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ action: "play" }),
    });
    assert.equal(control.status, 403);

    // Operator token on agent routes → 403 BAD_TOKEN.
    const r = await act(base, "op-secret", { tick: 1 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "BAD_TOKEN");

    // No token at all: agent route 403; operator route 403 while auth is on.
    assert.equal((await fetch(`${base}/agent/act`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/observatory/stream`)).status, 403);
    // /scenario and /register stay open even with operator auth on.
    assert.equal((await fetch(`${base}/scenario`)).status, 200);
  } finally {
    await daemon.close();
  }
});

test("auth: agent token still rejected on operator routes when operatorAuth is open", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, operatorAuth: false });
  try {
    const reg = (await register(base, "Rune")).body;
    const withAgentToken = await fetch(`${base}/observatory/agent/${reg.agentId}`, { headers: { Authorization: `Bearer ${reg.token}` } });
    assert.equal(withAgentToken.status, 403, "agent token must never reach the operator realm");
    const open = await fetch(`${base}/observatory/agent/${reg.agentId}`);
    assert.equal(open.status, 200, "open on localhost without a token");
  } finally {
    await daemon.close();
  }
});

test("takeover: invalidates old token, preserves persona/memory/position/intent, emits operator event", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, actionDeadlineMs: 2000, maxTicks: 5 });
  try {
    const operatorEvents = [];
    const opStream = await openSse(`${base}/observatory/stream`, null, (e) => operatorEvents.push(e));

    const rune = (await register(base, "Rune", { clientName: "client-one" })).body;
    const devi = (await register(base, "Devi", { clientName: "helper" })).body;

    daemon.engine.step(); // run tick 1
    await new Promise((r) => setTimeout(r, 30));
    const acted = await act(base, rune.token, { tick: 1, type: "say", text: "remember this", intent: "chatting" });
    assert.equal(acted.status, 200);
    await act(base, devi.token, { tick: 1 });
    await new Promise((r) => setTimeout(r, 30));

    const before = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.ok(before.memories.some((m) => m.text === "remember this"));
    assert.equal(before.currentIntent, "chatting");

    const second = (await attach(base, rune.agentId, { clientName: "client-two", takeover: true })).body.token;
    assert.notEqual(second, rune.token);

    // Old token is dead, and dead means BAD_TOKEN 403 — not a queued action.
    const stale = await act(base, rune.token, { tick: 2 });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.error, "BAD_TOKEN");

    const after = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.deepEqual(
      { coord: after.coord, intent: after.currentIntent, memories: after.memories.length, persona: after.persona },
      { coord: before.coord, intent: before.currentIntent, memories: before.memories.length, persona: before.persona },
      "takeover preserved persona, memory, position, and intent"
    );
    assert.ok(operatorEvents.some((e) => e.event === "takeover" && e.data.agentId === rune.agentId));
    opStream.close();
  } finally {
    await daemon.close();
  }
});

test("late action over HTTP is TICK_CLOSED and absent from the next tick", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, actionDeadlineMs: 60, maxTicks: 5 });
  try {
    const rune = (await register(base, "Rune")).body;
    await register(base, "Devi");
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 150)); // deadline long gone, tick 1 resolved
    const late = await act(base, rune.token, { tick: 1, type: "say", text: "too late" });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "TICK_CLOSED");
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 150));
    const stored = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.equal(stored.memories.filter((m) => m.type === "speech").length, 0, "never queued into tick 2");
  } finally {
    await daemon.close();
  }
});

test("leave: body goes unmanned, keeps state, holds the slot, ticks resolve to wait", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, actionDeadlineMs: 60, maxTicks: 5 });
  try {
    const rune = (await register(base, "Rune")).body;
    await register(base, "Devi");
    const left = await fetch(`${base}/agent/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rune.token}` },
    });
    assert.equal(left.status, 200);
    const stored = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.equal(stored.connection.state, "unmanned");
    assert.equal((await act(base, rune.token, { tick: 1 })).status, 403, "token revoked on leave");
    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(scenario.slots.used, 2, "slot held while unmanned");

    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 150));
    const after = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.equal(after.connection.consecutiveMisses, 1, "unmanned body still ticks and misses");

    // Reattach: the walk back in is an attach, not a re-register.
    const re = await attach(base, rune.agentId);
    assert.equal(re.status, 200);
    const back = await fetch(`${base}/observatory/agent/${rune.agentId}`).then((r) => r.json());
    assert.equal(back.connection.state, "active");
    assert.equal(back.connection.unmannedSinceTick, null);
  } finally {
    await daemon.close();
  }
});

test("engine waits for minAgents before tick 1, then runs", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: false, minAgents: 2, actionDeadlineMs: 50, maxTicks: 3 });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(daemon.engine.tick, 0, "no agents: no tick");
    await register(base, "One");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(daemon.engine.tick, 0, "below minAgents: still waiting");
    await register(base, "Two");
    const done = new Promise((resolve) => {
      daemon.engine.on("operator", ({ event, data }) => {
        if (event === "barrier" && data.event === "run_complete") resolve(data);
      });
    });
    const final = await done;
    assert.equal(final.tick, 3, "ran to completion once the gate opened");
  } finally {
    await daemon.close();
  }
});

test("40 ticks with two connected scripted clients, no crash, builds and moves land", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: false, actionDeadlineMs: 2000, maxTicks: 40 });
  try {
    const done = new Promise((resolve) => {
      daemon.engine.on("operator", ({ event, data }) => {
        if (event === "barrier" && data.event === "run_complete") resolve(data);
      });
    });

    // Two scripted drivers: each reacts to its own observation stream.
    // Deterministic script, no model anywhere: build on tick 2, say on ticks
    // divisible by 3, move every 7th tick, otherwise wait.
    const drivers = [];
    const ids = [];
    for (const name of ["Rune", "Devi"]) {
      const reg = (await register(base, name, { clientName: `driver-${name}` })).body;
      ids.push(reg.agentId);
      // Builds cost materials in v0.3: hand the scripted driver a marker's worth.
      daemon.engine.world.agents.get(reg.agentId).inventory.orrum += 1;
      const sse = await openSse(`${base}/agent/stream`, reg.token, async ({ event, data }) => {
        if (event !== "observation") return;
        let action = { tick: data.tick, type: "wait", coord: null, text: null, structure: null };
        if (data.tick === 2 && data.cell.structure === null) {
          action = { tick: data.tick, type: "build", structure: { form: "marker", name: `${name}s marker`, description: "left by a scripted driver" } };
        } else if (data.tick % 7 === 0 && data.cell.exits.length > 0) {
          action = { tick: data.tick, type: "move", coord: data.cell.exits[0].coord };
        } else if (data.tick % 3 === 0) {
          action = { tick: data.tick, type: "say", text: `scripted line at tick ${data.tick}` };
        }
        await act(base, reg.token, { ...action, intent: `scripted tick ${data.tick}`, reflections: data.reflectionRequested ? ["scripted reflection"] : null });
      });
      assert.equal(sse.status, 200);
      drivers.push(sse);
    }

    const final = await done;
    assert.equal(final.tick, 40);
    let structures = 0;
    for (const id of ids) {
      const body = await fetch(`${base}/observatory/agent/${id}`).then((r) => r.json());
      assert.equal(body.connection.state, "active");
      assert.equal(body.connection.consecutiveMisses, 0);
      assert.ok(body.memories.some((m) => m.type === "speech"), `${id} heard/said something across 40 ticks`);
      assert.ok(body.knownCells.length > 1, `${id} discovered more of the map than its spawn`);
    }
    for (const cell of daemon.engine.world.cells.values()) {
      if (cell.structure) structures += 1;
    }
    assert.ok(structures >= 1, "at least one build landed");
    for (const d of drivers) d.close();
  } finally {
    await daemon.close();
  }
});
