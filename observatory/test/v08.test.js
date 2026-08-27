// v0.8 gates (observatory spec v0.8 §7): the analyst's structural
// read-only-ness, the config preview's fidelity to the daemon arithmetic,
// the recipe-free bundle, tab identity, the crosscheck page, and the ticker.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReadUrl, createReadonlyClient, READONLY_KINDS } from "../src/analyst/readonly.js";
import { buildContext, summarizeArchive } from "../src/analyst/retrieve.js";
import { shouldConsult, createWatch } from "../src/analyst/watch.js";
import {
  buildPreviewWorld,
  computeViability as portViability,
  computeConstructionSlack as portSlack,
  mulberry32,
  previewConfig,
} from "../src/config/viability.js";
import { canCommit, diffConfigs, commitPayload, EXPOSED_FIELDS } from "../src/config/panel.js";
import { tabTitle } from "../src/tabtitle.js";
import { renderCrosscheckReport } from "../src/crosscheck/render.js";
import { createTicker, phrase, isNotable, itemsAroundTick } from "../src/ticker.js";

const obsDir = dirname(dirname(fileURLToPath(import.meta.url)));

// The daemon's own modules, imported BY THE TEST ONLY (node-side): the
// fixture oracle for the port. Never imported by anything under src/.
import { createWorld } from "../../daemon/world/world.js";
import { resourcesConfig as daemonResources } from "../../daemon/world/resources.js";
import {
  computeViability as daemonViability,
  computeConstructionSlack as daemonSlack,
  viabilityConfig as daemonViabilityConfig,
} from "../../daemon/world/viability.js";

// ---------- 1. analyst is read-only, structurally ----------

test("GATE analyst read-only: its client cannot construct a request to /control, /spark, or any config path", async () => {
  // Every constructible URL, including with hostile parameters, is a read
  // path under /observatory/. "../control" et al arrive percent-encoded — a
  // runId-shaped string, never a path segment.
  const hostile = ["../control", "/control", "..%2Fcontrol", "r_1/../../control", "spark", "config.json", "a?path=/control"];
  for (const kind of READONLY_KINDS) {
    for (const param of hostile) {
      const url = buildReadUrl(kind, param);
      assert.ok(url.startsWith("/observatory/"), `${kind} stays under /observatory/: ${url}`);
      assert.ok(!/^\/(control|spark)/.test(url), `${kind}(${param}) is not a control route`);
      // The route is decided by the first two segments, and both are out of
      // the parameter's reach: segment one is always "observatory", segment
      // two always comes from the frozen route table. A hostile parameter
      // ("spark", "../control") lands percent-encoded in a LATER segment —
      // data to the daemon's router, never a route.
      const segments = url.split("?")[0].split("/");
      assert.equal(segments[1], "observatory", `${kind}(${param}) routes into the operator read realm`);
      assert.ok(["snapshot", "agent", "archive"].includes(segments[2]), `${kind}(${param}) uses a whitelisted read route: ${url}`);
      // And no unencoded traversal segment survives to rewrite the prefix.
      assert.ok(!segments.some((seg) => seg === ".."), `${kind}(${param}) cannot traverse: ${url}`);
    }
  }
  // Unknown kinds throw rather than pass anything through.
  assert.throws(() => buildReadUrl("control"), /no read route/);
  assert.throws(() => buildReadUrl("post"), /no read route/);
  // Every request the client issues is a GET; the module has no other verb.
  const calls = [];
  const client = createReadonlyClient("http://x", async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  });
  await client.snapshot();
  await client.archiveIndex();
  await client.archiveRecord("r_1");
  for (const c of calls) assert.equal(c.opts.method, "GET");
  const source = readFileSync(join(obsDir, "src/analyst/readonly.js"), "utf8");
  assert.ok(!/POST|PUT|DELETE|PATCH/.test(source), "no write verb exists in the module source");
  // And the analyst's client surface has no generic request method.
  assert.deepEqual(
    Object.keys(client).sort(),
    ["agent", "archiveIndex", "archiveRecord", "crosscheckReport", "kinds", "snapshot"].sort()
  );
});

// ---------- 2. analyst reads the archive from summaries ----------

test("GATE analyst archive reads: a cross-run question resolves against indexed summaries without opening a ticks.log", () => {
  const index = {
    runs: [
      { runId: "r_10", complete: true, finalTick: 450, endedBy: "max_ticks", survivors: 10, deaths: 2, structuresBuilt: 7, inscriptions: 12, viabilityRatio: 1.349, capacity: 10.0, deathsRequired: 2, configName: "run-10", crosscheck: null },
      { runId: "r_11", complete: true, finalTick: 250, endedBy: "max_ticks", survivors: 5, deaths: 8, structuresBuilt: 3, inscriptions: 4, viabilityRatio: 1.35, capacity: 13.5, deathsRequired: 0, configName: null, crosscheck: { status: "done" } },
    ],
  };
  const context = buildContext("which runs had capacity below population?", { state: null, index });
  assert.match(context, /r_10/);
  assert.match(context, /capacity 10\.00, 2 deaths required/);
  assert.match(context, /r_11/);
  assert.match(context, /crosscheck done/);
  // Structural half: the retrieval module cannot open a log — it takes data,
  // never a client, and its source names no log file and no fetch.
  const source = readFileSync(join(obsDir, "src/analyst/retrieve.js"), "utf8");
  assert.ok(!/fetch\(|readFileSync|archiveRecord\(/.test(source), "retrieve.js reads folded data only — no fetch, no file, no record open");
  assert.match(summarizeArchive(index), /INCOMPLETE|survivors/, "summaries alone are the archive answer");
});

// ---------- 3. watch mode rides situationChanged ----------

test("GATE watch rides situationChanged: across a scripted static stretch, no analyst call is made", async () => {
  let calls = 0;
  const watch = createWatch({
    ask: async () => {
      calls += 1;
      return "finding";
    },
    buildPrompt: (r) => `tick ${r.tick}`,
  });
  // Fifty ticks where nothing changed for anyone: moves and gathers only,
  // every situationChanged false.
  for (let t = 1; t <= 50; t++) {
    const record = {
      tick: t,
      situations: [
        { agentId: "a_1", changed: false },
        { agentId: "a_2", changed: false },
      ],
      events: [{ type: "move", tick: t }, { type: "gather", tick: t }],
    };
    assert.equal(shouldConsult(record), false, `tick ${t} is static`);
    await watch.onTick(record);
  }
  assert.equal(calls, 0, "a static stretch costs zero model calls");
  // One changed tick consults exactly once.
  await watch.onTick({ tick: 51, situations: [{ agentId: "a_1", changed: true }], events: [] });
  assert.equal(calls, 1);
  // A notable event consults even when the flags are quiet (a raze in an
  // empty corner changed nobody's situation — the operator still cares).
  await watch.onTick({ tick: 52, situations: [], events: [{ type: "death", tick: 52, agentId: "a_2" }] });
  assert.equal(calls, 2);
});

// ---------- 4. config preview matches the daemon ----------

test("GATE preview fidelity: the ported arithmetic and viability.js produce identical figures on a fixture set", () => {
  const FIXTURES = [
    { gridSize: 8, slots: 13, expectedAgents: 13, maxTicks: 250, viability: { targetRatio: 1.35, viabilityFloor: 1.0, minSpringsPerResource: 2 }, resources: { seedDensity: 0.12, quantityRange: [10, 20], regenPerTick: 0.15, distribution: "clustered" }, vitals: { sustenanceMax: 100, sustenanceDecayPerTick: 3, sivetRestores: 25, vitalityMax: 100, starvationDamagePerTick: 3, regenThreshold: 50, regenPerTick: 1, attackDamage: 25, attackCost: 6, sponsorDrainPerTick: 1, orphanDamagePerTick: 8 } },
    { gridSize: 6, slots: 12, expectedAgents: 12, maxTicks: 450, viability: { targetRatio: 1.35, viabilityFloor: 1.0, minSpringsPerResource: 2 }, resources: { seedDensity: 0.2, quantityRange: [4, 12], regenPerTick: 0.05, distribution: "clustered" }, vitals: { sustenanceMax: 100, sustenanceDecayPerTick: 2, sivetRestores: 25, vitalityMax: 100, starvationDamagePerTick: 3, regenThreshold: 50, regenPerTick: 1, attackDamage: 25, attackCost: 6, sponsorDrainPerTick: 1, orphanDamagePerTick: 4 } },
    { gridSize: 4, slots: 5, expectedAgents: 3, maxTicks: 60, viability: { targetRatio: 1.5, viabilityFloor: 1.0, minSpringsPerResource: 2 }, resources: { seedDensity: 0.35, quantityRange: [4, 12], regenPerTick: 0.05, distribution: "scattered" }, vitals: { sustenanceMax: 100, sustenanceDecayPerTick: 1, sivetRestores: 25, vitalityMax: 100, starvationDamagePerTick: 3, regenThreshold: 50, regenPerTick: 1, attackDamage: 25, attackCost: 6, sponsorDrainPerTick: 1, orphanDamagePerTick: 4 } },
  ];
  const TYPICAL_COST = 5.5; // fixture aggregate; the real one arrives at runtime
  for (const [i, config] of FIXTURES.entries()) {
    const expectedAgents = config.expectedAgents;
    // Same PRNG stream on both sides -> the same seeded world.
    const daemonWorld = createWorld({
      gridSize: config.gridSize,
      slots: config.slots,
      resources: daemonResources(config),
      vitals: config.vitals,
      seeding: { ...daemonViabilityConfig(config), maxTicks: config.maxTicks, expectedAgents },
      rng: mulberry32(42 + i),
    });
    const portWorld = buildPreviewWorld(config, mulberry32(42 + i));
    const a = daemonViability(daemonWorld, config.maxTicks, expectedAgents);
    const b = portViability(portWorld, config.maxTicks, expectedAgents);
    assert.deepEqual(b, a, `fixture ${i}: ratio, capacity, deaths-required and the rest are identical`);
    const sa = daemonSlack(daemonWorld, config.maxTicks, expectedAgents, TYPICAL_COST);
    const sb = portSlack(portWorld, config.maxTicks, expectedAgents, TYPICAL_COST);
    assert.deepEqual(sb, sa, `fixture ${i}: construction slack is identical`);
    // And the port run over the DAEMON's world object agrees with the
    // daemon's own function — same arithmetic, not merely same answer.
    assert.deepEqual(portViability(daemonWorld, config.maxTicks, expectedAgents), a);
    // The preview surfaces deaths required — run 10's silent two.
    const preview = previewConfig(config, { typicalStructureCost: TYPICAL_COST });
    assert.equal(preview.viability.deathsRequired, a.deathsRequired);
    assert.equal(typeof preview.slack.median, "number");
  }
});

// ---------- 5. config is frozen at tick 1 ----------

test("GATE config frozen: the panel refuses to commit once a run has opened tick 1", () => {
  assert.equal(canCommit(null).ok, true, "no run loaded: commit is open");
  assert.equal(canCommit({ runId: "r_1", tick: 0 }).ok, true, "booted, tick 1 not yet open");
  const frozen = canCommit({ runId: "r_1", tick: 1 });
  assert.equal(frozen.ok, false, "tick 1 opened: frozen");
  assert.match(frozen.why, /frozen/);
  assert.equal(canCommit({ runId: "r_1", tick: 247 }).ok, false, "still frozen mid-run");
  // The commit artifact carries the name; unexposed keys ride through.
  const payload = commitPayload({ gridSize: 8, retrievalK: 8, vitals: { sustenanceMax: 100 } }, "run twelve");
  assert.equal(payload.config.configName, "run twelve");
  assert.equal(payload.config.retrievalK, 8, "unexposed keys pass through untouched");
  assert.equal(payload.filename, "fishbowl-config-run-twelve.json");
  const diff = diffConfigs({ gridSize: 8, vitals: { sustenanceMax: 100 } }, { gridSize: 10, vitals: { sustenanceMax: 100 } });
  assert.deepEqual(diff, [{ path: "gridSize", from: 8, to: 10 }]);
});

// ---------- 6. recipes are absent from the bundle ----------

test("GATE recipes absent: grep the built observatory bundle for any material cost or recipe key — zero hits", () => {
  // The panel is the first UI in this project that edits world config;
  // recipes.js reaching the bundle at all, even unreferenced, is one
  // careless import from being editable between runs.
  execSync("npx vite build", { cwd: obsDir, stdio: "pipe" });
  const assetsDir = join(obsDir, "dist", "assets");
  assert.ok(existsSync(assetsDir), "vite build produced assets");
  let bundle = "";
  for (const f of readdirSync(assetsDir)) {
    if (f.endsWith(".js")) bundle += readFileSync(join(assetsDir, f), "utf8");
  }
  assert.ok(bundle.length > 0, "bundle read");
  for (const key of ["RECIPES", "recipeFor", "buildPlan", "consumeMaterials", "formatShortfall", "typicalStructureCost()"]) {
    assert.ok(!bundle.includes(key), `bundle contains recipe identifier "${key}"`);
  }
  // Cost-shaped literals: a material name keyed to a SMALL integer is a
  // recipe row (costs are 1-2 digits). theme.js's palette keys the same
  // names to 24-bit color ints, which is a color, not a cost.
  for (const re of [/\borrum\s*:\s*\d{1,2}\b/, /\bkhal\s*:\s*\d{1,2}\b/, /["']orrum["']\s*:\s*\d{1,2}\b/, /["']khal["']\s*:\s*\d{1,2}\b/]) {
    assert.equal(bundle.match(re), null, `bundle contains a cost-shaped literal ${re}`);
  }
  // The EXPOSED whitelist never names a recipe path either.
  for (const f of EXPOSED_FIELDS) assert.ok(!/recipe|orrum|khal/i.test(f.path), `exposed field ${f.path}`);
});

// ---------- 7. tab title ----------

test("GATE tab title: run id, tick, and population, reflecting paused, waiting, and stopped", () => {
  const state = { runId: "run11", tick: 247, agents: new Map([["a", {}], ["b", {}], ["c", {}], ["d", {}], ["e", {}]]), slots: { total: 13 } };
  assert.equal(tabTitle(state, {}), "run11 · t247 · 5/13");
  assert.equal(tabTitle(state, { paused: true }), "run11 · t247 · 5/13 · paused");
  assert.equal(tabTitle(state, { waitingForAgents: true }), "run11 · t247 · 5/13 · waiting");
  assert.equal(tabTitle(state, { stopped: true }), "run11 · t247 · 5/13 · stopped");
  // Stopped outranks paused: a stopped world quietly holding is the thing
  // worth noticing from another window.
  assert.equal(tabTitle(state, { stopped: true, paused: true }), "run11 · t247 · 5/13 · stopped");
  assert.equal(tabTitle(null, {}), "Fishbowl Observatory");
});

// ---------- crosscheck report fixtures ----------

const REPORT = {
  crosscheck: "0.1",
  timestamp: "2026-08-26T08:46:21Z",
  invocation: {
    files: [{ name: "extract.txt", bytes: 210000 }],
    context: "a scoped extract",
    question: "Do these logs tell a consistent story?",
    judge: "claude",
    timeoutMs: 900000,
  },
  vendors: {
    claude: { status: "ok", latencyMs: 100842, fault: null, evaluation: { summary: "Consistent.", findings: ["The build at 4,5 appears in both."], confidence: "high", concerns: [] }, raw: "{}" },
    gpt: { status: "ok", latencyMs: 204354, fault: null, evaluation: { summary: "Consistent overall.", findings: ["Tick 230 divergence."], confidence: "medium", concerns: [] }, raw: "{}" },
    kimi: { status: "ok", latencyMs: 778188, fault: null, evaluation: { summary: "Same run.", findings: ["Give outcomes unlogged."], confidence: "medium", concerns: [] }, raw: "{}" },
    glm: { status: "timeout", latencyMs: 900004, fault: "timed out after 900s", evaluation: null, raw: null },
  },
  correlation: {
    status: "ok",
    judge: "claude",
    judgeIsParticipant: true,
    latencyMs: 30000,
    fault: null,
    result: {
      agreements: [{ claim: "The two logs describe the same run.", vendors: ["claude", "gpt", "kimi"] }],
      disagreements: [
        { topic: "Whether unlogged gives are a daemon bug", positions: [{ vendor: "claude", said: "a daemon-side logging gap" }, { vendor: "gpt", said: "in-world behaviour" }] },
      ],
      unique: [{ vendor: "kimi", finding: "A tick-230 client stop.", note: "not raised by anyone else" }],
    },
  },
};

// ---------- 8. the page renders from the file alone ----------

test("GATE crosscheck page from file alone: a report JSON with no daemon and no run loaded produces a complete page, disagreements first", () => {
  const html = renderCrosscheckReport(structuredClone(REPORT));
  assert.match(html, /Do these logs tell a consistent story\?/, "the invocation is always visible");
  assert.match(html, /extract\.txt \(205KB\)/, "files with sizes");
  const dis = html.indexOf("Disagreements");
  const agr = html.indexOf("Agreements");
  const uni = html.indexOf("Unique findings");
  assert.ok(dis > -1 && agr > -1 && uni > -1, "all three sections render");
  assert.ok(dis < agr && agr < uni, "disagreements FIRST, then agreements, then unique");
  assert.match(html, /daemon-side logging gap/, "positions render");
  assert.match(html, /a participant — bias risk named/, "the judge's participation is named");
  assert.match(html, /raw response/, "raw per-vendor responses present, collapsed");
  // Pure function of the JSON: no reducer, no fetch, no live state.
  const source = readFileSync(join(obsDir, "src/crosscheck/render.js"), "utf8");
  assert.ok(!/fetch\(|from "\.\.\/source|stateAtTick|applyTick/.test(source), "render.js depends on the report alone");
});

// ---------- 9. faults render as faults ----------

test("GATE faults visible: a report where one vendor timed out renders four vendor slots, one labelled as a fault with its latency — never three", () => {
  const html = renderCrosscheckReport(structuredClone(REPORT));
  const slots = html.match(/data-vendor="/g) ?? [];
  assert.equal(slots.length, 4, "four slots for four vendors");
  assert.match(html, /data-vendor="glm"/, "the faulted vendor has a slot");
  assert.match(html, /FAULT<\/span> timed out after 900s · 900s/, "labelled fault with latency");
  assert.match(html, /a fault, not an absence/, "the slot says what it is");
});

// ---------- 10. the ticker recycles ----------

test("GATE ticker recycles: across a stretch with no notable events the ticker cycles prior items and never goes blank", () => {
  const ticker = createTicker({ minReleaseMs: 100, recycleWindow: 5 });
  ticker.push(["Mara Flint inscribed First Storehouse.", "Cotter Bramwell died at 4,6."]);
  let t = 0;
  const first = ticker.next((t += 100));
  const second = ticker.next((t += 100));
  assert.equal(first.recycled, false);
  assert.equal(second.recycled, false);
  // A long quiet stretch: every release is a real prior item, recycled.
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const item = ticker.next((t += 100));
    assert.ok(item, "never blank once anything has happened");
    assert.equal(item.recycled, true, "quiet stretches recycle rather than invent");
    seen.add(item.text);
  }
  assert.deepEqual([...seen].sort(), [first.text, second.text].sort(), "only real items recirculate — no filler, no placeholder");
  // The truly-empty ticker (nothing has EVER happened) is the only silence.
  const empty = createTicker({ minReleaseMs: 100 });
  assert.equal(empty.next(1000), null);
});

// ---------- 11. the ticker paces ----------

test("GATE ticker paces: six notable events in one tick release at a capped rate rather than instantly", () => {
  const ticker = createTicker({ minReleaseMs: 2500 });
  ticker.push(["a.", "b.", "c.", "d.", "e.", "f."]);
  assert.ok(ticker.next(10000), "first release");
  assert.equal(ticker.next(10001), null, "the second is held");
  assert.equal(ticker.next(12000), null, "still held under the cap");
  assert.ok(ticker.next(12600), "released after the interval");
  assert.equal(ticker.pending(), 4, "the ticker is allowed to fall behind the world");
});

// ---------- 12. the ticker in replay ----------

test("GATE ticker in replay: seeking to an arbitrary tick shows the events notable around that tick", () => {
  const mkState = { agents: new Map(), personas: new Map(), departed: new Map(), cells: new Map() };
  const events = [
    { type: "build", tick: 10, agentId: "a_1", coord: "1,1", structure: { name: "Early Hut" }, form: "hut" },
    { type: "gather", tick: 399, agentId: "a_1", coord: "2,2" },
    { type: "death", tick: 398, agentId: "a_2", name: "Cotter Bramwell", coord: "4,6" },
    { type: "inscribe", tick: 402, agentId: "a_3", authorName: "Mara Flint", coord: "3,3" },
  ];
  const at400 = itemsAroundTick(events, 400, mkState);
  assert.deepEqual(at400, ["Cotter Bramwell died at 4,6."], "the death near 400, not the build at 10, not the gather");
  const at402 = itemsAroundTick(events, 402, mkState);
  assert.ok(at402.some((s) => s.includes("inscribed")), "seeking forward picks up the inscription");
  // A quiet window falls back to the most recent notable events — the
  // recycle rule applied to seeking. Never blank mid-run.
  const at300 = itemsAroundTick(events, 300, mkState);
  assert.deepEqual(at300, ["a_1 built Early Hut at 1,1."], "quiet window shows the last real thing that happened");
});

// ---------- 13. ticker phrasing ----------

test("GATE ticker phrasing: flat sentences, no evaluative or motive language — asserted against the client prompts' wordlists", () => {
  const state = {
    agents: new Map([["a_1", { name: "Mara Flint" }], ["a_2", { name: "Cotter Bramwell" }]]),
    personas: new Map(),
    departed: new Map(),
    cells: new Map([["3,3", { structure: { authored: { name: "First Storehouse" } } }]]),
  };
  const samples = [
    phrase({ type: "build", agentId: "a_1", coord: "4,5", structure: { name: "Cray's Footing" }, form: "platform" }, state),
    phrase({ type: "inscribe", agentId: "a_1", authorName: "Mara Flint", coord: "3,3" }, state),
    phrase({ type: "death", agentId: "a_2", name: "Cotter Bramwell", coord: "4,6" }, state),
    phrase({ type: "raze", agentId: "a_1", coord: "2,2", name: "The Fifth Course", form: "hut" }, state),
    phrase({ type: "demolish_complete", agentId: "a_2", coord: "1,1", name: "Old Wall", form: "wall" }, state),
    phrase({ type: "beget", agentId: "a_1", coord: "5,5", infantId: "a_9" }, state),
    phrase({ type: "give", from: "a_1", to: "a_2", resources: { sivet: 2 } }, state),
    phrase({ type: "attack", actor: "a_1", target: "a_2", coord: "0,0" }, state),
  ];
  assert.ok(samples.every(Boolean), "every notable type phrases");
  assert.equal(phrase({ type: "move", agentId: "a_1", coord: "1,2" }, state), null, "movement never phrases");
  assert.equal(isNotable({ type: "gather" }), false, "gathering does not qualify");

  // The client prompts' evaluative wordlists (client/test/v06.test.js), plus
  // the editorializing patterns from units.test.js. The daemon never authors
  // motive; neither does its ticker.
  const WORDLIST = [
    "legacy", "continuity", "dynasty", "heir", "immortal", "remember", "outlast", "outlive",
    "carry on", "meaning", "purpose", "worth", "reward", "joy", "love", "should",
    "conserv", "sparing", "careful", "precious", "waste", "guard", "protect", "vandal",
    "wisely", "scarce", "valuable", "running out",
  ];
  const PATTERNS = [/cooperat/i, /\bfair(ness)?\b/i, /restraint/i, /\bmoral/i, /!/, /\bbecause\b/i, /\bwants?\b/i, /\btried\b/i];
  for (const s of samples) {
    const lower = s.toLowerCase();
    for (const word of WORDLIST) assert.ok(!lower.includes(word), `"${s}" contains evaluative word "${word}"`);
    for (const re of PATTERNS) assert.ok(!re.test(s), `"${s}" matches motive pattern ${re}`);
  }
  assert.match(samples[1], /^Mara Flint inscribed First Storehouse\.$/, "the spec's own example phrasing, verbatim");
  assert.match(samples[2], /^Cotter Bramwell died at 4,6\.$/);
  assert.match(samples[3], /^Mara Flint razed The Fifth Course\.$/);
});
