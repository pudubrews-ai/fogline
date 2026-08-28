// CLI entry, arg parsing, lifecycle (protocol v0.3 §13, client spec v0.3).
// First run:   node index.js                      (the model authors its own persona)
// Heir run:    node index.js --heir               (claims a matured body, authors from its heritage brief)
// Restarts:    node index.js                      (attaches, never re-registers)
// The identity file .fogline-identity-<label>.json is the sole persistence:
// server, agentId, token, registeredAt. --persona <file> is the escape hatch
// for reproducing a run with a pinned character.

import { readFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { computeBudgetMs, withBudget } from "./budget.js";
import { buildPrompt, selfBands } from "./prompt.js";
import { parseAction } from "./parse.js";
import { continueIntent } from "./cheap.js";
import { generatePersona, regenerateName } from "./persona.js";
import { Session } from "./session.js";
import { fileIdentityStore } from "./identity.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

// Adding a vendor is one config file and one line here. Nothing else moves.
// CLI vendors are config entries over adapters/subprocess.js (client spec §3).
const ADAPTERS = {
  claude: () => import("./adapters/claude.js"),
  "claude-code": () => import("./adapters/claude-code.js"),
  "claude-cli": () => import("./adapters/claude-cli.js"),
  "codex-cli": () => import("./adapters/codex-cli.js"),
  "kimi-cli": () => import("./adapters/kimi-cli.js"),
  "glm-cli": () => import("./adapters/glm-cli.js"),
  scripted: () => import("./adapters/scripted.js"),
  // Stub mode (client spec v0.9 §4) is the scripted adapter by another
  // name: zero model calls, full client path, correct envelope shape.
  stub: () => import("./adapters/scripted.js"),
};

// Model tiering (client spec §3.4): situation-based, not agent-based. Alone
// and travelling is a cheap model; in company, in trouble, or near a child
// is the good one. The client already holds everything needed to choose.
function pickModel(observation, scenario, config) {
  if (!config.tierBySituation) return config.richModel ?? null;
  const bands = selfBands(observation.self, scenario);
  const rich =
    (observation.present ?? []).length > 0 ||
    bands.sustenance !== "fed" ||
    bands.vitality !== "hale" ||
    observation.self.lastActionOutcome?.result === "failed" ||
    observation.reflectionRequested === true;
  return rich ? config.richModel ?? null : config.cheapModel ?? config.richModel ?? null;
}

// Builds the per-tick pipeline: cheap-or-escalate -> budget -> prompt ->
// model -> parse. Every fallback is an explicit wait; a tick is never
// silently missed and the model is never retried inside a tick.
//
// Decision state (process memory only, never persisted): the structured
// intent from the last parsed action, the previous tick's self bands, and
// the call counters the log reports every tick.
export function makeDecide({ complete, config, scenario = null, logRaw = () => {}, logPrompt = () => {}, onCounters = () => {} }) {
  const state = { intent: null, prevBands: null, prevPresent: null, demolishSeen: 0, faultEpisode: null };
  const counters = { ticks: 0, inference: 0, cheap: 0 };

  // Fault-episode logging (client spec v0.9 §3): run 8 logged the same
  // banner line 53 consecutive ticks while an agent starved, and the volume
  // is what buried it. One FULL entry per episode; repeats accumulate a
  // count that is written when the episode ends (a different fault, or a
  // successful call). The consecutive-fault alarm stays loud either way.
  const closeFaultEpisode = (tick) => {
    const ep = state.faultEpisode;
    if (ep && ep.count > 1) {
      logRaw(tick, `[model error] previous fault repeated ${ep.count} ticks (${ep.firstTick}–${ep.lastTick})`);
    }
    state.faultEpisode = null;
  };
  const logFault = (tick, message) => {
    const ep = state.faultEpisode;
    if (ep && ep.message === message) {
      ep.count += 1;
      ep.lastTick = tick;
      return;
    }
    closeFaultEpisode(tick);
    state.faultEpisode = { message, count: 1, firstTick: tick, lastTick: tick };
    logRaw(tick, `[model error] ${message}`);
  };

  const decide = async function decide(observation) {
    counters.ticks += 1;
    // Per-tick inference call count, reported to the daemon alongside the
    // action (client spec §5) so the operator stream can aggregate spend
    // per surface. Cheap ticks are free and report zero.
    let callsThisTick = 0;
    const bands = selfBands(observation.self, scenario);
    const countLine = (mode, detail) =>
      logRaw(
        observation.tick,
        `[calls] tick=${observation.tick} mode=${mode} (${detail}) totals: inference=${counters.inference} cheap=${counters.cheap} ticks=${counters.ticks}`
      );

    // clientStatus (client spec v0.6 §6): a typed enum beside `calls` —
    // ok | slow | adapter_fault | bad_output — replacing the practice of
    // flagging faults inside a wait's reason string for the observatory to
    // parse back out. The reason strings stay for the operator's eyes; the
    // enum is the contract.
    const waitWith = (reason, clientStatus) => ({
      type: "wait",
      coord: null,
      text: null,
      structure: null,
      target: null,
      resources: null,
      resource: null,
      intent: state.intent?.summary ?? observation.self.currentIntent ?? "",
      reason,
      reflections: null,
      clientStatus,
    });

    const finish = (action) => {
      state.prevBands = bands;
      // Notes-to-self for the demolish continuation (client spec §4.1): who
      // was here, and how far the progress here had reached, as of this tick.
      state.prevPresent = (observation.present ?? []).map((p) => p.agentId).sort().join(",");
      state.demolishSeen = observation.cell?.structure?.demolishProgress?.ticks ?? 0;
      action.calls = callsThisTick;
      action.clientStatus ??= "ok";
      // Consecutive-fault alarm (client spec v0.7 §3.3): run 8's agent
      // starved across 53 ticks of identical adapter faults, looking from
      // the world's side like someone who chose not to eat. clientStatus
      // already marks each fault for the roster; this makes the streak loud
      // on the console too.
      if (action.clientStatus === "adapter_fault") {
        state.consecutiveFaults = (state.consecutiveFaults ?? 0) + 1;
        if (state.consecutiveFaults >= (config.faultAlarmAfter ?? 3)) {
          console.error(
            `[ADAPTER ALARM] ${state.consecutiveFaults} consecutive adapter faults — ` +
              `this client is not reaching its model, and its agent is waiting every tick`
          );
        }
      } else {
        state.consecutiveFaults = 0;
      }
      onCounters(counters);
      return action;
    };

    // Cheap tick: continuation only, and only when nothing demands thought.
    if (config.cheapTicks) {
      const cheap = continueIntent(observation, state, scenario, config);
      if (cheap.mode === "cheap") {
        counters.cheap += 1;
        countLine("cheap", `${state.intent.kind}: ${state.intent.summary}`);
        return finish(cheap.action);
      }
      logRaw(observation.tick, `[escalate] ${cheap.reason}`);
    }

    counters.inference += 1;
    callsThisTick += 1;
    countLine("inference", config.cheapTicks ? "escalated" : "cheapTicks off");

    const budgetMs = computeBudgetMs(observation.deadline, config.budgetFactor);
    if (budgetMs <= 0) return finish(waitWith("no budget left on arrival", "slow"));

    const { system, user } = buildPrompt(observation, scenario);
    // Prompt logging (client spec v0.7.1 item 3), off by default: the
    // failed-attempt finding needed a live reproduction because run 10's
    // prompts were never on disk. Cheap ticks build no prompt to log.
    logPrompt(observation.tick, system, user);
    const model = pickModel(observation, scenario, config);
    let outcome;
    try {
      outcome = await withBudget(budgetMs, (signal) =>
        complete({ system, user, maxTokens: config.maxTokens, signal, ...(model ? { model } : {}) })
      );
    } catch (err) {
      logFault(observation.tick, err.message);
      // Fault classification (client spec §3.3): an adapter fault — bad
      // exit, auth text on stderr, silence without a timeout — is flagged in
      // the wait's reason so the roster can show adapter_fault instead of a
      // pensive agent. A slow call lands in the timedOut branch below.
      if (err.classification === "adapter_fault") {
        return finish(waitWith(`adapter_fault: ${err.message}`, "adapter_fault"));
      }
      return finish(waitWith(`model call failed: ${err.message}`, "adapter_fault"));
    }
    closeFaultEpisode(observation.tick);
    if (outcome.timedOut) return finish(waitWith("model call exceeded budget", "slow"));

    logRaw(observation.tick, outcome.result);
    const parsed = parseAction(outcome.result, observation, {
      inscriptionMax: scenario?.inscriptionMax,
      structureForms: scenario?.structureForms,
    });
    if (!parsed.ok) {
      logRaw(observation.tick, `[parse failure] ${parsed.error}`);
      return finish(waitWith("unparseable model output", "bad_output"));
    }
    // Missing metadata never sinks a valid action (client spec §2.1): the
    // intent defaults to the previous tick's; reason stays null.
    if (parsed.intentState) {
      state.intent = parsed.intentState;
    } else {
      parsed.action.intent = state.intent?.summary ?? observation.self.currentIntent ?? null;
    }
    return finish(parsed.action);
  };
  decide.counters = counters;
  return decide;
}

// The loud version-drift warning (client spec v0.7 §3.1): null when the pin
// holds, a warning string when it does not. Never fatal — the smoke test is
// what decides whether the client may take a slot.
export function versionDriftWarning(pin, cmd) {
  if (pin.matches) return null;
  return (
    `[VERSION PIN] ${cmd} reports ${pin.actual ?? "no version"} but ` +
    `${pin.pinned} is the confirmed-working pin (CLI-FINDINGS.md) — ` +
    `run 8 died on exactly this drift; re-confirm the invocation before trusting a long run`
  );
}

// Startup smoke test (client spec v0.7 §3.2): invoke the adapter once and
// confirm parseable output BEFORE taking a slot. The v0.5 work confirmed
// each invocation empirically and then nothing verified it still held at
// runtime — that gap is exactly where run 8's agent died. Throws on any
// fault, timeout, or unparseable output; the caller exits without
// registering.
export async function startupSmokeTest({ complete, budgetMs = 120000, log = () => {} }) {
  const started = Date.now();
  const { timedOut, result } = await withBudget(budgetMs, (signal) =>
    complete({
      system: "You are a connectivity probe. Output only JSON.",
      user: 'Reply with exactly this JSON and nothing else: {"ok":true}',
      maxTokens: 100,
      signal,
    })
  );
  if (timedOut) throw new Error(`smoke test: no response within ${budgetMs}ms`);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`smoke test: unparseable output: ${String(result).slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("smoke test: output parsed to a non-object");
  }
  const ms = Date.now() - started;
  log(`smoke test passed in ${ms}ms`);
  return { ms };
}

// Step 1 of every startup — also the WORLD_FULL / NOT_ATTACHABLE poll target.
async function fetchScenario(server) {
  const res = await fetch(`${server}/scenario`);
  if (!res.ok) throw new Error(`GET /scenario returned ${res.status}`);
  return res.json();
}

// Connect loop (protocol §13.4 and the claim-only amendment): persisted
// identity attaches (with takeover); --heir claims a matured body, polling
// until one exists; otherwise register, and on WORLD_FULL poll for either a
// freed slot or a claimable body — first come, first served, races lost to
// NOT_ATTACHABLE are normal and just mean keep polling.
export async function connectWithPolling({ session, server, scenario, config, heirOnly, makeHeirProvider, log }) {
  const basePollMs = config.pollIntervalMs ?? 5000;
  // Every wait re-rolls +/-20% jitter around the base. Two heir clients
  // idle-polling for the same matured body must not tick in lockstep — with
  // one fixed shared interval, whichever process launched first wins every
  // claim race, so a claim would be decided by launch order instead of
  // chance. Re-rolled per cycle, not once at startup: a single startup roll
  // would only shift the lockstep, not break it.
  const nextPollMs = () => Math.round(basePollMs * (0.8 + Math.random() * 0.4));
  let current = scenario;
  // Uncoded errors during connect — an adapter fault from the persona
  // generation complete() call (a CLI exiting 1 mid-registration), a dropped
  // POST — must not kill the client: the per-tick loop already survives the
  // same faults (client spec §12), and startup deserves the same resilience.
  // Logged every attempt and backed off exponentially, so a persistently
  // broken CLI is loud, not fatal and not a silent spin. Protocol-coded
  // errors (err.code set — BAD_TOKEN, VERSION_UNSUPPORTED, second-failure
  // NAME_TAKEN/INVALID_PERSONA) keep their meaning and still throw.
  let faultMs = basePollMs;
  const faultRetry = async (phase, err) => {
    const kind = err.classification === "adapter_fault" ? "adapter_fault" : "error";
    log(`${phase}: ${kind}: ${err.message} — retrying in ${faultMs}ms`);
    await sleep(faultMs);
    faultMs = Math.min(faultMs * 2, 60000);
  };
  for (;;) {
    // A persisted identity wins; NOT_ATTACHABLE means our body's old
    // connection still looks live to the daemon — poll, do not give up.
    if (session.identityStore.load()) {
      try {
        return await session.connect();
      } catch (err) {
        if (err.code === "NOT_ATTACHABLE") {
          const waitMs = nextPollMs();
          log(`attach: NOT_ATTACHABLE — body still shows a live client; retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        if (err.code) throw err;
        await faultRetry("attach", err);
        continue;
      }
    }

    // Heir path: claim the first attachable body, authoring from ITS brief.
    const attachable = current.attachable ?? [];
    if (attachable.length > 0 && (heirOnly || current.slots.used >= current.slots.total)) {
      const body = attachable[0];
      session.persona = null;
      session.personaProvider = makeHeirProvider(body, current);
      try {
        return await session.claim(body.agentId);
      } catch (err) {
        if (err.code === "NOT_ATTACHABLE") {
          log(`claim: lost the race for ${body.agentId} — normal; re-polling`);
        } else if (err.code) {
          throw err;
        } else {
          await faultRetry("claim", err);
        }
        current = await fetchScenario(server).catch(() => current);
        continue;
      }
    }

    if (!heirOnly && current.slots.used < current.slots.total) {
      try {
        return await session.connect(); // no identity -> register
      } catch (err) {
        if (err.code === "WORLD_FULL" && config.pollWhenFull) {
          log("register: WORLD_FULL — polling for a slot or a claimable body…");
        } else if (err.code) {
          throw err;
        } else {
          await faultRetry("register", err);
          current = await fetchScenario(server).catch(() => current);
          continue;
        }
      }
    } else if (heirOnly) {
      log(`waiting for a body to mature (attachable: ${attachable.length})…`);
    } else if (!config.pollWhenFull) {
      throw Object.assign(new Error("world is full and pollWhenFull is off"), { code: "WORLD_FULL" });
    }

    await sleep(nextPollMs());
    current = await fetchScenario(server).catch(() => current);
  }
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      persona: { type: "string" }, // escape hatch: pinned persona JSON file
      label: { type: "string" }, // instance name; identity file + clientName; defaults to config.clientName
      server: { type: "string" },
      adapter: { type: "string" },
      heir: { type: "boolean" }, // claim a matured body instead of registering
      stub: { type: "boolean" }, // stub mode (client spec v0.9 §4): zero model calls, full client path
      release: { type: "boolean" }, // attach, then release the agent and exit
      pollIntervalMs: { type: "string" }, // per-instance poll base (ms); wins over config.pollIntervalMs
    },
  });

  // The credential lives in .env, here and nowhere else in the system.
  try {
    process.loadEnvFile(join(baseDir, ".env"));
  } catch {
    // no .env — fine for the scripted adapter, or when the key is already set
  }

  const config = JSON.parse(readFileSync(join(baseDir, "config.json"), "utf8"));
  // Poll base precedence: --pollIntervalMs > config.pollIntervalMs > the
  // 5000ms default in connectWithPolling. Two heir instances launched with
  // different bases desynchronize their claim polls without needing
  // per-instance config files. Assigned onto this process's freshly parsed
  // copy of the config — config.json on disk is shared and never written.
  if (args.pollIntervalMs !== undefined) {
    const ms = Number(args.pollIntervalMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      console.error(`--pollIntervalMs must be a positive number of milliseconds (got "${args.pollIntervalMs}")`);
      process.exit(2);
    }
    config.pollIntervalMs = ms;
  }
  const server = (args.server ?? config.server).replace(/\/$/, "");
  // Stub mode (client spec v0.9 §4): no model call anywhere — the stub
  // adapter produces random-but-legal actions and canned speech through the
  // FULL client path (session, tick barrier, validation, submission), so a
  // fresh clone can produce a complete, Scry-renderable run with no
  // credentials and no subscription.
  const adapterName = args.stub ? "stub" : (args.adapter ?? config.adapter);
  const loadAdapter = ADAPTERS[adapterName];
  if (!loadAdapter) {
    console.error(`unknown adapter "${adapterName}" (have: ${Object.keys(ADAPTERS).join(", ")})`);
    process.exit(2);
  }
  const mod = await loadAdapter();
  // Subprocess-backed vendors take config.json "adapters" overrides on top
  // of their empirically-confirmed defaults; function adapters are used as
  // exported. budgetFactor is PER-ADAPTER (client spec §3.2): startup, auth,
  // and each CLI's own agentic loop vary enormously by vendor — a slower CLI
  // needs a longer leash, not a permanent `thinking` label.
  const adapterOverrides = config.adapters?.[adapterName] ?? {};
  const adapter = mod.create ? mod.create(adapterOverrides) : mod;
  const { complete } = adapter;
  config.budgetFactor =
    adapterOverrides.budgetFactor ?? adapter.budgetFactor ?? config.budgetFactor ?? 0.75;
  // Tier models are PER-ADAPTER for subprocess vendors: the global
  // cheapModel/richModel are Claude ids, and handing one to codex or kimi
  // via -m is a hard exit 1 on every call (confirmed live: "The
  // 'claude-sonnet-5' model is not supported when using Codex with a
  // ChatGPT account"). A vendor that declares no tier models runs every
  // call on its own default.
  if (mod.create) {
    config.cheapModel = adapter.config.cheapModel ?? adapter.config.model ?? null;
    config.richModel = adapter.config.richModel ?? adapter.config.model ?? null;
  }
  // The billing surface (client spec §4): vendor + account fingerprint,
  // never a credential. Declared at register/attach so concentration shows
  // on the roster, not on the invoice.
  const surface = typeof adapter.surface === "function" ? adapter.surface() : null;

  // CLI-backed vendors get the v0.7 startup hardening: the version-pin
  // check (loud, never fatal) and the smoke test (fatal — a client that
  // cannot produce a response must not take a slot).
  if (mod.create && adapter.config?.cmd) {
    const { checkVersionPin } = await import("./adapters/subprocess.js");
    const pin = await checkVersionPin(adapter.config);
    const drift = versionDriftWarning(pin, adapter.config.cmd);
    if (drift) console.error(drift);
    try {
      await startupSmokeTest({
        complete,
        budgetMs: config.smokeTestBudgetMs ?? 120000,
        log: (msg) => console.error(`[${args.label ?? config.clientName}] ${msg}`),
      });
    } catch (err) {
      console.error(`[${args.label ?? config.clientName}] ${err.message} — refusing to take a slot`);
      process.exit(1);
    }
  }

  const label = args.label ?? config.clientName;
  const identityPath = join(baseDir, `.fogline-identity-${label}.json`);
  // One-time migration from the pre-v0.2 location, so live agents keep their bodies.
  const oldPath = join(baseDir, ".identity", `${label}.json`);
  if (!existsSync(identityPath) && existsSync(oldPath)) renameSync(oldPath, identityPath);
  const identityStore = fileIdentityStore(identityPath, server);

  const logRaw = config.logRaw
    ? (tick, text) => appendFileSync(join(baseDir, `client-${label}.log`), `--- tick ${tick} ---\n${text}\n`)
    : () => {};
  // Prompt log (v0.7.1): a separate file so the .log format and everything
  // that reads it stay untouched. Off by default; "logPrompts": true in
  // config turns it on.
  const logPrompt = config.logPrompts
    ? (tick, system, user) =>
        appendFileSync(
          join(baseDir, `client-${label}.prompts.log`),
          `=== tick ${tick} ===\n--- system ---\n${system}\n--- user ---\n${user}\n`
        )
    : () => {};

  const scenario = await fetchScenario(server);

  // Persona precedence: --persona file, then config.persona, both verbatim —
  // otherwise the model authors its own at first registration.
  const pinnedPersona = args.persona ? JSON.parse(readFileSync(args.persona, "utf8")) : config.persona ?? null;
  const personaProvider = pinnedPersona
    ? { create: async () => pinnedPersona }
    : {
        create: () => generatePersona({ scenario, complete, logRaw }),
        renameOnCollision: (persona) => regenerateName({ persona, scenario, complete, logRaw }),
        regenerate: (detail) => {
          logRaw("persona-generation", `[daemon rejected persona] ${detail ?? "?"}`);
          return generatePersona({ scenario, complete, logRaw });
        },
      };

  // The heir provider authors from a specific body's heritage brief, and
  // omits appearance entirely — genotype is already fixed on the body.
  const makeHeirProvider = (body, currentScenario) => ({
    create: async () => {
      const { generateHeirPersona } = await import("./persona.js");
      return generateHeirPersona({ scenario: currentScenario, heritage: body.heritage, complete, logRaw });
    },
    renameOnCollision: (persona) => regenerateName({ persona, scenario: currentScenario, complete, logRaw }),
    regenerate: async (detail) => {
      logRaw("heir-persona", `[daemon rejected persona] ${detail ?? "?"}`);
      const { generateHeirPersona } = await import("./persona.js");
      return generateHeirPersona({ scenario: currentScenario, heritage: body.heritage, complete, logRaw });
    },
  });

  const decide = makeDecide({ complete, config, scenario, logRaw, logPrompt });
  const session = new Session({
    server,
    personaProvider,
    clientName: label,
    modelHint: adapterName === "claude" ? config.modelHint : adapter.config?.model ?? adapterName,
    surface,
    decide,
    identityStore,
  });

  const shutdown = async () => {
    const c = decide.counters;
    console.error(`\n[${label}] leaving… calls: ${c.inference} inference / ${c.cheap} cheap over ${c.ticks} ticks`);
    await session.leave();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const joined = await connectWithPolling({
    session,
    server,
    scenario,
    config,
    heirOnly: args.heir === true,
    makeHeirProvider,
    log: (msg) => console.error(`[${label}] ${msg}`),
  });

  if (args.release) {
    await session.release();
    console.error(`[${label}] released ${joined.agentId}; identity discarded`);
    process.exit(0);
  }
  const how =
    joined.mode === "register"
      ? `registered "${joined.name}" as ${joined.agentId}, spawned at ${joined.spawnCell}`
      : joined.mode === "claim"
        ? `claimed matured body ${joined.agentId} as "${joined.name}"`
        : `attached to ${joined.agentId}`;
  console.error(`[${label}] ${how} (${adapterName}) on ${server} — cheapTicks ${config.cheapTicks ? "ON" : "OFF"}`);
  const stopReason = await session.run();
  const c = decide.counters;
  console.error(`[${label}] stopped: ${stopReason} — calls: ${c.inference} inference / ${c.cheap} cheap over ${c.ticks} ticks`);
  process.exit(stopReason === "BAD_TOKEN" ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(pathToFileURL(process.argv[1]).href) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
