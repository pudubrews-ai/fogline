// Session decide/act serialization (regression for the run5 tick race).
// With slow subprocess adapters (codex-cli, kimi-cli: 17-22s per decide) a
// second observation routinely arrived while a decide was still in flight;
// the old fire-and-forget _onObservation spawned overlapping _decideAndAct
// chains and the daemon answered WRONG_TICK / TICK_CLOSED / ALREADY_ACTED
// (run5-o1: ALREADY_ACTED at tick 53, TICK_CLOSED at 106, WRONG_TICK at 158).
// The contract now: at most one decide+act in flight; newer observations
// queue latest-wins; each displaced observation is logged, never silently
// dropped; the stream reader is never blocked on a model call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Session } from "../session.js";
import { memoryIdentityStore } from "../identity.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

// Records every POST /agent/act tick, in arrival order.
async function actRecorder() {
  const acts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/agent/act") acts.push(JSON.parse(body).tick);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { acts, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const obsAt = (tick) => ({ tick, self: {}, view: [] });

test("session: overlapping observations never spawn overlapping decides; superseded ticks are logged", async () => {
  const { acts, base, close } = await actRecorder();
  const logs = [];
  const decideCalls = []; // tick per decide invocation
  const gates = new Map(); // tick -> deferred the test resolves to finish that decide
  let inFlight = 0;
  let maxInFlight = 0;
  const decide = async (obs) => {
    decideCalls.push(obs.tick);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const gate = deferred();
    gates.set(obs.tick, gate);
    try {
      return await gate.promise;
    } finally {
      inFlight -= 1;
    }
  };
  const s = new Session({
    server: base,
    persona: null,
    clientName: "test-race",
    modelHint: "mock",
    decide,
    identityStore: memoryIdentityStore(),
    log: (line) => logs.push(line),
  });
  s.agentId = "a_test";
  s.token = "tok";
  try {
    // Tick 1 arrives; its decide hangs (a slow CLI adapter). Ticks 2 and 3
    // arrive while it is still in flight — exactly the run5 shape.
    s._onObservation(obsAt(1));
    s._onObservation(obsAt(2));
    s._onObservation(obsAt(3));
    await sleep(20);
    assert.deepEqual(decideCalls, [1], "no second decide starts while one is in flight");
    assert.deepEqual(acts, [], "no action posted before the in-flight decide resolves");
    assert.ok(
      logs.some((l) => l.includes("tick 2: superseded by tick 3")),
      `the displaced tick is logged, not silently dropped — got: ${JSON.stringify(logs)}`
    );

    // Tick 1's decide resolves: its act posts, then ONLY the newest queued
    // observation (tick 3) gets a decide. Tick 2 is never decided.
    gates.get(1).resolve({ action: { type: "wait" } });
    await sleep(40);
    assert.deepEqual(acts, [1], "tick 1 acted with its own tick number");
    assert.deepEqual(decideCalls, [1, 3], "latest wins: tick 3 decided next, tick 2 skipped");

    gates.get(3).resolve({ action: { type: "wait" } });
    await sleep(40);
    assert.deepEqual(acts, [1, 3], "one act per completed decide, in order, none for the superseded tick");
    assert.equal(maxInFlight, 1, "at most one decide ever in flight");

    // Replay guard intact: a replayed tick after reconnect is still ignored.
    s._onObservation(obsAt(3));
    await sleep(20);
    assert.deepEqual(decideCalls, [1, 3], "replayed tick <= lastDecidedTick never re-decides");

    // The chain is idle again: a fresh tick decides immediately.
    s._onObservation(obsAt(4));
    await sleep(20);
    assert.deepEqual(decideCalls, [1, 3, 4], "new observation after the chain drains starts a fresh decide");
    gates.get(4).resolve({ action: { type: "wait" } });
    await sleep(40);
    assert.deepEqual(acts, [1, 3, 4]);
  } finally {
    await close();
  }
});

test("session: _onObservation returns without waiting on the model call (stream reader never blocks)", async () => {
  const { base, close } = await actRecorder();
  const gate = deferred();
  const s = new Session({
    server: base,
    persona: null,
    clientName: "test-race",
    modelHint: "mock",
    decide: () => gate.promise, // never resolves until the test says so
    identityStore: memoryIdentityStore(),
    log: () => {},
  });
  s.agentId = "a_test";
  s.token = "tok";
  try {
    const t0 = Date.now();
    s._onObservation(obsAt(1)); // must return synchronously despite the hung decide
    assert.ok(Date.now() - t0 < 50, "_onObservation did not await the decide");
    gate.resolve(null); // null decision: chain ends cleanly, nothing posted
    await sleep(20);
    assert.equal(s._decideInFlight, false, "chain wound down after the decide settled");
  } finally {
    await close();
  }
});
