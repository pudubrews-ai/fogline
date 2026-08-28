// Express wiring, route mounting, startup. No .env is read anywhere in this
// process — the daemon holds no model credentials, by design and by spec.
// The world boots empty: no seed files, no authored cast. Agents exist only
// by registration (daemon spec v0.2 §1, §8).

import { readFileSync, createWriteStream, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createWorld } from "./world/world.js";
import { resourcesConfig } from "./world/resources.js";
import { viabilityConfig, VIABILITY_DEFAULTS, viabilityFailureMessage } from "./world/viability.js";
import { loadDefinition, defaultDefinition } from "./world/definition.js";
import { TickEngine } from "./engine/tick.js";
import { createAuth } from "./api/auth.js";
import { createAgentRouter } from "./api/agent.js";
import { createOperatorRouter } from "./api/operator.js";
import { createRunArchive } from "./run/archive.js";
import { attachArchiveRecorder } from "./run/recorder.js";
import { createCrosscheckSupervisor } from "./run/crosscheck.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

// archive.clientLogs entries (v0.9 fix 6.2) resolve relative to the daemon
// directory and may use a single `*` in the FILENAME (client labels differ
// every run, and a config naming last run's labels silently loses the
// client-vs-world axis — which is exactly what happened to run 13). A
// pattern matching nothing contributes nothing; extract.js already skips
// paths that do not exist.
function expandClientLogs(entries) {
  const out = [];
  for (const entry of entries) {
    const full = join(baseDir, entry);
    const name = basename(full);
    if (!name.includes("*")) {
      out.push(full);
      continue;
    }
    const dir = dirname(full);
    if (!existsSync(dir)) continue;
    const re = new RegExp(`^${name.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    for (const f of readdirSync(dir).sort()) {
      if (re.test(f)) out.push(join(dir, f));
    }
  }
  return out;
}

export function createDaemon(configOverrides = {}, options = {}) {
  // An alternate config file (e.g. config.lean.json) can be named via
  // options.configFile — still plain JSON in this directory, never a .env.
  const configFile = options.configFile ?? "config.json";
  const config = {
    ...JSON.parse(readFileSync(join(baseDir, configFile), "utf8")),
    ...configOverrides,
  };

  let barrierLog = () => {};
  let worldLog = () => {};
  let tickLog = () => {};
  const logStreams = [];
  if (options.logs !== false) {
    const logDir = options.logDir ?? baseDir;
    const barrierStream = createWriteStream(join(logDir, "barrier.log"), { flags: "a" });
    const worldStream = createWriteStream(join(logDir, "world.log"), { flags: "a" });
    // The resolved-tick log: one consolidated line per tick, written from
    // tick 1 — every run is replay material even if it dies early.
    const ticksStream = createWriteStream(join(logDir, "ticks.log"), { flags: "a" });
    logStreams.push(barrierStream, worldStream, ticksStream);
    barrierLog = (line) => barrierStream.write(JSON.stringify(line) + "\n");
    worldLog = (line) => worldStream.write(JSON.stringify(line) + "\n");
    tickLog = (line) => ticksStream.write(JSON.stringify(line) + "\n");
  }

  // World selection (engine spec v0.9 §2). A config that names a `world`
  // definition file boots from it — grid, resources and roles, deposits,
  // recipes, forms, vitals, viability, premise, and enabled actions all come
  // from the definition. A config carrying the legacy v0.8 world keys
  // (gridSize/resources/vitals/viability) instead boots the legacy path,
  // exactly as before — unit tests and old presets keep their meaning.
  const legacyWorldConfig = config.gridSize != null || config.resources != null || config.vitals != null;
  const definition = !legacyWorldConfig
    ? loadDefinition(resolve(baseDir, config.world ?? "./worlds/orrum-5.json"))
    : null;
  // Viability targets belong to the definition (engine spec v0.9 §2.1); an
  // explicit config.viability block still layers on top as the operator's
  // boot-time override — exactly the v0.8 tuning surface, preserved.
  const vc = definition
    ? { ...VIABILITY_DEFAULTS, ...definition.viability, ...(config.viability ?? {}) }
    : viabilityConfig(config);
  const lineageCfg = {
    ...(config.maturityTicks != null ? { maturityTicks: config.maturityTicks } : {}),
    ...(config.begetVitalityCost != null ? { begetVitalityCost: config.begetVitalityCost } : {}),
    ...(config.begetResourceCost != null ? { begetResourceCost: config.begetResourceCost } : {}),
  };
  // Ratio-path seeding (daemon spec §2.4, demand over expectedAgents per
  // v0.6 A5): the consumable is seeded to viability.targetRatio.
  const seeding = {
    ...vc,
    maxTicks: config.maxTicks,
    expectedAgents: config.expectedAgents ?? config.minAgents ?? 2,
  };
  const engine = new TickEngine({
    worldFactory: () =>
      definition
        ? createWorld({
            definition,
            slots: config.slots,
            genotype: config.genotype ?? {},
            lineage: lineageCfg,
            destruction: config.destruction ?? {},
            carryLimit: config.carryLimit,
            inscriptionMax: config.inscriptionMax ?? 500,
            seeding,
          })
        : createWorld({
            defaults: defaultDefinition(),
            gridSize: config.gridSize,
            slots: config.slots,
            resources: resourcesConfig(config),
            vitals: config.vitals ?? {},
            genotype: config.genotype ?? {},
            lineage: lineageCfg,
            destruction: config.destruction ?? {},
            carryLimit: config.carryLimit,
            inscriptionMax: config.inscriptionMax ?? 500,
            seeding,
          }),
    config,
    barrierLog,
    worldLog,
    tickLog,
  });
  // The viability floor (protocol §6.3, daemon spec §2.3): a world that
  // mathematically cannot sustain its population is a configuration error
  // and refuses to boot, exactly as gridSize < 2 does. The engine computed
  // the arithmetic at _beginRun; the refusal happens here, before listen.
  if (engine.viability.ratio < vc.viabilityFloor) {
    engine.dispose();
    throw new Error(viabilityFailureMessage(engine.viability, vc.viabilityFloor, engine.world));
  }

  const auth = createAuth(config);
  engine.on("reset", () => auth.revokeAllAgentTokens());

  // The run archive (daemon spec v0.8 §2): written by the daemon, read by the
  // observatory over the operator realm, reachable by no agent route. The
  // recorder folds the operator stream; the supervisor owns the post-run
  // crosscheck — which authenticates via its OWN CLI OAuth, exactly as an
  // agent client does. The daemon still holds no key.
  const logDir = options.logDir ?? baseDir;
  // Archiving follows logging: a logless boot (unit tests, ephemeral worlds)
  // records no runs and can never spawn a crosscheck — unless the caller
  // asked for archiving explicitly by supplying either config block.
  const archiveEnabled =
    options.logs !== false || "archive" in configOverrides || "crosscheck" in configOverrides;
  const archive = archiveEnabled
    ? createRunArchive(config, { baseDir: logDir })
    : {
        root: null,
        config: { clientLogs: [] },
        writeBoot() {}, writeOutcome() {}, setCrosscheck() {},
        readRecord: () => null,
        readIndex: () => ({ runs: [] }),
        rebuildIndex: () => ({ runs: [] }),
      };
  const crosscheck = createCrosscheckSupervisor({
    config,
    archive,
    baseDir,
    onStatus: (status) => engine.emitOperator("crosscheck", status),
  });
  const recorder = archiveEnabled
    ? attachArchiveRecorder({
        engine,
        archive,
        config,
        logs:
          options.logs !== false
            ? {
                ticks: join(logDir, "ticks.log"),
                world: join(logDir, "world.log"),
                barrier: join(logDir, "barrier.log"),
              }
            : {},
        onRunStopped: (runId, outcome) => {
          // §3.2: automatic, supervised, non-blocking. The daemon keeps serving.
          crosscheck.maybeStart(runId, outcome, {
            worldLogPath: options.logs !== false ? join(logDir, "world.log") : null,
            clientLogPaths: expandClientLogs(archive.config.clientLogs ?? []),
          });
        },
      })
    : { finalizeOpenRun() {} };

  const app = express();
  // Agent realm first (it terminates /scenario, /register, /attach, /agent/*),
  // then the operator realm, then static. Two realms, two route trees.
  app.use(createAgentRouter({ engine, auth, config }));
  app.use(createOperatorRouter({ engine, auth, config, archive, crosscheck }));
  app.use(express.static(join(baseDir, "public")));

  let httpServer = null;
  return {
    app,
    engine,
    auth,
    config,
    archive,
    crosscheck,
    listen(port = config.port) {
      httpServer = app.listen(port);
      // Explicit connection timeouts (daemon spec v0.6 §7): run 7 dropped
      // SSE streams roughly once every seven ~1-minute ticks — the shape of
      // a default idle timeout, not of client behavior. Set both rather
      // than relying on Node defaults; headersTimeout must exceed
      // keepAliveTimeout or keep-alive sockets die mid-handshake.
      httpServer.keepAliveTimeout = config.keepAliveTimeoutMs ?? 120000;
      httpServer.headersTimeout = (config.keepAliveTimeoutMs ?? 120000) + 5000;
      engine.start();
      return httpServer;
    },
    async close() {
      // A crosscheck must never outlive the daemon that started it (§3.2),
      // and an orderly stop records what the open run has so far (§2.3).
      crosscheck.shutdown();
      recorder.finalizeOpenRun("shutdown");
      engine.dispose();
      // Flush the logs to disk before reporting closed — replay tooling may
      // open ticks.log the moment this resolves.
      await Promise.all(
        logStreams.map((s) => new Promise((resolve) => s.end(resolve)))
      );
      return new Promise((resolve) => {
        if (!httpServer) return resolve();
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `node server.js` uses config.json; `node server.js config.lean.json`
  // boots the lean preset (daemon spec §5.1).
  const daemon = createDaemon({}, process.argv[2] ? { configFile: process.argv[2] } : {});
  daemon.listen();
  const bootedWorld = daemon.engine.world;
  console.log(
    `fogline-daemon listening on http://localhost:${daemon.config.port} ` +
      `(${bootedWorld.name ?? "legacy config world"}, ${bootedWorld.width}x${bootedWorld.height} grid, ${daemon.config.slots} slots, ` +
      `${daemon.config.startPaused ? "paused — press play in Scry" : "running"})`
  );
  const via = daemon.engine.viability;
  console.log(
    `viability: ratio ${via.ratio.toFixed(2)} (supply ${via.supply.toFixed(1)} / demand ${via.demand.toFixed(1)} ` +
      `over ${via.expectedAgents} expected agents, ${via.slots} slots), ` +
      `carrying capacity ${via.capacity.toFixed(2)} agents, ` +
      `optimal-play baseline ${via.optimalSurvivors.toFixed(1)} survivors ` +
      `(${via.seededSivet} seeded ${bootedWorld.consumable.name} across ${via.sivetSprings} springs)`
  );
  // The capacity headline (v0.7 A3): a lethal world boots, but it boots
  // announced. Run 10's two structurally required deaths were discovered in
  // the postmortem; this line is where they are discovered now.
  console.log(
    `capacity margin: ${via.capacityMargin >= 0 ? "+" : ""}${via.capacityMargin.toFixed(2)} agents ` +
      `(capacity ${via.capacity.toFixed(2)} − ${via.expectedAgents} expected)` +
      (via.deathsRequired > 0
        ? ` — THIS WORLD CANNOT SUSTAIN ITS POPULATION: ${via.deathsRequired} death${via.deathsRequired === 1 ? "" : "s"} structurally required`
        : " — the expected population is sustainable indefinitely")
  );
  const slack = daemon.engine.constructionSlack;
  console.log(
    `construction slack: ${slack.slack.toFixed(2)} ` +
      `(build supply ${slack.buildSupply.toFixed(1)} / demand ${slack.buildDemand.toFixed(1)}, ` +
      `travel factor ${slack.travelFactor.toFixed(2)})` +
      (slack.slack < 1 ? " — building is NOT affordable for the expected population" : "")
  );
}
