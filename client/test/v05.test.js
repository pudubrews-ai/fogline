// v0.5 gates (client spec §9): the subprocess base adapter, process-group
// cleanup, fault classification, working-directory isolation, preamble
// stripping, surface fingerprints, per-adapter budgets, and the
// three-vendor run. Stub commands stand in for vendor CLIs everywhere —
// the real CLI invocations were confirmed empirically and recorded in
// adapters/CLI-FINDINGS.md before the vendor configs were written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  accountFingerprint,
  createSubprocessAdapter,
  extractResponse,
} from "../adapters/subprocess.js";
import { defaults as claudeCliDefaults, create as createClaudeCli } from "../adapters/claude-cli.js";
import { defaults as codexCliDefaults, create as createCodexCli } from "../adapters/codex-cli.js";
import { defaults as kimiCliDefaults, create as createKimiCli } from "../adapters/kimi-cli.js";
import { computeBudgetMs, withBudget } from "../budget.js";
import { makeDecide, connectWithPolling } from "../index.js";
import { generatePersona } from "../persona.js";
import { Session } from "../session.js";
import { memoryIdentityStore } from "../identity.js";
import { createDaemon } from "../../daemon/server.js";

const stubVendor = (script, extra = {}) => ({
  cmd: "/bin/sh",
  args: ["-c", script],
  input: "stdin",
  budgetFactor: 0.75,
  surface: "stub:sub",
  ...extra,
});

const SCENARIO_CTX = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

// A minimal but complete observation for driving makeDecide.
const OBS = {
  protocol: "0.5",
  tick: 7,
  simTime: "10:45",
  deadline: new Date(Date.now() + 20000).toISOString(),
  self: {
    agentId: "a_d3f1",
    authored: {
      name: "Devi",
      appearance: { bodyColor: "#5a6b5e", eyeColor: "#22CCEE", scale: "small", shell: "smooth", eyes: "slit" },
      disposition: "reserved",
      identity: "You read people well and say little.",
      discoverable: "You once mapped the northern cells by hand.",
      privateObjective: "Find out who has been using your things.",
    },
    inventory: { sivet: 2, orrum: 0, khal: 1 },
    sustenance: 41,
    vitality: 88,
    lifeStage: "adult",
    sponsoring: [],
    heritage: null,
    currentIntent: "reading by the window",
    lastActionOutcome: null,
  },
  cell: {
    coord: "2,1",
    deposit: null,
    loose: null,
    structure: null,
    fragment: null,
    corpses: [],
    exits: [
      { direction: "north", coord: "2,0" },
      { direction: "west", coord: "1,1" },
    ],
  },
  present: [],
  heard: [],
  recalled: [],
  knownCells: [{ coord: "2,1", structure: null, lastSeenTick: 7 }],
  situationChanged: true,
  reflectionRequested: false,
};

const DECIDE_CONFIG = { budgetFactor: 0.75, maxTokens: 200, cheapTicks: false };

// ---------- 1. base adapter contract ----------

test("GATE base adapter contract: a stub command echoing fixed JSON satisfies complete() end to end", async () => {
  const fixed = '{"type":"wait","reason":"stub says wait","intent":{"summary":"hold","kind":"wait","target":null}}';
  const adapter = createSubprocessAdapter(stubVendor(`echo '${fixed}'`));
  const out = await withBudget(5000, (signal) =>
    adapter.complete({ system: "You are a fixture.", user: "Act.", maxTokens: 100, signal })
  );
  assert.equal(out.timedOut, false);
  assert.equal(out.result, fixed, "the JSON came through the seam untouched");

  // And through the full decide pipeline: the stub's JSON becomes the action.
  const decide = makeDecide({ complete: adapter.complete, config: { ...DECIDE_CONFIG }, scenario: SCENARIO_CTX });
  const action = await decide(structuredClone(OBS));
  assert.equal(action.type, "wait");
  assert.equal(action.reason, "stub says wait");
  assert.equal(action.calls, 1, "one inference call reported for the tick");
});

// ---------- 2. process-group cleanup ----------

test("GATE process-group cleanup: no orphan survives 100 aborts of a forking command", async () => {
  // The stub forks a child (sleep) and execs another — a process GROUP, like
  // every real CLI. Kill-by-pid would strand the forked child; the v0.4 run
  // left five orphans behind and subprocess adapters multiply that.
  const adapter = createSubprocessAdapter(stubVendor("sleep 297.31 & exec sleep 297.31"));
  for (let i = 0; i < 100; i++) {
    const out = await withBudget(25, (signal) =>
      adapter.complete({ system: "s", user: "u", maxTokens: 10, signal })
    );
    assert.equal(out.timedOut, true, `abort ${i} classified as slow`);
  }
  await sleep(300); // let SIGKILL land everywhere
  const table = execSync("ps ax -o command").toString();
  assert.ok(!table.includes("sleep 297.31"), "process table is clean after 100 aborted calls");
});

// ---------- 3. fault classification ----------

test("GATE fault classification: timeout, auth failure, and bad output each classify and reach the roster distinctly", async () => {
  // SLOW: timed out, no output, killed by budget -> explicit wait.
  const slow = createSubprocessAdapter(stubVendor("sleep 30"));
  const slowDecide = makeDecide({ complete: slow.complete, config: { ...DECIDE_CONFIG, budgetFactor: 0.001 }, scenario: SCENARIO_CTX });
  const slowAction = await slowDecide(structuredClone(OBS));
  assert.equal(slowAction.type, "wait");
  assert.match(slowAction.reason, /exceeded budget/, "slow is a normal explicit wait");

  // ADAPTER FAULT: non-zero exit with auth text on stderr. An expired CLI
  // session must not read as a pensive agent for 200 ticks.
  const auth = createSubprocessAdapter(stubVendor('echo "Not logged in. Login required." 1>&2; exit 1'));
  await assert.rejects(
    () => auth.complete({ system: "s", user: "u", maxTokens: 10 }),
    (err) => {
      assert.equal(err.classification, "adapter_fault");
      assert.match(err.message, /auth failure/);
      return true;
    }
  );
  const authDecide = makeDecide({ complete: auth.complete, config: { ...DECIDE_CONFIG }, scenario: SCENARIO_CTX });
  const authAction = await authDecide(structuredClone(OBS));
  assert.equal(authAction.type, "wait");
  assert.match(authAction.reason, /^adapter_fault: /, "the roster flag rides the wait's reason");

  // Silence with a clean exit is a fault too, not a slow model.
  const silent = createSubprocessAdapter(stubVendor("true"));
  await assert.rejects(
    () => silent.complete({ system: "s", user: "u", maxTokens: 10 }),
    (err) => err.classification === "adapter_fault" && /no output/.test(err.message)
  );

  // BAD OUTPUT: present, unparseable. Logged raw, never retried.
  let badCalls = 0;
  const bad = createSubprocessAdapter(stubVendor('echo "I would rather compose a sonnet."'));
  const countingComplete = async (args) => {
    badCalls += 1;
    return bad.complete(args);
  };
  const badDecide = makeDecide({ complete: countingComplete, config: { ...DECIDE_CONFIG }, scenario: SCENARIO_CTX });
  const badAction = await badDecide(structuredClone(OBS));
  assert.equal(badAction.type, "wait");
  assert.match(badAction.reason, /unparseable model output/);
  assert.equal(badCalls, 1, "never retried");
});

// ---------- 4. empty working directory ----------

test("GATE empty working directory: the spawned process sees a fresh temp dir with no repo files", async () => {
  const adapter = createSubprocessAdapter(stubVendor('echo "cwd=$PWD entries=$(ls -A | wc -l)"'));
  const out = await withBudget(5000, (signal) =>
    adapter.complete({ system: "s", user: "u", maxTokens: 10, signal })
  );
  const m = /cwd=(\S+) entries=\s*(\d+)/.exec(out.result);
  assert.ok(m, `stub reported its cwd: ${out.result}`);
  assert.ok(m[1].includes("fogline-"), "a fresh fogline-* temp dir");
  assert.ok(!m[1].includes("client"), "not the repo");
  assert.equal(m[2], "0", "completely empty — a tool-using CLI finds nothing");
});

// ---------- 5. preamble stripping ----------

test("GATE preamble stripping: banners, bullets, and fences ahead of the JSON all parse", async () => {
  const wanted = '{"type":"wait","reason":"found me"}';
  // The kimi shape, confirmed live: version banner, then a bulleted response.
  const adapter = createSubprocessAdapter(
    stubVendor(`echo "Vendor CLI v9.9.9 (definitely not JSON)"; echo "• ${wanted.replaceAll('"', '\\"')}"`)
  );
  const out = await withBudget(5000, (signal) =>
    adapter.complete({ system: "s", user: "u", maxTokens: 10, signal })
  );
  assert.equal(out.result, wanted);

  // Extraction unit cases: fences, trailing prose, brace-bearing strings.
  assert.equal(extractResponse('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractResponse('Sure! Here you go: {"a":"{not a} brace"} — enjoy'), '{"a":"{not a} brace"}');
  assert.equal(extractResponse("no json at all"), "no json at all", "raw text passes through for bad-output classification");
});

// ---------- 6. surface fingerprint ----------

test("GATE surface fingerprint: stable, shared per account, distinct across accounts, credential-free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fogline-surface-"));
  try {
    const idA = join(dir, "account-a");
    const idB = join(dir, "account-b");
    writeFileSync(idA, "acct_11111111-2222-3333-4444-555555555555\n");
    writeFileSync(idB, "acct_99999999-8888-7777-6666-555555555555\n");

    const fp1 = accountFingerprint({ file: idA });
    const fp2 = accountFingerprint({ file: idA }); // a client restart
    const fpOther = accountFingerprint({ file: idB });
    assert.match(fp1, /^[0-9a-f]{4}$/);
    assert.equal(fp1, fp2, "stable across restarts");
    assert.notEqual(fp1, fpOther, "different accounts differ");

    // Two clients on one account produce the same surface — the visibility
    // this exists for.
    const s1 = createSubprocessAdapter(stubVendor("true", { surface: "stub-cli:sub", account: { file: idA } })).surface();
    const s2 = createSubprocessAdapter(stubVendor("true", { surface: "stub-cli:sub", account: { file: idA } })).surface();
    assert.equal(s1, s2);
    assert.match(s1, /^stub-cli:sub:[0-9a-f]{4}$/);

    // Grep the payload a session would send: no credential material.
    const payload = JSON.stringify({ protocol: "0.5", clientName: "x", modelHint: "y", surface: s1 });
    assert.ok(!payload.includes("acct_11111111"), "the account identifier itself never leaves the process");

    // JSON dot-path extraction (the claude/codex shape).
    const authFile = join(dir, "auth.json");
    writeFileSync(authFile, JSON.stringify({ tokens: { account_id: "org-abc123", access_token: "SECRET" } }));
    const fpJson = accountFingerprint({ file: authFile, path: "tokens.account_id" });
    assert.match(fpJson, /^[0-9a-f]{4}$/);
    assert.notEqual(fpJson, accountFingerprint({ file: authFile, path: "tokens.access_token" }), "sanity: path selects the field");
    assert.equal(accountFingerprint({ file: join(dir, "missing") }), "0000", "not logged in reads as 0000, never a crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 7. per-adapter budget ----------

test("GATE per-adapter budget: different budgetFactor values produce different abort deadlines for one tick", () => {
  assert.equal(claudeCliDefaults.budgetFactor, 0.75);
  assert.equal(codexCliDefaults.budgetFactor, 0.6);
  assert.equal(kimiCliDefaults.budgetFactor, 0.6);

  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const deadline = "2026-08-23T12:00:20.000Z"; // one tick, 20s away
  const claudeBudget = computeBudgetMs(deadline, createClaudeCli().budgetFactor, now);
  const codexBudget = computeBudgetMs(deadline, createCodexCli().budgetFactor, now);
  assert.equal(claudeBudget, 15000);
  assert.equal(codexBudget, 12000);
  assert.notEqual(claudeBudget, codexBudget, "a slower CLI gets a different leash");

  // config.json "adapters" overrides win over the shipped defaults.
  assert.equal(createKimiCli({ budgetFactor: 0.9 }).budgetFactor, 0.9);
});

// ---------- 7b. tier models never cross vendors ----------

test("GATE tier isolation: claude tier ids never reach another vendor's -m flag", async () => {
  // Found live: the global cheapModel/richModel (claude ids) were handed to
  // every adapter, and codex/kimi exit 1 on an unknown model — every tick,
  // from tick 1, reading as adapter_fault. Tier models are per-adapter.
  assert.equal(claudeCliDefaults.richModel, "claude-sonnet-5");
  assert.equal(claudeCliDefaults.cheapModel, "claude-haiku-4-5-20251001");
  assert.equal(codexCliDefaults.cheapModel, undefined, "codex declares no claude tiers");
  assert.equal(kimiCliDefaults.cheapModel, undefined, "kimi declares no claude tiers");

  // With no model resolved, the -m pair is dropped entirely: capture the
  // exact argv a codex call would spawn via a stub cmd that echoes it.
  const echoArgs = {
    ...codexCliDefaults,
    cmd: "/bin/sh",
    args: ["-c", 'echo "$0 $@"', ...codexCliDefaults.args.slice(1)],
  };
  const adapter = createSubprocessAdapter(echoArgs);
  const out = await withBudget(5000, (signal) =>
    adapter.complete({ system: "s", user: "u", maxTokens: 10, signal, model: null })
  );
  assert.ok(!out.result.includes("-m"), `argv carries no -m when no vendor model resolves: ${out.result}`);
  assert.ok(!out.result.includes("claude"), "and certainly no claude id");
});

// ---------- 8. three-vendor run ----------

test("GATE three-vendor run: three clients, three adapters, one world, 40 ticks, three surfaces on the roster", async () => {
  const daemon = createDaemon(
    { startPaused: false, actionDeadlineMs: 500, maxTicks: 40, minAgents: 3, reapAfterTicks: 1000 },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "fogline-3v-"));
  const sessions = [];
  try {
    const done = new Promise((resolve) => {
      daemon.engine.on("operator", ({ event, data }) => {
        if (event === "barrier" && data.event === "run_complete") resolve(data);
      });
    });
    const scenario = await (await fetch(`${base}/scenario`)).json();

    const vendors = [
      { name: "Stub Ada", vendor: "alpha-cli" },
      { name: "Stub Bex", vendor: "beta-cli" },
      { name: "Stub Cyr", vendor: "gamma-cli" },
    ];
    for (const [i, v] of vendors.entries()) {
      const idFile = join(dir, `${v.vendor}.id`);
      writeFileSync(idFile, `account-${v.vendor}`);
      const fixed = JSON.stringify({ type: "wait", reason: `${v.vendor} holding`, intent: { summary: "hold", kind: "wait", target: null } });
      const adapter = createSubprocessAdapter({
        cmd: "/bin/sh",
        args: ["-c", `echo '${fixed}'`],
        input: "stdin",
        budgetFactor: 0.75,
        surface: `${v.vendor}:sub`,
        account: { file: idFile },
      });
      const session = new Session({
        server: base,
        persona: {
          name: v.name,
          appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
          disposition: "neutral",
          identity: `You are ${v.name}, a three-vendor fixture.`,
          discoverable: "You arrived with two strangers billed elsewhere.",
          privateObjective: "You want the roster to show three surfaces.",
        },
        clientName: `client-${v.vendor}`,
        modelHint: v.vendor,
        surface: adapter.surface(),
        decide: makeDecide({ complete: adapter.complete, config: { budgetFactor: 0.75, maxTokens: 100, cheapTicks: false }, scenario }),
        identityStore: memoryIdentityStore(),
        log: () => {},
      });
      sessions.push(session);
      const joined = await session.connect();
      assert.equal(joined.mode, "register", `vendor ${i} registered`);
      session.run(); // fire and forget; leave() stops it
    }

    await done; // 40 ticks, no crash
    assert.equal(daemon.engine.tick, 40);

    const snapshot = await (await fetch(`${base}/observatory/snapshot`)).json();
    const surfaces = snapshot.agents.map((a) => a.connection.surface).filter(Boolean);
    assert.equal(surfaces.length, 3, "every agent declared a surface");
    assert.equal(new Set(surfaces).size, 3, "three DISTINCT billing surfaces on the roster");
    for (const s of surfaces) assert.match(s, /^(alpha|beta|gamma)-cli:sub:[0-9a-f]{4}$/);

    // Spend attribution reached the operator stream per surface.
    assert.ok(Array.isArray(snapshot.spend) && snapshot.spend.length === 3, "per-surface call totals aggregated");
    for (const row of snapshot.spend) assert.ok(row.callsTotal > 0, `${row.surface} reported calls`);
  } finally {
    for (const s of sessions) await s.leave().catch(() => {});
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 9. startup fault resilience (run5-k1 regression) ----------

test("regression run5-k1: an adapter fault during persona generation at registration is logged and retried, never fatal", async () => {
  // The observed death: attach answered SLOT_RECLAIMED, the persisted
  // identity was discarded, and the fresh _register()'s persona generation
  // hit a CLI that exited 1 ("exit 1: kimi version 0.38.0") — the
  // adapter_fault bubbled out of connectWithPolling and killed the process.
  // Startup must survive it the way the per-tick loop does: log and retry.
  const daemon = createDaemon(
    { startPaused: true, actionDeadlineMs: 500, maxTicks: 40, minAgents: 1, reapAfterTicks: 1000 },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "fogline-fault-"));
  try {
    const scenario = await (await fetch(`${base}/scenario`)).json();

    // A CLI that dies with a version banner on its first call, then behaves:
    // the exact kimi failure shape, through the real subprocess adapter.
    const marker = join(dir, "already-failed");
    const personaFile = join(dir, "persona.json");
    writeFileSync(
      personaFile,
      JSON.stringify({
        name: "Wren Redux",
        appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
        disposition: "neutral",
        identity: "You are the second attempt.",
        discoverable: "You exist because the first CLI call exited 1.",
        privateObjective: "You want the run to outlive its adapter's bad days.",
      })
    );
    const adapter = createSubprocessAdapter(
      stubVendor(`if [ -e "${marker}" ]; then cat "${personaFile}"; else touch "${marker}"; echo "kimi version 0.38.0"; exit 1; fi`)
    );

    const logs = [];
    const session = new Session({
      server: base,
      persona: null,
      personaProvider: { create: () => generatePersona({ scenario, complete: adapter.complete }) },
      clientName: "client-fault-retry",
      modelHint: "stub-cli",
      decide: makeDecide({ complete: adapter.complete, config: { budgetFactor: 0.75, maxTokens: 100, cheapTicks: false }, scenario }),
      // Persisted identity for a body the daemon no longer knows: the
      // discard-and-register-fresh path from the transcript.
      identityStore: memoryIdentityStore({ agentId: "a_dead", token: "stale" }),
      log: (msg) => logs.push(msg),
    });

    const joined = await connectWithPolling({
      session,
      server: base,
      scenario,
      config: { pollIntervalMs: 50, pollWhenFull: true },
      heirOnly: false,
      makeHeirProvider: () => ({ create: async () => null }),
      log: (msg) => logs.push(msg),
    });

    assert.equal(joined.mode, "register", "the retry registered fresh instead of dying");
    assert.equal(joined.name, "Wren Redux");
    assert.ok(session.agentId, "the session holds a live body");
    assert.ok(
      logs.some((l) => /adapter_fault: exit 1: kimi version 0\.38\.0 — retrying in \d+ms/.test(l)),
      `the fault was logged with its retry, not fatal (got: ${JSON.stringify(logs)})`
    );
  } finally {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
