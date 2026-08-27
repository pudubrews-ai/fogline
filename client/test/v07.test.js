// v0.7 gates (client spec v0.7 §5): the GLM surface produces a parseable
// action with its latency recorded, version drift warns loudly, a broken
// CLI refuses to take a slot, consecutive adapter faults alarm, and the two
// prompt additions — consume outcome and vitality trend — render verbatim
// with no advice riding them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../prompt.js";
import { parseAction } from "../parse.js";
import { makeDecide, startupSmokeTest, versionDriftWarning } from "../index.js";
import { createSubprocessAdapter, checkVersionPin } from "../adapters/subprocess.js";
import { create as createGlm } from "../adapters/glm-cli.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

const SCENARIO = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const OBS = {
  protocol: "0.7",
  tick: 7,
  simTime: "10:45",
  deadline: new Date(Date.now() + 45000).toISOString(),
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
    sustenance: 80,
    vitality: 88,
    vitalityTrend: "holding",
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

// ---------- 1. GLM adapter, live ----------

test("GATE GLM adapter: smoke test passes, a realistic observation produces a parseable action, latency recorded", { timeout: 240000 }, async () => {
  const adapter = createGlm();
  // The smoke test is the register gate; its measured latency is the record.
  const smoke = await startupSmokeTest({ complete: adapter.complete });
  assert.ok(typeof smoke.ms === "number" && smoke.ms > 0, "smoke latency recorded");

  const obs = structuredClone(OBS);
  obs.deadline = new Date(Date.now() + 45000).toISOString();
  const { system, user } = buildPrompt(obs, SCENARIO);
  const started = Date.now();
  const raw = await adapter.complete({ system, user, maxTokens: 1000 });
  const actionMs = Date.now() - started;
  const parsed = parseAction(raw, obs, { inscriptionMax: 500, structureForms: SCENARIO.structureForms });
  assert.ok(parsed.ok, `parseable action from GLM (got: ${String(raw).slice(0, 120)})`);

  // The tick-fit verdict is a reportable result either way, never hidden:
  // 45s deadline at budgetFactor 0.9 is the leash it must fit.
  const budget = 45000 * (adapter.budgetFactor ?? 0.9);
  console.error(
    `[glm latency] smoke ${smoke.ms}ms, action ${actionMs}ms against a ${Math.round(budget)}ms budget — ` +
      (actionMs <= budget ? "fits the tick" : "DOES NOT FIT THE TICK; report before running")
  );
  assert.ok(smoke.ms < 120000 && actionMs < 120000, "latencies are on record and bounded");
});

// ---------- 2. version pin ----------

test("GATE version pin: a CLI whose version differs from the pinned value produces a loud warning; a match stays silent", async () => {
  const drifted = await checkVersionPin({ cmd: "echo", versionArgs: ["9.9.9"], pinnedVersion: "1.0.0" });
  assert.equal(drifted.actual, "9.9.9");
  assert.equal(drifted.matches, false);
  const warning = versionDriftWarning(drifted, "echo");
  assert.ok(warning && warning.includes("[VERSION PIN]"), "loud, labeled warning");
  assert.ok(warning.includes("9.9.9") && warning.includes("1.0.0"), "both versions named");

  const pinned = await checkVersionPin({ cmd: "echo", versionArgs: ["1.0.0"], pinnedVersion: "1.0.0" });
  assert.equal(pinned.matches, true);
  assert.equal(versionDriftWarning(pinned, "echo"), null);

  // A missing binary is a drift too — there is nothing confirmed-working.
  const missing = await checkVersionPin({ cmd: "no-such-binary-anywhere", pinnedVersion: "1.0.0" });
  assert.equal(missing.matches, false);
});

// ---------- 3. startup smoke test refuses a broken CLI ----------

test("GATE smoke test: a CLI that cannot produce a response refuses to take a slot — the process exits before registering", { timeout: 60000 }, async () => {
  // Unit level: exit 1 from the CLI is a rejection, parseable JSON resolves.
  const broken = createSubprocessAdapter({ cmd: "false", args: [], input: "stdin", surface: "t:sub" });
  await assert.rejects(() => startupSmokeTest({ complete: broken.complete, budgetMs: 10000 }));
  const fine = createSubprocessAdapter({
    cmd: "sh", args: ["-c", 'echo {\\"ok\\":true}'], input: "stdin", surface: "t:sub",
  });
  const r = await startupSmokeTest({ complete: fine.complete, budgetMs: 10000 });
  assert.ok(r.ms >= 0);

  // Process level: a shimmed broken `claude` makes `node index.js` exit 1
  // with the refusal, before any registration attempt — the server URL is
  // unreachable on purpose, and must never be contacted.
  const shimDir = mkdtempSync(join(tmpdir(), "fogline-shim-"));
  const identity = join(baseDir, "..", ".fogline-identity-v07smoke.json");
  try {
    const shim = join(shimDir, "claude");
    writeFileSync(shim, "#!/bin/sh\nexit 2\n");
    chmodSync(shim, 0o755);
    const out = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(baseDir, "..", "index.js"), "--adapter", "claude-cli", "--server", "http://127.0.0.1:1", "--label", "v07smoke"],
        { env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } }
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(out.code, 1, `exits 1 (stderr: ${out.stderr.slice(0, 200)})`);
    assert.ok(out.stderr.includes("refusing to take a slot"), "says why");
    assert.ok(!out.stderr.includes("registered"), "never registered");
    assert.ok(!existsSync(identity), "no identity persisted — no slot taken");
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(identity, { force: true });
  }
});

// ---------- 4. consecutive fault alarm ----------

test("GATE fault alarm: N consecutive adapter_fault results produce a console alarm and clientStatus shows the fault", async () => {
  const faulting = async () => {
    throw Object.assign(new Error("exit 1: broken"), { classification: "adapter_fault" });
  };
  const config = { budgetFactor: 0.75, maxTokens: 100, cheapTicks: false, faultAlarmAfter: 3 };
  const decide = makeDecide({ complete: faulting, config, scenario: SCENARIO });

  const alarms = [];
  const realError = console.error;
  console.error = (msg) => {
    if (String(msg).includes("[ADAPTER ALARM]")) alarms.push(String(msg));
  };
  try {
    for (let i = 0; i < 3; i++) {
      const action = await decide(structuredClone(OBS));
      assert.equal(action.clientStatus, "adapter_fault", "the roster sees every fault");
    }
  } finally {
    console.error = realError;
  }
  assert.equal(alarms.length, 1, "quiet until the streak reaches N, loud at N");
  assert.ok(alarms[0].includes("3 consecutive adapter faults"));

  // A success resets the streak — the alarm is about a broken client, not a
  // client that once hiccuped.
  const ok = makeDecide({ complete: async () => '{"type":"wait","reason":"r"}', config, scenario: SCENARIO });
  const fine = await ok(structuredClone(OBS));
  assert.equal(fine.clientStatus, "ok");
});

// ---------- 5. consume outcome in the prompt ----------

test("GATE consume outcome: a nil-effect consume renders verbatim with no added advice — wordlist-asserted", () => {
  const obs = {
    ...OBS,
    self: {
      ...OBS.self,
      lastActionOutcome: { type: "consume", result: "ok", why: "consumed 1 khal; it restored nothing" },
    },
  };
  const { user } = buildPrompt(obs, SCENARIO);
  assert.ok(
    user.includes("Your last action (consume): consumed 1 khal; it restored nothing."),
    "the daemon's outcome text arrives verbatim"
  );
  const block = user.slice(user.indexOf("Your last action (consume)")).split("\n\n")[0];
  for (const word of [
    "instead", "consider", "perhaps", "maybe", "try ", "should", "waste",
    "wasted", "mistake", "unwise", "avoid", "next time", "sivet", "advice",
    "don't", "do not eat", "conserve",
  ]) {
    assert.ok(!block.toLowerCase().includes(word), `advice word "${word}" rides the consume outcome: ${block}`);
  }

  // A restorative consume reports its amount the same way, still verbatim.
  const fed = {
    ...OBS,
    self: {
      ...OBS.self,
      lastActionOutcome: { type: "consume", result: "ok", why: "consumed 1 sivet; it restored 25 sustenance" },
    },
  };
  assert.ok(
    buildPrompt(fed, SCENARIO).user.includes("Your last action (consume): consumed 1 sivet; it restored 25 sustenance."),
    "the restorative outcome is reported the same way"
  );
});

// ---------- 6. vitality trend in the prompt ----------

test("GATE vitality trend: all three values render beside the raw numbers; no threshold, quantity, or recommendation anywhere — wordlist-asserted", () => {
  for (const trend of ["recovering", "holding", "falling"]) {
    const obs = { ...OBS, self: { ...OBS.self, vitalityTrend: trend } };
    const { system, user } = buildPrompt(obs, SCENARIO);
    const line = user.split("\n").find((l) => l.startsWith("Your condition:"));
    assert.ok(line.includes(`and your vitality is ${trend}`), `"${trend}" beside the raw numbers: ${line}`);

    // The mechanic stays invisible: nothing names a threshold or a regen
    // rule anywhere in the prompt, and nothing on the condition line says
    // what would change the trend or how much anything would take.
    const text = `${system}\n${user}`;
    assert.ok(!/threshold/i.test(text), "no threshold anywhere");
    assert.ok(!/regen/i.test(text), "no regen rule anywhere");
    for (const word of [
      "eat", "feed", "give", "needs", "requires", "would take", "enough",
      "units", "to recover", "to stop", "because", "caused",
    ]) {
      assert.ok(!line.toLowerCase().includes(word), `explanation word "${word}" rides the condition line: ${line}`);
    }
  }

  // An observation without the field (an older daemon) renders unchanged.
  const bare = { ...OBS, self: { ...OBS.self } };
  delete bare.self.vitalityTrend;
  const { user } = buildPrompt(bare, SCENARIO);
  const line = user.split("\n").find((l) => l.startsWith("Your condition:"));
  assert.ok(!line.includes("vitality is"), "no trend clause without the field");
});
