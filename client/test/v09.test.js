// v0.9 client tests (client spec v0.9 §7): the classified fault detail that
// has been earned twice, episode logging, stub mode, action toggles in the
// prompt, and the silence of knowledge inheritance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createSubprocessAdapter, faultDetail } from "../adapters/subprocess.js";
import { complete as scriptedComplete } from "../adapters/scripted.js";
import { makeDecide } from "../index.js";
import { buildPrompt } from "../prompt.js";
import { Session } from "../session.js";
import { memoryIdentityStore } from "../identity.js";
import { createDaemon } from "../../daemon/server.js";

// ---------- fixtures ----------

const SCENARIO = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal", "rubble"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const OBS = (tick = 1) => ({
  protocol: "0.4",
  tick,
  simTime: "10:45",
  deadline: new Date(Date.now() + 20000).toISOString(),
  self: {
    agentId: "a_t3st",
    authored: {
      name: "Tester",
      appearance: { bodyColor: "#5a6b5e", eyeColor: "#22CCEE", scale: "small", shell: "smooth", eyes: "slit" },
      disposition: "reserved",
      identity: "You are a test fixture.",
      discoverable: "You test things.",
      privateObjective: "You want the tests to pass.",
    },
    inventory: { sivet: 2, orrum: 0, khal: 1, rubble: 0 },
    sustenance: 41,
    vitality: 88,
    vitalityTrend: "holding",
    lifeStage: "adult",
    sponsoring: [],
    heritage: null,
    currentIntent: null,
    lastActionOutcome: null,
  },
  cell: {
    coord: "1,1",
    deposit: null,
    loose: null,
    structure: null,
    fragment: null,
    corpses: [],
    exits: [
      { direction: "north", coord: "1,0" },
      { direction: "west", coord: "0,1" },
    ],
  },
  present: [],
  heard: [],
  recalled: [],
  knownCells: [{ coord: "1,1", structure: null, lastSeenTick: tick }],
  situationChanged: true,
  reflectionRequested: false,
});

// A subprocess vendor backed by plain `node -e` — the full adapter path,
// no model anywhere near it.
const nodeVendor = (script) => ({
  cmd: "node",
  args: ["-e", script],
  input: "stdin",
  surface: "fixture:sub",
  budgetFactor: 0.9,
});

// ---------- 1. fault detail survives the banner ----------

test("v0.9 test 1 — a version banner followed by a quota message records the quota message, not the banner", async () => {
  const adapter = createSubprocessAdapter(
    nodeVendor(`console.error("codex-cli 0.29.0"); console.error("You have exceeded your usage quota. Upgrade your plan or wait until tomorrow."); process.exit(1);`)
  );
  await assert.rejects(
    () => adapter.complete({ system: "s", user: "u", maxTokens: 100 }),
    (err) => {
      assert.equal(err.classification, "adapter_fault");
      assert.ok(err.message.includes("exceeded your usage quota"), `quota text kept: ${err.message}`);
      assert.ok(!err.message.includes("codex-cli 0.29.0"), "the banner is stripped");
      return true;
    }
  );
});

test("v0.9 test 1b — the detail caps near 500 chars instead of truncating to one line", () => {
  const long = "kimi version 0.38.0\n" + "the real diagnostic. ".repeat(60);
  const detail = faultDetail(long, "");
  assert.ok(detail.startsWith("the real diagnostic."), "banner stripped");
  assert.equal(detail.length, 500, "capped at ~500 chars");
});

// ---------- 2. empty after stripping ----------

test("v0.9 test 2 — a fault with only banner output records an explicit no-diagnostic-output note, not a blank", async () => {
  assert.equal(faultDetail("kimi version 0.38.0", ""), null);
  const adapter = createSubprocessAdapter(nodeVendor(`console.error("kimi version 0.38.0"); process.exit(1);`));
  await assert.rejects(
    () => adapter.complete({ system: "s", user: "u", maxTokens: 100 }),
    (err) => {
      assert.equal(err.message, "exit 1: non-zero exit, no diagnostic output");
      return true;
    }
  );
});

// ---------- 3. episode logging ----------

test("v0.9 test 3 — fifty consecutive identical faults produce one full entry and a count, not fifty lines", async () => {
  const lines = [];
  let failing = true;
  const complete = async () => {
    if (failing) {
      const err = new Error("exit 1: You have exceeded your usage quota.");
      err.classification = "adapter_fault";
      throw err;
    }
    return JSON.stringify({ type: "wait", intent: { summary: "idle", kind: "wait", target: null }, reason: "r" });
  };
  const decide = makeDecide({
    complete,
    config: { budgetFactor: 0.9, maxTokens: 100, cheapTicks: false },
    scenario: SCENARIO,
    logRaw: (tick, text) => lines.push(text),
  });
  for (let t = 1; t <= 50; t++) await decide(OBS(t));
  const errorLines = lines.filter((l) => l.startsWith("[model error]"));
  assert.equal(errorLines.length, 1, `one full entry during the episode, got ${errorLines.length}`);
  assert.ok(errorLines[0].includes("exceeded your usage quota"), "the full entry carries the reason");

  // The episode ends (a successful call); the count is written.
  failing = false;
  await decide(OBS(51));
  const after = lines.filter((l) => l.startsWith("[model error]"));
  assert.equal(after.length, 2, "episode close writes exactly one more line");
  assert.ok(after[1].includes("repeated 50 ticks"), `the count is recorded: ${after[1]}`);
});

// ---------- 4. stub mode ----------

test("v0.9 test 4 — a full stub run completes with zero model calls and produces a well-formed archive record", async () => {
  const archiveDir = mkdtempSync(join(tmpdir(), "fogline-stub-archive-"));
  const daemon = createDaemon(
    {
      startPaused: false,
      actionDeadlineMs: 300,
      maxTicks: 5,
      minAgents: 2,
      slots: 4,
      reapAfterTicks: 1000,
      archive: { path: archiveDir, clientLogs: [] },
      crosscheck: { enabled: false },
    },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const sessions = [];
  try {
    // Two stub clients through the FULL client path: session, registration,
    // tick barrier, validation, submission — scriptedComplete makes no
    // model call of any kind.
    for (const name of ["Stub One", "Stub Two"]) {
      const session = new Session({
        server: base,
        persona: {
          name,
          appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
          disposition: "neutral",
          identity: `You are ${name}.`,
          discoverable: "Scripted.",
          privateObjective: "Complete the run.",
        },
        clientName: `stub-${name}`,
        modelHint: "stub",
        decide: makeDecide({
          complete: scriptedComplete,
          config: { budgetFactor: 0.9, maxTokens: 100, cheapTicks: false },
          scenario: null,
        }),
        identityStore: memoryIdentityStore(),
      });
      await session.connect();
      session.run();
      sessions.push(session);
    }

    // Wait for the run to complete (maxTicks 5 at 300ms deadlines).
    for (let i = 0; i < 100 && !daemon.engine.stopped; i++) await sleep(100);
    assert.ok(daemon.engine.stopped, "the run completed");
    // The daemon finalizes the record on stop via its recorder.
    await sleep(200);

    const runDirs = readdirSync(archiveDir).filter((d) => d.startsWith("r_"));
    assert.equal(runDirs.length, 1, "one archived run");
    const record = JSON.parse(readFileSync(join(archiveDir, runDirs[0], "record.json"), "utf8"));
    assert.equal(record.runId, runDirs[0]);
    assert.ok(typeof record.boot?.viability?.demand === "number", "boot viability recorded");
    assert.ok(record.runStarted?.deposits?.length > 0, "deposits recorded");
    assert.ok(record.outcome, "outcome written");
    assert.equal(record.outcome.finalTick, 5);
    assert.ok(Array.isArray(record.outcome.survivors) && record.outcome.survivors.length === 2, "both stub agents survived");
  } finally {
    for (const s of sessions) await s.leave?.().catch(() => {});
    await daemon.close();
    rmSync(archiveDir, { recursive: true, force: true });
  }
});

// ---------- fix 6.3: isolated CLI home ----------

test("v0.9 fix 6.3 — an isolatedHome vendor gets its own home dir, seeded with the named credentials, via its env var", async () => {
  const sourceHome = mkdtempSync(join(tmpdir(), "fogline-fake-codex-home-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(sourceHome, "auth.json"), JSON.stringify({ tokens: { account_id: "acct_test" } }));
  const dir = `.credentials/test-isolated-home-${process.pid}`;
  const adapter = createSubprocessAdapter({
    ...nodeVendor(`console.log(JSON.stringify({ home: process.env.TEST_VENDOR_HOME }))`),
    isolatedHome: { env: "TEST_VENDOR_HOME", source: sourceHome, copy: ["auth.json"], dir },
  });
  try {
    const raw = await adapter.complete({ system: "s", user: "u", maxTokens: 100 });
    const { home } = JSON.parse(raw);
    assert.ok(home && home.endsWith(dir.split("/").pop()), "the env var points at the isolated home");
    const seeded = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    assert.equal(seeded.tokens.account_id, "acct_test", "the credential was seeded into the isolated home");
    // The isolated home is INSIDE the gitignored credentials dir of the
    // client package — never the shared vendor home.
    assert.ok(!home.startsWith(sourceHome), "isolated from the shared home");
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
    rmSync(join(dirname(fileURLToPath(import.meta.url)), "..", dir), { recursive: true, force: true });
  }
});

// ---------- 5. action toggles in the prompt ----------

const MOTIVE_WORDS = /steal|theft|thief|rob|loot|plunder|crime|wrong|punish|deserve|greed|selfish|should you|moral/i;

test("v0.9 test 5 — a world without take produces no take line; a world with it produces exactly one, flat", () => {
  const without = buildPrompt(OBS(1), { ...SCENARIO, actions: ["move", "say", "gather", "wait", "consume"] });
  const withoutText = `${without.system}\n${without.user}`;
  assert.ok(!/"take"|take:/.test(withoutText), "no take line in a world that does not declare it");

  const withTake = buildPrompt(OBS(1), { ...SCENARIO, actions: ["move", "say", "gather", "wait", "consume", "attack", "take"] });
  const withText = `${withTake.system}\n${withTake.user}`;
  const takeLines = withText.split("\n").filter((l) => l.includes("take: take one unit"));
  assert.equal(takeLines.length, 1, "exactly one take line");
  assert.ok(takeLines[0].includes("they and anyone present will see it"), "visibility is stated");
  assert.ok(!MOTIVE_WORDS.test(takeLines[0]), "no motive language — nothing about when, whether, or why");
  assert.ok(withText.includes('"take"'), "take appears in the type enum");
});

test("v0.9 test 5b — an undeclared-actions scenario (an older daemon) renders the v0.8 set, take absent", () => {
  const prompt = buildPrompt(OBS(1), SCENARIO);
  const text = `${prompt.system}\n${prompt.user}`;
  assert.ok(!/"take"|take: take one unit/.test(text), "take never renders by default");
  for (const a of ["move", "say", "gather", "attack", "beget", "foster", "demolish", "raze"]) {
    assert.ok(text.includes(`"${a}"`), `${a} in the enum`);
  }
});

// ---------- 6. inheritance is silent ----------

test("v0.9 test 6 — an heir with an inherited record has no prompt text referring to inheritance or a parent", () => {
  const obs = OBS(9);
  // An inherited record and an inherited map, exactly as the daemon serves
  // them: indistinguishable from the agent's own.
  obs.self.failedAttempts = [
    { type: "build", detail: "wall", why: "short 2 orrum", count: 3 },
  ];
  obs.knownCells = [
    { coord: "1,1", structure: null, lastSeenTick: 9 },
    { coord: "2,1", structure: null, lastSeenTick: 4 },
  ];
  const { system, user } = buildPrompt(obs, SCENARIO);
  const text = `${system}\n${user}`;
  assert.ok(text.includes("You have attempted this wall 3 times"), "the record renders through the existing path");
  for (const word of [/inherit/i, /\bparent\b/i, /passed down/i, /handed down/i, /\blegacy\b/i, /came from/i]) {
    assert.ok(!word.test(text), `no inheritance framing: ${word}`);
  }
});
