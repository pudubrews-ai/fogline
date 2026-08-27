// Post-run crosscheck supervision (daemon spec v0.8 §3.2). When a run stops,
// the daemon starts crosscheck automatically and OWNS its lifecycle:
// non-blocking, one at a time, hard timeout, process-group kill on timeout
// and on shutdown. A crosscheck must never outlive the daemon that started
// it — run 8 left five orphaned client processes behind, and crosscheck
// nests four CLI subprocesses deeper, each holding a subscription session.
//
// CREDENTIALS (spec §3.2, stated rather than inferred): spawning crosscheck
// is NOT a breach of the daemon's no-credentials invariant. Crosscheck
// authenticates through its own CLI OAuth exactly as an agent client does —
// the daemon starts a process and never holds, reads, or passes a key.
// Nothing in this module touches a credential, an env secret, or a .env.
//
// Crosscheck itself is a standalone CLI with its own repo and spec; v0.8
// does not fork, modify, or vendor it (§3.1). Fogline invokes it, files the
// result, and crosscheck does not learn what fogline is.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExtract, DEFAULT_QUESTION } from "./extract.js";

export const CROSSCHECK_DEFAULTS = {
  enabled: true,
  timeoutMs: 900000, // ~15 minutes, generous — four vendor calls at up to 120s+ each
  cmd: "node",
  args: ["../crosscheck/evaluate.js"],
  maxExtractBytes: 250000,
  question: null, // null -> the default post-run question (extract.js)
};

export const crosscheckConfig = (config) => ({ ...CROSSCHECK_DEFAULTS, ...(config.crosscheck ?? {}) });

export function createCrosscheckSupervisor({ config, archive, baseDir = process.cwd(), onStatus = () => {} }) {
  const cc = crosscheckConfig(config);

  let status = { state: "idle", runId: null, startedAt: null, elapsedMs: null, reportPath: null, reason: null };
  let child = null;
  let timeoutTimer = null;
  let startedAtMs = null;
  let closed = false; // a closing daemon starts nothing new

  function setStatus(next) {
    status = { ...status, ...next };
    if (status.state === "running" && startedAtMs) status.elapsedMs = Date.now() - startedAtMs;
    onStatus(currentStatus());
  }

  function currentStatus() {
    return {
      ...status,
      elapsedMs: status.state === "running" && startedAtMs ? Date.now() - startedAtMs : status.elapsedMs,
    };
  }

  // Kill the process GROUP, not the pid (§3.2): crosscheck spawns four CLI
  // subprocesses which may fork children of their own.
  function killGroup() {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }

  function clearTimer() {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  function record(runId, fields) {
    archive.setCrosscheck(runId, { question: fields.question ?? null, ...fields });
  }

  // §3.2: one at a time. A run stopping while a crosscheck is in flight is
  // refused — and said so on the run record — rather than queued or doubled.
  function maybeStart(runId, outcome, { worldLogPath, clientLogPaths = [] } = {}) {
    if (closed) return { started: false, why: "daemon closing" };
    if (cc.enabled === false) return { started: false, why: "disabled" };
    if (!outcome || outcome.finalTick < 1) return { started: false, why: "empty run" };
    if (status.state === "running") {
      record(runId, { status: "skipped", reason: `crosscheck for ${status.runId} still running` });
      return { started: false, why: "already running" };
    }

    const question = cc.question ?? DEFAULT_QUESTION;
    const extract = buildExtract({
      runId,
      worldLogPath,
      outcome,
      clientLogPaths,
      maxExtractBytes: cc.maxExtractBytes,
    });

    if (!extract.ok) {
      // Refuse, never truncate (§3.3, test 6) — and report the size, so the
      // operator can rescope or raise the ceiling deliberately.
      const reason = `extract is ${extract.bytes} bytes, exceeding maxExtractBytes ${extract.maxExtractBytes}; refusing rather than truncating`;
      record(runId, { status: "failed", question, reason, extractBytes: extract.bytes });
      setStatus({ state: "failed", runId, reason, reportPath: null });
      return { started: false, why: "extract too large", bytes: extract.bytes };
    }

    const runDir = join(archive.root, runId);
    const reportsDir = join(runDir, "crosscheck");
    mkdirSync(reportsDir, { recursive: true });
    const extractPath = join(runDir, "extract.txt");
    writeFileSync(extractPath, extract.text);

    // The extract's size is reported before invoking (§3.3).
    record(runId, { status: "running", question, extractBytes: extract.bytes, extractPath });

    startedAtMs = Date.now();
    setStatus({ state: "running", runId, startedAt: new Date().toISOString(), reportPath: null, reason: null });

    // detached: the child leads its own process group, so timeout and
    // shutdown can kill the GROUP — same discipline as the client adapters.
    child = spawn(
      cc.cmd,
      [
        ...cc.args,
        "--file", extractPath,
        "--context", "a scoped extract of one simulated-world run: world events (reflections excluded), client-log windows around notable ticks, and a death summary",
        "--question", question,
        // The per-vendor timeout sits well inside the supervision ceiling:
        // a vendor that runs to its limit must still leave room for the
        // judge pass and the report write, so crosscheck files a labelled
        // fault instead of the whole group dying at the ceiling.
        "--timeout", String(Math.max(60, Math.floor((cc.timeoutMs / 1000) * 0.6))),
        "--reports-dir", reportsDir,
      ],
      { cwd: baseDir, detached: true, stdio: ["ignore", "ignore", "ignore"] }
    );
    child.unref();

    let timedOut = false;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup(); // §3.2: on timeout, terminate the group; never unbounded
    }, cc.timeoutMs);
    timeoutTimer.unref?.();

    child.on("error", (err) => {
      clearTimer();
      child = null;
      const reason = `spawn failed: ${err.message}`;
      record(runId, { status: "failed", question, reason });
      setStatus({ state: "failed", reason });
    });

    child.on("exit", (code) => {
      clearTimer();
      killGroup(); // reap stragglers even after a clean leader exit
      child = null;
      const elapsedMs = Date.now() - startedAtMs;
      if (timedOut) {
        record(runId, { status: "timed_out", question, timeoutMs: cc.timeoutMs, elapsedMs });
        setStatus({ state: "timed_out", elapsedMs, reason: `timed out after ${Math.round(cc.timeoutMs / 1000)}s` });
        return;
      }
      if (code !== 0) {
        // §3.2a: failure is non-fatal. The run record notes it and stands.
        const reason = `crosscheck exited ${code}`;
        record(runId, { status: "failed", question, reason, elapsedMs });
        setStatus({ state: "failed", elapsedMs, reason });
        return;
      }
      // Crosscheck writes <timestamp>-<slug>.json/.md into reportsDir; the
      // newest .json there is this run's report.
      const reports = existsSync(reportsDir)
        ? readdirSync(reportsDir).filter((f) => f.endsWith(".json") && !f.includes("retry")).sort()
        : [];
      const reportPath = reports.length > 0 ? join(reportsDir, reports[reports.length - 1]) : null;
      record(runId, { status: "done", question, reportPath, elapsedMs });
      setStatus({ state: "done", elapsedMs, reportPath, reason: null });
    });

    return { started: true, extractBytes: extract.bytes };
  }

  return {
    maybeStart,
    status: currentStatus,
    // §3.2 shutdown: if the daemon stops while a crosscheck runs, terminate
    // the group before exiting. Never outlive the daemon.
    shutdown() {
      closed = true;
      clearTimer();
      if (child) {
        killGroup();
        child = null;
        setStatus({ state: "failed", reason: "daemon shutdown" });
      }
    },
  };
}
