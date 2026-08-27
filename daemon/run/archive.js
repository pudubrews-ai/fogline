// The run archive (daemon spec v0.8 §2): flat files, indexed, no database.
// One directory per run keyed by runId — archive/<runId>/record.json — plus
// archive/index.json. The index is DERIVED: it must rebuild identically from
// the per-run records, so a corrupt or hand-edited index is recoverable.
//
// Written by the daemon, read by the observatory, reachable by no agent
// route (§2.4). It points at logs that carry every private objective and
// memory stream, so it inherits the operator-only rule of ticks.log.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ARCHIVE_DEFAULTS = {
  path: "./archive",
  // Client log paths (spec §2.1 "the client logs"): the daemon cannot
  // discover these — clients write logs on their own machines — so the
  // operator lists them. Empty is normal.
  clientLogs: [],
};

export const archiveConfig = (config) => ({ ...ARCHIVE_DEFAULTS, ...(config.archive ?? {}) });

// Deterministic serialization: the index must rebuild byte-identically, so
// nothing here may depend on filesystem enumeration order or clock reads.
const stable = (value) => JSON.stringify(value, null, 2) + "\n";

// One index entry, derived from a run record and nothing else (§2.2). A run
// whose outcome was never written — killed mid-flight — is an entry marked
// incomplete, not an omission (§2.3): an abandoned run is a fact worth keeping.
export function indexEntryFor(record) {
  const outcome = record.outcome ?? null;
  return {
    runId: record.runId,
    startedAt: record.startedAt ?? null,
    endedAt: outcome?.endedAt ?? null,
    complete: outcome !== null,
    configName: record.config?.configName ?? null,
    configHash: record.runStarted?.configHash ?? null,
    maxTicks: record.config?.maxTicks ?? null,
    finalTick: outcome?.finalTick ?? null,
    endedBy: outcome?.endedBy ?? null,
    survivors: outcome ? outcome.survivors.length : null,
    deaths: outcome ? outcome.deaths.length : null,
    structuresBuilt: outcome ? Object.values(outcome.structuresByForm).reduce((s, n) => s + n, 0) : null,
    inscriptions: outcome?.inscriptions?.length ?? null,
    viabilityRatio: record.boot?.viability?.ratio ?? null,
    capacity: record.boot?.viability?.capacity ?? null,
    deathsRequired: record.boot?.viability?.deathsRequired ?? null,
    crosscheck: record.crosscheck
      ? {
          status: record.crosscheck.status,
          reportPath: record.crosscheck.reportPath ?? null,
          question: record.crosscheck.question ?? null,
          vendorCount: record.crosscheck.vendorCount ?? null,
          anyFault: record.crosscheck.anyFault ?? null,
        }
      : null,
  };
}

export function createRunArchive(config, { baseDir = process.cwd() } = {}) {
  const ac = archiveConfig(config);
  const root = resolve(baseDir, ac.path);

  const recordPath = (runId) => join(root, runId, "record.json");

  function readRecord(runId) {
    const p = recordPath(runId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  function writeRecord(record) {
    const dir = join(root, record.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(recordPath(record.runId), stable(record));
  }

  // Scan every archive/<runId>/record.json and derive the index. Sorted by
  // startedAt then runId so the file is reproducible regardless of directory
  // enumeration order. Directories without a record.json (this archive
  // folder historically also held archived spec files) are not runs.
  function rebuildIndex() {
    const runs = [];
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!existsSync(join(dir, "record.json"))) continue;
        try {
          runs.push(indexEntryFor(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))));
        } catch {
          // An unreadable record is skipped, never guessed at; it stays on
          // disk for the operator, and a later rebuild picks it up if fixed.
        }
      }
    }
    runs.sort((a, b) => {
      const at = a.startedAt ?? "";
      const bt = b.startedAt ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      return a.runId < b.runId ? -1 : 1;
    });
    const index = { runs };
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.json"), stable(index));
    return index;
  }

  function readIndex() {
    const p = join(root, "index.json");
    if (!existsSync(p)) return rebuildIndex();
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return rebuildIndex(); // the index is derived; a corrupt one rebuilds
    }
  }

  return {
    root,
    config: ac,

    // §2.3, written at boot: config verbatim (name included when the panel
    // supplied one), boot figures, the run_started record, and log paths.
    writeBoot(runId, { config: runConfig, viability, constructionSlack, runStarted, logs }) {
      writeRecord({
        runId,
        startedAt: runStarted?.ts ?? new Date().toISOString(),
        config: runConfig,
        boot: {
          viability: viability ?? null,
          constructionSlack: constructionSlack ?? null,
        },
        runStarted: runStarted ?? null,
        logs: {
          ticks: logs?.ticks ?? null,
          world: logs?.world ?? null,
          barrier: logs?.barrier ?? null,
          clients: ac.clientLogs,
        },
        outcome: null,
        crosscheck: null,
      });
      rebuildIndex();
    },

    // §2.3, written when the run stops — maxTicks, reset, or operator stop.
    writeOutcome(runId, outcome) {
      const record = readRecord(runId);
      if (!record) return;
      record.outcome = outcome;
      writeRecord(record);
      rebuildIndex();
    },

    // §3.2a: the crosscheck result (or its failure) lands on the run record.
    // Failure is non-fatal and must not damage the rest of the record.
    setCrosscheck(runId, crosscheck) {
      const record = readRecord(runId);
      if (!record) return;
      record.crosscheck = crosscheck;
      writeRecord(record);
      rebuildIndex();
    },

    readRecord,
    readIndex,
    rebuildIndex,
  };
}
