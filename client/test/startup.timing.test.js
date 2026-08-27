// Startup timing (two independent regressions):
//
//   1. Heir poll jitter — with one fixed shared poll interval, two heir
//      clients idle-polling for the same matured body tick in lockstep and
//      the claim race is decided by launch order, not chance. The base is
//      now per-instance (--pollIntervalMs > config.pollIntervalMs > 5000)
//      and every wait re-rolls +/-20% jitter around it.
//
//   2. Persona-generation timeout — generateValidated used to call the
//      adapter with no signal and no ceiling: a CLI that hangs (rather than
//      exits) during registration stalled the client forever with no
//      diagnostic. It now aborts at a flat ~60s budget (overridable here so
//      tests do not wait a real minute) and fails with a loud "timed out"
//      error that the connectWithPolling fault-retry path can catch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { connectWithPolling } from "../index.js";
import { generatePersona, generateHeirPersona } from "../persona.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

// ---------- 1. poll jitter ----------

// Drives the attach/NOT_ATTACHABLE poll branch with a fake session and reads
// each cycle's wait straight out of the "retrying in Nms" log line — the
// exact value passed to sleep().
async function collectPollWaits(basePollMs, failures) {
  const logs = [];
  let attempts = 0;
  const session = {
    identityStore: { load: () => ({ agentId: "a_jitter" }) },
    connect: async () => {
      attempts += 1;
      if (attempts <= failures) throw Object.assign(new Error("still live"), { code: "NOT_ATTACHABLE" });
      return { mode: "attach", agentId: "a_jitter" };
    },
  };
  await connectWithPolling({
    session,
    server: "http://127.0.0.1:1", // never reached on the attach path
    scenario: { attachable: [], slots: { used: 0, total: 0 } },
    config: { pollIntervalMs: basePollMs, pollWhenFull: true },
    heirOnly: false,
    makeHeirProvider: () => ({ create: async () => null }),
    log: (msg) => logs.push(msg),
  });
  return logs
    .map((l) => /retrying in (\d+)ms/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);
}

test("poll jitter: consecutive waits vary around the configured base and are re-rolled every cycle", async () => {
  const waits = await collectPollWaits(50, 8);
  assert.equal(waits.length, 8, `one logged wait per NOT_ATTACHABLE cycle (got: ${JSON.stringify(waits)})`);
  for (const w of waits) {
    assert.ok(w >= 40 && w <= 60, `every wait stays within +/-20% of the 50ms base (got ${w}ms)`);
  }
  assert.ok(
    new Set(waits).size > 1,
    `the jitter is re-rolled per cycle, not fixed once at startup — all eight waits came out identical: ${JSON.stringify(waits)}`
  );

  // A different base moves the whole band: the interval is genuinely
  // per-instance, which is what lets two heirs be launched desynchronized.
  const wide = await collectPollWaits(200, 3);
  for (const w of wide) {
    assert.ok(w >= 160 && w <= 240, `waits follow the supplied base, not a constant (got ${w}ms for base 200)`);
  }
});

test("poll jitter: --pollIntervalMs CLI flag overrides config.pollIntervalMs (config says 5000)", async () => {
  // A stub /scenario with no attachable bodies keeps an --heir client in its
  // idle poll loop; the request arrival times measure the real intervals.
  const hits = [];
  const stub = createServer((req, res) => {
    if (req.url === "/scenario") hits.push(Date.now());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ attachable: [], slots: { used: 0, total: 0 }, premise: "t", gridSize: 4, rules: [], personaSchema: {} }));
  });
  stub.listen(0);
  await new Promise((r) => stub.once("listening", r));
  const base = `http://127.0.0.1:${stub.address().port}`;

  const child = spawn(
    process.execPath,
    [
      join(baseDir, "..", "index.js"),
      "--heir",
      "--adapter",
      "scripted",
      "--server",
      base,
      "--label",
      "test-jitter-flag",
      "--pollIntervalMs",
      "100",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  try {
    // Wait for enough polls to measure; config.json's 5000ms base would
    // yield at most one or two requests in this whole window.
    const deadline = Date.now() + 10000;
    while (hits.length < 6 && Date.now() < deadline) await sleep(50);
    assert.ok(hits.length >= 6, `the 100ms CLI base produced frequent polls (got ${hits.length} in 10s; stderr: ${stderr})`);
    for (let i = 1; i < hits.length; i++) {
      const gap = hits[i] - hits[i - 1];
      assert.ok(gap < 2000, `poll gap ${gap}ms reflects the CLI base, not config.json's 5000ms`);
    }
    assert.ok(stderr.includes("waiting for a body to mature"), `the client was in the heir idle-poll loop (stderr: ${stderr})`);
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => stub.close(r));
  }
});

test("poll jitter: a non-numeric --pollIntervalMs is refused at startup, exit 2", async () => {
  const child = spawn(process.execPath, [join(baseDir, "..", "index.js"), "--pollIntervalMs", "soon"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 2, "garbage never reaches the poll loop as NaN");
  assert.ok(stderr.includes("--pollIntervalMs must be a positive number"), `refusal names the flag (stderr: ${stderr})`);
});

// ---------- 2. persona-generation timeout ----------

const SCENARIO = { premise: "a small test world", gridSize: 4, rules: ["be brief"], personaSchema: {} };

// The kimi/codex hang shape: the adapter's promise never settles on its own;
// only the budget's abort signal ends it — exactly how the subprocess
// adapters behave (killGroup on abort, then reject).
function hangingComplete() {
  const calls = [];
  const complete = ({ signal }) => {
    calls.push({ sawSignal: signal !== undefined });
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("subprocess killed by abort")), { once: true });
    });
  };
  return { complete, calls };
}

const VALID_PERSONA = JSON.stringify({
  name: "Second Wind",
  appearance: { bodyColor: "#7a7d72", eyeColor: "#22CCEE", scale: "medium", shell: "panelled", eyes: "pair" },
  disposition: "neutral",
  identity: "You answered only after the first call was cut down.",
  discoverable: "You exist because attempt one hung.",
  privateObjective: "You want to be generated before the operator gives up.",
});

test("persona timeout: a hung adapter rejects loudly around the budget instead of stalling forever", async () => {
  const { complete, calls } = hangingComplete();
  const t0 = Date.now();
  await assert.rejects(
    generatePersona({ scenario: SCENARIO, complete, budgetMs: 150 }),
    (err) => {
      assert.ok(err instanceof Error, "a real Error, so index.js's startup fault-retry can catch and log it");
      assert.equal(err.code, undefined, "no protocol code — it takes the retry path, not the fatal one");
      assert.match(err.message, /timed out after 150ms/, `the message says timed out, not a validation failure (got: ${err.message})`);
      assert.match(err.message, /persona generation failed twice/, "a timeout still counts inside the existing 2-attempt loop");
      return true;
    }
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `rejected around the budget, no silent hang (took ${elapsed}ms)`);
  assert.equal(calls.length, 2, "each timed-out attempt consumed one of the two attempts — no third tier of retries");
  assert.ok(calls.every((c) => c.sawSignal), "the abort signal was passed through the adapter seam");
});

test("persona timeout: attempt one hangs, attempt two answers — the timeout costs one attempt, not the run", async () => {
  let n = 0;
  const complete = ({ signal }) => {
    n += 1;
    if (n === 1) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("killed")), { once: true });
      });
    }
    return Promise.resolve(VALID_PERSONA);
  };
  const persona = await generatePersona({ scenario: SCENARIO, complete, budgetMs: 100 });
  assert.equal(persona.name, "Second Wind", "the second attempt's persona came through");
  assert.equal(n, 2);
});

test("persona timeout: the heir path shares the same ceiling", async () => {
  const { complete } = hangingComplete();
  const heritage = {
    parentName: "Old Root",
    parentDiscoverable: "Kept to the north cells.",
    parentAppearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
    bornAtTick: 12,
  };
  await assert.rejects(
    generateHeirPersona({ scenario: SCENARIO, heritage, complete, budgetMs: 100 }),
    /timed out after 100ms/
  );
});
