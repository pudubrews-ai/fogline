// v0.8 gates (daemon spec v0.8 §5): the run archive and the supervised
// post-run crosscheck. Nothing agent-facing changes in v0.8; every assertion
// here is on the operator side of the fog.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../server.js";
import { createRunArchive } from "../run/archive.js";
import { createCrosscheckSupervisor } from "../run/crosscheck.js";
import { buildExtract } from "../run/extract.js";
import { register, act, openSse } from "./helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeoutMs = 10000, everyMs = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not reached in time");
    await sleep(everyMs);
  }
}

// A world where everyone starves at tick 1 and the run completes there:
// deterministic deaths, a completed run, no client needed beyond two waits.
const LETHAL = {
  gridSize: 4,
  slots: 5,
  minAgents: 2,
  expectedAgents: 2,
  maxTicks: 1,
  startPaused: true,
  reapAfterTicks: 100,
  vitals: {
    sustenanceMax: 100,
    sustenanceDecayPerTick: 120,
    sivetRestores: 25,
    vitalityMax: 100,
    starvationDamagePerTick: 150,
    regenThreshold: 50,
    regenPerTick: 1,
    attackDamage: 25,
    attackCost: 6,
    sponsorDrainPerTick: 1,
    orphanDamagePerTick: 8,
  },
};

function bootArchived(overrides = {}, options = { logs: false }) {
  const tmp = mkdtempSync(join(tmpdir(), "fishbowl-v08-"));
  const daemon = createDaemon(
    {
      ...LETHAL,
      archive: { path: join(tmp, "archive"), clientLogs: [] },
      crosscheck: { enabled: false },
      ...overrides,
    },
    options
  );
  const server = daemon.listen(0);
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { daemon, server, base, tmp };
}

// Drives the lethal world through its single tick to run_complete.
async function runToCompletion(daemon, base) {
  const a = await register(base, "Arlo");
  const b = await register(base, "Bram");
  // A build that succeeds: credit the exact material by operator fiat so
  // structuresByForm has a row. (Test fixture, not an agent-visible change.)
  daemon.engine.world.agents.get(a.body.agentId).inventory.orrum = 1;
  daemon.engine.play();
  await until(() => daemon.engine.phase === "COLLECTING");
  await act(base, a.body.token, {
    tick: 1,
    type: "build",
    structure: { form: "marker", name: "Last Marker", description: "a fixture" },
  });
  await act(base, b.body.token, { tick: 1, type: "wait" });
  await until(() => daemon.engine.stopped === true);
  return { a, b };
}

// ---------- 1. archive at boot ----------

test("GATE archive at boot: config, boot figures, and run_started land in record.json before tick 1", async () => {
  const { daemon, tmp } = bootArchived();
  try {
    const runId = daemon.engine.runId;
    const path = join(tmp, "archive", runId, "record.json");
    assert.ok(existsSync(path), "record.json written at boot");
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.runId, runId);
    assert.equal(record.config.maxTicks, 1, "config stored verbatim");
    assert.equal(typeof record.boot.viability.ratio, "number", "boot viability figures");
    assert.equal(typeof record.boot.constructionSlack.slack, "number", "construction slack");
    assert.equal(record.runStarted.event, "run_started", "the run_started record itself");
    assert.ok(Array.isArray(record.runStarted.deposits), "seeded deposits with coordinates");
    assert.equal(record.outcome, null, "no outcome yet — the run has not stopped");
    const index = JSON.parse(readFileSync(join(tmp, "archive", "index.json"), "utf8"));
    assert.equal(index.runs.find((r) => r.runId === runId).complete, false);
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 2. outcome summary ----------

test("GATE outcome summary: a completed run writes survivors, deaths with cause and foodAtDeath, structures by form, and action counts", async () => {
  const { daemon, base, tmp } = bootArchived();
  try {
    await runToCompletion(daemon, base());
    const record = JSON.parse(readFileSync(join(tmp, "archive", daemon.engine.runId, "record.json"), "utf8"));
    const o = record.outcome;
    assert.ok(o, "outcome written when the run stopped");
    assert.equal(o.endedBy, "max_ticks");
    assert.equal(o.finalTick, 1);
    assert.equal(o.survivors.length, 0, "everyone starved");
    assert.equal(o.deaths.length, 2);
    for (const d of o.deaths) {
      assert.equal(d.cause, "starvation");
      assert.ok(["inventory", "nearby", "none"].includes(d.foodAtDeath), "foodAtDeath recorded");
      assert.equal(typeof d.foodReachable, "boolean");
      assert.ok(d.cell, "death cell recorded");
    }
    assert.equal(o.structuresByForm.marker, 1, "structures counted by form");
    assert.equal(o.actionCounts.build, 1);
    assert.equal(o.actionCounts.wait, 1);
    const index = JSON.parse(readFileSync(join(tmp, "archive", "index.json"), "utf8"));
    const entry = index.runs.find((r) => r.runId === record.runId);
    assert.equal(entry.complete, true);
    assert.equal(entry.deaths, 2);
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 3. abandoned run ----------

test("GATE abandoned run: a run killed mid-flight leaves an index entry marked incomplete rather than vanishing", async () => {
  const { daemon, base, tmp } = bootArchived({ maxTicks: 50 });
  try {
    const a = await register(base(), "Cass");
    const b = await register(base(), "Dill");
    daemon.engine.step();
    await until(() => daemon.engine.phase === "COLLECTING");
    await act(base(), a.body.token, { tick: 1, type: "wait" });
    await act(base(), b.body.token, { tick: 1, type: "wait" });
    await until(() => daemon.engine.phase === "RESOLVED");
    // Simulate the process dying: no close, no finalize — a fresh archive
    // instance rebuilds the index from the records alone.
    const other = createRunArchive({ archive: { path: join(tmp, "archive") } });
    const index = other.rebuildIndex();
    const entry = index.runs.find((r) => r.runId === daemon.engine.runId);
    assert.ok(entry, "the abandoned run is in the index");
    assert.equal(entry.complete, false, "marked incomplete, not missing");
    assert.equal(entry.survivors, null, "no outcome fields invented");
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 4. the index is derived ----------

test("GATE index derived: deleting index.json and rebuilding from the records produces an identical file", async () => {
  const { daemon, base, tmp } = bootArchived();
  try {
    await runToCompletion(daemon, base());
    daemon.engine.reset(); // a second run boots — two records now exist
    const indexPath = join(tmp, "archive", "index.json");
    const before = readFileSync(indexPath, "utf8");
    unlinkSync(indexPath);
    const other = createRunArchive({ archive: { path: join(tmp, "archive") } });
    other.rebuildIndex();
    const after = readFileSync(indexPath, "utf8");
    assert.equal(after, before, "rebuilt index is byte-identical");
    assert.equal(JSON.parse(after).runs.length, 2, "both runs present");
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 5. archive containment ----------

test("GATE archive containment: no agent route reaches anything under the archive path", async () => {
  const { daemon, base, tmp } = bootArchived();
  try {
    const a = await register(base(), "Evey");
    const token = a.body.token;
    const runId = daemon.engine.runId;
    // Structurally: the agent realm's source mounts no archive route at all.
    const agentSource = readFileSync(new URL("../api/agent.js", import.meta.url), "utf8");
    assert.ok(!/archive/i.test(agentSource), "api/agent.js never mentions the archive");
    // The archive read routes live in the operator realm, which rejects an
    // agent token outright (protocol §14) — 403, not content.
    for (const path of [
      "/observatory/archive/index",
      `/observatory/archive/${runId}`,
      `/observatory/archive/${runId}/crosscheck`,
    ]) {
      const res = await fetch(`${base()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 403, `${path} is unreachable with an agent token`);
    }
    // And the static tree cannot serve it: the archive root sits outside
    // public/, so no unauthenticated static path resolves into it.
    const res = await fetch(`${base()}/archive/${runId}/record.json`);
    assert.equal(res.status, 404, "no static route serves the archive");
    assert.ok(!daemon.archive.root.includes("public"), "archive root is not under public/");
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 6. extract ceiling ----------

test("GATE extract ceiling: an extract exceeding maxExtractBytes refuses and reports its size rather than truncating", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "fishbowl-v08-extract-"));
  try {
    const worldLog = join(tmp, "world.log");
    const lines = [JSON.stringify({ ts: "t", event: "viability", runId: "r_x" })];
    for (let t = 1; t <= 200; t++) {
      lines.push(JSON.stringify({ ts: "t", event: "gather", tick: t, agentId: "a_1", detail: "x".repeat(200) }));
    }
    writeFileSync(worldLog, lines.join("\n") + "\n");
    const outcome = { finalTick: 200, deaths: [], survivors: [], structuresByForm: {}, inscriptions: [], destruction: [], actionCounts: {} };

    const refused = buildExtract({ runId: "r_x", worldLogPath: worldLog, outcome, maxExtractBytes: 1000 });
    assert.equal(refused.ok, false, "refused, not truncated");
    assert.ok(refused.bytes > 1000, "the actual size is reported");
    assert.equal(refused.maxExtractBytes, 1000);

    // Through the supervisor: the refusal lands on the run record and no
    // extract file is written at any size.
    const archive = createRunArchive({ archive: { path: join(tmp, "archive") } });
    archive.writeBoot("r_x", { config: {}, viability: null, constructionSlack: null, runStarted: { ts: "t", configHash: "h" }, logs: {} });
    const sup = createCrosscheckSupervisor({
      config: { crosscheck: { enabled: true, maxExtractBytes: 1000, cmd: "true", args: [] } },
      archive,
      baseDir: tmp,
    });
    const out = sup.maybeStart("r_x", outcome, { worldLogPath: worldLog });
    assert.equal(out.started, false);
    const record = archive.readRecord("r_x");
    assert.equal(record.crosscheck.status, "failed");
    assert.match(record.crosscheck.reason, /exceeding maxExtractBytes/);
    assert.match(record.crosscheck.reason, /refusing rather than truncating/);
    assert.equal(typeof record.crosscheck.extractBytes, "number");
    assert.ok(!existsSync(join(tmp, "archive", "r_x", "extract.txt")), "nothing truncated onto disk");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- shared fixture for supervisor tests ----------

function supervisorFixture(ccOverrides) {
  const tmp = mkdtempSync(join(tmpdir(), "fishbowl-v08-sup-"));
  const worldLog = join(tmp, "world.log");
  writeFileSync(
    worldLog,
    [
      JSON.stringify({ ts: "t", event: "viability", runId: "r_1" }),
      JSON.stringify({ event: "gather", tick: 1, agentId: "a_1" }),
    ].join("\n") + "\n"
  );
  const outcome = { finalTick: 1, deaths: [], survivors: [], structuresByForm: {}, inscriptions: [], destruction: [], actionCounts: {} };
  const archive = createRunArchive({ archive: { path: join(tmp, "archive") } });
  archive.writeBoot("r_1", { config: {}, viability: null, constructionSlack: null, runStarted: { ts: "t1", configHash: "h" }, logs: {} });
  archive.writeOutcome("r_1", { ...outcome, endedAt: "t2", endedBy: "max_ticks" });
  const statuses = [];
  const sup = createCrosscheckSupervisor({
    config: { crosscheck: { enabled: true, maxExtractBytes: 250000, ...ccOverrides } },
    archive,
    baseDir: tmp,
    onStatus: (s) => statuses.push(s.state),
  });
  return { tmp, worldLog, outcome, archive, sup, statuses };
}

// ---------- 7. failure is non-fatal ----------

test("GATE crosscheck failure non-fatal: a non-zero exit leaves the run record intact and notes the failure", async () => {
  const { tmp, worldLog, outcome, archive, sup } = supervisorFixture({
    cmd: "bash",
    args: ["-c", "exit 3"],
    timeoutMs: 10000,
  });
  try {
    const out = sup.maybeStart("r_1", outcome, { worldLogPath: worldLog });
    assert.equal(out.started, true);
    await until(() => sup.status().state === "failed");
    const record = archive.readRecord("r_1");
    assert.equal(record.crosscheck.status, "failed");
    assert.match(record.crosscheck.reason, /exited 3/);
    assert.equal(record.outcome.endedBy, "max_ticks", "the outcome summary is untouched");
    assert.equal(record.runStarted.configHash, "h", "boot material is untouched");
  } finally {
    sup.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 8. process-group cleanup ----------

test("GATE process-group cleanup: a forking crosscheck is terminated whole on timeout and on shutdown — clean table across 100 cycles", async () => {
  const { tmp, worldLog, outcome, sup } = supervisorFixture({
    cmd: "bash",
    args: ["-c", "sleep 297.53 & exec sleep 297.53"],
    timeoutMs: 30,
  });
  try {
    for (let i = 0; i < 99; i++) {
      const out = sup.maybeStart("r_1", outcome, { worldLogPath: worldLog });
      assert.equal(out.started, true, `cycle ${i} started`);
      await until(() => sup.status().state === "timed_out", { timeoutMs: 5000 });
    }
    // The hundredth cycle is killed by shutdown rather than timeout.
    const { sup: sup2, tmp: tmp2 } = supervisorFixture({
      cmd: "bash",
      args: ["-c", "sleep 297.53 & exec sleep 297.53"],
      timeoutMs: 60000,
    });
    sup2.maybeStart("r_1", outcome, { worldLogPath: worldLog });
    await until(() => sup2.status().state === "running");
    sup2.shutdown();
    rmSync(tmp2, { recursive: true, force: true });
    await sleep(300); // let SIGKILL land everywhere
    const table = execSync("ps ax -o command").toString();
    assert.ok(!table.includes("sleep 297.53"), "no orphan survives 100 cycles");
  } finally {
    sup.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 9. one at a time ----------

test("GATE one at a time: a second run stopping mid-crosscheck is refused and says so, never doubled", async () => {
  const { tmp, worldLog, outcome, archive, sup } = supervisorFixture({
    cmd: "bash",
    args: ["-c", "sleep 10"],
    timeoutMs: 60000,
  });
  try {
    archive.writeBoot("r_2", { config: {}, viability: null, constructionSlack: null, runStarted: { ts: "t3", configHash: "h" }, logs: {} });
    archive.writeOutcome("r_2", { ...outcome, endedAt: "t4", endedBy: "reset" });
    assert.equal(sup.maybeStart("r_1", outcome, { worldLogPath: worldLog }).started, true);
    await until(() => sup.status().state === "running");
    const second = sup.maybeStart("r_2", outcome, { worldLogPath: worldLog });
    assert.equal(second.started, false);
    assert.equal(second.why, "already running");
    assert.equal(sup.status().runId, "r_1", "the first crosscheck is the one running");
    const record = archive.readRecord("r_2");
    assert.equal(record.crosscheck.status, "skipped");
    assert.match(record.crosscheck.reason, /r_1 still running/);
  } finally {
    sup.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 10. status is observable ----------

test("GATE status observable: idle, running, done, failed, and timed_out each reach the operator channel", async () => {
  // Unit level: every transition fires onStatus.
  const done = supervisorFixture({ cmd: "bash", args: ["-c", "true"], timeoutMs: 10000 });
  const failed = supervisorFixture({ cmd: "bash", args: ["-c", "exit 1"], timeoutMs: 10000 });
  const timed = supervisorFixture({ cmd: "bash", args: ["-c", "sleep 20"], timeoutMs: 40 });
  try {
    assert.equal(done.sup.status().state, "idle", "idle before anything starts");
    done.sup.maybeStart("r_1", done.outcome, { worldLogPath: done.worldLog });
    failed.sup.maybeStart("r_1", failed.outcome, { worldLogPath: failed.worldLog });
    timed.sup.maybeStart("r_1", timed.outcome, { worldLogPath: timed.worldLog });
    await until(() => done.sup.status().state === "done");
    await until(() => failed.sup.status().state === "failed");
    await until(() => timed.sup.status().state === "timed_out");
    assert.deepEqual(done.statuses, ["running", "done"]);
    assert.deepEqual(failed.statuses, ["running", "failed"]);
    assert.deepEqual(timed.statuses, ["running", "timed_out"]);
    assert.equal(typeof timed.sup.status().elapsedMs, "number", "running carries elapsed time");
  } finally {
    for (const f of [done, failed, timed]) {
      f.sup.shutdown();
      rmSync(f.tmp, { recursive: true, force: true });
    }
  }

  // Integration: the transitions ride the operator SSE stream, and the
  // snapshot carries the current state.
  const { daemon, base, tmp } = bootArchived({
    crosscheck: { enabled: true, cmd: "bash", args: ["-c", "true"], timeoutMs: 10000, maxExtractBytes: 250000 },
  });
  try {
    const seen = [];
    const sse = await openSse(`${base()}/observatory/stream`, null, ({ event, data }) => {
      if (event === "crosscheck") seen.push(data.state);
    });
    const snap0 = await (await fetch(`${base()}/observatory/snapshot`)).json();
    assert.equal(snap0.crosscheck.state, "idle", "snapshot exposes crosscheck state");
    await runToCompletion(daemon, base());
    await until(() => seen.includes("done"), { timeoutMs: 15000 });
    assert.ok(seen.includes("running"), "running reached the operator channel");
    sse.close();
  } finally {
    await daemon.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 11. non-blocking ----------

test("GATE non-blocking: the daemon serves the observatory and /scenario throughout a crosscheck", async () => {
  const { daemon, base, tmp } = bootArchived({
    crosscheck: { enabled: true, cmd: "bash", args: ["-c", "sleep 5"], timeoutMs: 60000, maxExtractBytes: 250000 },
  });
  try {
    await runToCompletion(daemon, base());
    await until(() => daemon.crosscheck.status().state === "running");
    const snap = await fetch(`${base()}/observatory/snapshot`);
    assert.equal(snap.status, 200, "observatory served mid-crosscheck");
    assert.equal((await snap.json()).crosscheck.state, "running");
    const scenario = await fetch(`${base()}/scenario`);
    assert.equal(scenario.status, 200, "/scenario served mid-crosscheck");
  } finally {
    await daemon.close(); // also exercises shutdown-kill of the running group
    rmSync(tmp, { recursive: true, force: true });
  }
});
