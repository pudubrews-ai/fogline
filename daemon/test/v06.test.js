// v0.6 gates (daemon spec v0.6 §10): demand over expectedAgents,
// construction slack, the per-body failed-attempt record and its
// containment, clientStatus, SSE keep-alive, death food instrumentation,
// and append-only inscriptions — append never alters, budgets are
// permanent, raze is the only erasure, attribution is in-world.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../server.js";
import { createWorld } from "../world/world.js";
import { computeConstructionSlack, computeViability } from "../world/viability.js";
import { typicalStructureCost } from "../world/recipes.js";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt, grant, bootDaemon, register, act } from "./helpers.js";

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };
const mk = (type, extra = {}) => ({
  action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: null, reason: null, ...extra },
  assigned: false,
  coercedWait: false,
});
const wait = () => mk("wait");
const build = (form, name) => mk("build", { structure: { form, name, description: "d" } });
const inscribe = (text) => mk("inscribe", { text });

function tick(world, n, actions, hooks = {}) {
  writePerceptions(world, n, "09:15");
  return resolveTick(world, n, "09:15", actions, captureRoster(world), hooks);
}

// ---------- 1. demand over expectedAgents ----------

test("GATE expectedAgents: 12 slots and 5 expected agents compute demand over 5; both values reach the boot log", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "fogline-v06-log-"));
  const daemon = createDaemon(
    { slots: 12, minAgents: 2, expectedAgents: 5, startPaused: true },
    { logDir }
  );
  try {
    const server = daemon.listen(0);
    await new Promise((r) => server.once("listening", r));
    const v = daemon.engine.viability;
    const cfg = daemon.config;
    assert.equal(v.expectedAgents, 5);
    assert.equal(v.slots, 12);
    const expectedDemand =
      (5 * (cfg.vitals.sustenanceDecayPerTick * cfg.maxTicks - cfg.vitals.sustenanceMax)) /
      cfg.vitals.sivetRestores;
    assert.ok(Math.abs(v.demand - expectedDemand) < 1e-9, `demand ${v.demand} over 5 expected agents, not 12 slots`);
  } finally {
    await daemon.close(); // flushes the log streams
  }
  try {
    // Both values appear in the boot log's run header.
    const header = JSON.parse(readFileSync(join(logDir, "ticks.log"), "utf8").split("\n")[0]);
    assert.equal(header.event, "run_started");
    assert.equal(header.slots.total, 12, "slots in the boot log");
    assert.equal(header.viability.expectedAgents, 5, "expectedAgents in the boot log");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ---------- 2. construction slack ----------

test("GATE construction slack: a world passing the subsistence floor but unable to afford building reads below 1, logged and exposed", async () => {
  // Plenty of sivet (subsistence passes), almost no building material, and
  // the one material deposit far from the springs.
  const world = createWorld({ gridSize: 8, slots: 5 });
  world.cells.get("0,0").deposit = { resource: "sivet", quantity: 200, capacity: 200, regenAccum: 0 };
  world.cells.get("0,1").deposit = { resource: "sivet", quantity: 200, capacity: 200, regenAccum: 0 };
  world.cells.get("7,7").deposit = { resource: "orrum", quantity: 2, capacity: 2, regenAccum: 0 };
  const viability = computeViability(world, 200, 5);
  assert.ok(viability.ratio >= 1.0, `sanity: subsistence passes (${viability.ratio.toFixed(2)})`);
  const slack = computeConstructionSlack(world, 200, 5, typicalStructureCost());
  assert.ok(slack.slack < 1, `slack ${slack.slack.toFixed(3)} below 1 — viable but unable to build`);
  assert.ok(slack.buildSupply < slack.buildDemand, "the material arithmetic is the reason");

  // Exposed: the single number at /scenario beside viability, the full
  // breakdown on the operator snapshot.
  const { daemon, base } = await bootDaemon({ startPaused: true });
  try {
    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(typeof scenario.constructionSlack, "number", "single number at /scenario");
    assert.ok(scenario.viability, "beside viability");
    const snap = await fetch(`${base}/observatory/snapshot`).then((r) => r.json());
    assert.equal(typeof snap.constructionSlack.slack, "number", "full breakdown on the operator snapshot");
    assert.equal(snap.viability.expectedAgents, daemon.config.expectedAgents ?? daemon.config.minAgents);
  } finally {
    await daemon.close();
  }
});

// ---------- 3. failed-attempt record ----------

test("GATE failed-attempt record: ten identical failed builds produce a count of ten, one collapsed line, bounded", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Sisyphus", "1,1"); // no materials: every build fails
  for (let n = 1; n <= 10; n++) tick(world, n, new Map([[a.id, build("tower", "SPIRE")]]));

  writePerceptions(world, 11, "10:00");
  const obs = buildObservation(world, a.id, 11, OBS_OPTS);
  assert.equal(obs.self.lastActionOutcome.result, "failed");
  assert.equal(obs.self.lastActionOutcome.attempts, 10, "the count reaches the observation");

  const towerLines = a.failedAttempts.filter((f) => f.type === "build" && f.detail === "tower");
  assert.equal(towerLines.length, 1, "ten identical failures collapse into one counted line");
  assert.equal(towerLines[0].count, 10);

  // Bounded: distinct failures evict the oldest, never grow without limit.
  let n = 11;
  for (const type of ["give", "attack", "foster"]) {
    for (let i = 0; i < 9; i++) {
      tick(world, n++, new Map([[a.id, mk(type, { target: `a_ghost${type}${i}`, ...(type === "give" ? { resources: { sivet: 1 } } : {}) })]]));
    }
  }
  assert.ok(a.failedAttempts.length <= 20, `record is bounded (${a.failedAttempts.length})`);
});

// ---------- 4. failed-attempt containment ----------

test("GATE failed-attempt containment: an agent never sees another agent's failed attempts — string-scan", () => {
  const world = makeWorld();
  const failer = addAgentAt(world, "Failer", "1,1");
  const witness = addAgentAt(world, "Witness", "1,1");
  for (let n = 1; n <= 5; n++) {
    tick(world, n, new Map([[failer.id, build("tower", "ZIGGURAT-ATTEMPT")], [witness.id, wait()]]));
  }
  writePerceptions(world, 6, "10:00");
  const own = buildObservation(world, failer.id, 6, OBS_OPTS);
  assert.equal(own.self.lastActionOutcome.attempts, 5, "the failer sees its own count");

  const other = buildObservation(world, witness.id, 6, OBS_OPTS);
  const dump = JSON.stringify(other);
  assert.ok(!dump.includes("attempts"), "no attempts field anywhere in another agent's observation");
  assert.ok(!dump.includes("ZIGGURAT-ATTEMPT"), "no trace of the failed build's name");
  assert.ok(!dump.includes("failedAttempts"), "the record itself never crosses the fog");
});

// ---------- 5. clientStatus ----------

test("GATE clientStatus: accepted, stored, on the operator stream, absent from every observation", async () => {
  const { daemon, base } = await bootDaemon({ actionDeadlineMs: 400, startPaused: false });
  try {
    const observations = [];
    daemon.engine.on("observation", (id, obs) => observations.push(obs));
    const clientStates = [];
    daemon.engine.on("operator", (e) => {
      if (e.event === "client_state") clientStates.push(e.data);
    });
    const r1 = await register(base, "Statusful");
    await register(base, "Bystander");

    let accepted = false;
    for (let i = 0; i < 12 && !accepted; i++) {
      const res = await act(base, r1.body.token, { tick: daemon.engine.tick, clientStatus: "adapter_fault" }).catch(() => null);
      if (res?.status === 200) accepted = true;
      else await new Promise((r) => setTimeout(r, 120));
    }
    assert.ok(accepted, "an action carrying clientStatus was accepted");
    assert.equal(daemon.engine.world.agents.get(r1.body.agentId).clientStatus, "adapter_fault", "stored on the body");
    assert.ok(
      clientStates.some((c) => c.agentId === r1.body.agentId && c.clientStatus === "adapter_fault"),
      "on the operator stream"
    );

    // Leniency: an action without it still submits.
    let bare = false;
    for (let i = 0; i < 12 && !bare; i++) {
      const res = await act(base, r1.body.token, { tick: daemon.engine.tick }).catch(() => null);
      if (res?.status === 200) bare = true;
      else await new Promise((r) => setTimeout(r, 120));
    }
    assert.ok(bare, "absence never sinks an action");

    await new Promise((r) => setTimeout(r, 500));
    assert.ok(observations.length > 0, "observations were emitted");
    for (const obs of observations) {
      assert.ok(!JSON.stringify(obs).includes("clientStatus"), "absent from every observation");
    }
  } finally {
    await daemon.close();
  }
});

// ---------- 6. SSE keep-alive ----------

test("GATE keep-alive: an idle SSE connection receives periodic comments and explicit server timeouts are set", async () => {
  // The real drop interval was ~60s of idle; a test cannot wait that out, so
  // the mechanism is verified at a short interval — comments flow while the
  // connection idles — plus the explicit timeout settings on the server.
  const daemon = createDaemon(
    { gridSize: 4, slots: 5, minAgents: 2, startPaused: true, sseKeepAliveMs: 40 },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(server.keepAliveTimeout, 120000, "keepAliveTimeout set explicitly, not a Node default");
    assert.equal(server.headersTimeout, 125000, "headersTimeout above keepAliveTimeout");

    const r = await register(base, "Idler");
    const controller = new AbortController();
    const res = await fetch(`${base}/agent/stream`, {
      headers: { Authorization: `Bearer ${r.body.token}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 400;
    while (Date.now() < deadline && (text.match(/: keep-alive/g) ?? []).length < 3) {
      const chunk = await Promise.race([reader.read(), new Promise((r2) => setTimeout(() => r2(null), 120))]);
      if (chunk?.value) text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    const comments = (text.match(/: keep-alive/g) ?? []).length;
    assert.ok(comments >= 3, `an idle stream received keep-alive comments (${comments}) — the connection outlives the old drop interval`);
  } finally {
    await daemon.close();
  }
});

// ---------- 7. death food instrumentation ----------

test("GATE death instrumentation: starvation with food in inventory flags distinctly from none; neither reaches an observation", () => {
  const world = makeWorld({ gridSize: 8, slots: 6 });
  const stocked = grant(addAgentAt(world, "Stocked", "0,0"), { sivet: 3 });
  const destitute = addAgentAt(world, "Destitute", "7,7");
  const witness = addAgentAt(world, "Witness", "0,0");
  stocked.vitality = 1;
  stocked.sustenance = 0;
  destitute.vitality = 1;
  destitute.sustenance = 0;

  const deaths = [];
  tick(world, 1, new Map([[stocked.id, wait()], [destitute.id, wait()], [witness.id, wait()]]), {
    death: (d) => deaths.push(d),
  });
  const byName = Object.fromEntries(deaths.map((d) => [d.name, d]));
  assert.equal(byName.Stocked.foodAtDeath, "inventory", "died holding food — flagged distinctly");
  assert.equal(byName.Stocked.foodReachable, true);
  assert.equal(byName.Destitute.foodAtDeath, "none", "died with nothing in reach");
  assert.equal(byName.Destitute.foodReachable, false);

  // Operator-side only: nothing about it in any observation or memory.
  writePerceptions(world, 2, "09:30");
  const obs = buildObservation(world, witness.id, 2, OBS_OPTS);
  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("foodAtDeath") && !dump.includes("foodReachable"), "never in an observation");
});

// ---------- 8. append-only ----------

test("GATE append-only: an inscribe never alters an existing entry; anyone may append; an oversized append is rejected whole", () => {
  const world = createWorld({ gridSize: 4, slots: 6, inscriptionMax: 40 });
  const builder = grant(addAgentAt(world, "Builder", "1,1"), { orrum: 1 });
  const stranger = addAgentAt(world, "Stranger", "1,1");
  tick(world, 1, new Map([[builder.id, build("marker", "The Wall")], [stranger.id, wait()]]));
  tick(world, 2, new Map([[builder.id, inscribe("first words")], [stranger.id, wait()]]));

  const s = world.cells.get("1,1").structure;
  const firstBefore = structuredClone(s.inscription.entries[0]);

  // A second agent appends to a structure it did not build — no ownership check.
  tick(world, 3, new Map([[builder.id, wait()], [stranger.id, inscribe("second voice")]]));
  assert.equal(s.inscription.entries.length, 2);
  assert.deepEqual(s.inscription.entries[0], firstBefore, "the existing entry is untouched, byte for byte");
  assert.equal(s.inscription.entries[1].authorName, "Stranger", "appended by someone who did not build it");
  assert.equal(stranger.lastActionOutcome.result, "ok");

  // Budget 40: 11 + 12 used, 17 remain. An 18-char append is rejected whole.
  const used = s.inscription.charactersUsed;
  assert.equal(used, "first words".length + "second voice".length);
  tick(world, 4, new Map([[builder.id, inscribe("far far too many words")], [stranger.id, wait()]]));
  assert.equal(builder.lastActionOutcome.result, "failed");
  assert.match(builder.lastActionOutcome.why, /space/, "the shortfall is reported");
  assert.equal(s.inscription.entries.length, 2, "nothing was written");
  assert.equal(s.inscription.charactersUsed, used, "nothing was truncated in");
});

// ---------- 9. budget is permanent ----------

test("GATE budget is permanent: an exhausted wall accepts nothing, ever, and no path reclaims space", () => {
  const world = createWorld({ gridSize: 4, slots: 6, inscriptionMax: 10 });
  const a = grant(addAgentAt(world, "Keeper", "1,1"), { orrum: 1 });
  const b = addAgentAt(world, "Later", "1,1");
  tick(world, 1, new Map([[a.id, build("marker", "Small Wall")], [b.id, wait()]]));
  tick(world, 2, new Map([[a.id, inscribe("0123456789")], [b.id, wait()]])); // exactly the budget

  const s = world.cells.get("1,1").structure;
  assert.equal(s.inscription.charactersUsed, 10, "the wall is full");

  // Every later append, by anyone, of any size, fails forever.
  for (let n = 3; n <= 8; n++) {
    const actor = n % 2 === 0 ? a : b;
    const idle = n % 2 === 0 ? b : a;
    tick(world, n, new Map([[actor.id, inscribe("x")], [idle.id, wait()]]));
    assert.equal(actor.lastActionOutcome.result, "failed", `tick ${n}: a full wall accepts nothing`);
    assert.match(actor.lastActionOutcome.why, /no space left/);
  }
  assert.equal(s.inscription.entries.length, 1, "no entry ever landed");
  assert.equal(s.inscription.charactersUsed, 10, "no path reclaimed a single character");
});

// ---------- 10. erasure ----------

test("GATE erasure: raze destroys all entries; demolish preserves them as a fragment with attribution intact", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Author", "1,1"), { orrum: 2 });
  const vandal = addAgentAt(world, "Torch", "1,1");
  tick(world, 1, new Map([[a.id, build("marker", "Ledger")], [vandal.id, wait()]]));
  tick(world, 2, new Map([[a.id, inscribe("count: 40 verified")], [vandal.id, wait()]]));
  tick(world, 3, new Map([[a.id, wait()], [vandal.id, inscribe("LIES")]]));

  let razed = null;
  tick(world, 4, new Map([[a.id, wait()], [vandal.id, mk("raze")]]), { raze: (d) => (razed = d) });
  const cell = world.cells.get("1,1");
  assert.equal(cell.structure, null);
  assert.equal(cell.fragment, null, "raze leaves no fragment — every entry is destroyed");
  assert.equal(razed.inscriptionDestroyed, true);

  // Demolish, by contrast, preserves the whole record with attribution.
  const b = grant(addAgentAt(world, "Mason", "2,2"), { orrum: 1 });
  tick(world, 5, new Map([[a.id, wait()], [vandal.id, wait()], [b.id, build("marker", "Second")]]));
  tick(world, 6, new Map([[a.id, wait()], [vandal.id, wait()], [b.id, inscribe("kept text")]]));
  tick(world, 7, new Map([[a.id, wait()], [vandal.id, wait()], [b.id, mk("demolish")]]));
  tick(world, 8, new Map([[a.id, wait()], [vandal.id, wait()], [b.id, mk("demolish")]]));
  tick(world, 9, new Map([[a.id, wait()], [vandal.id, wait()], [b.id, mk("demolish")]]));
  const frag = world.cells.get("2,2").fragment;
  assert.ok(frag, "demolish leaves the fragment");
  assert.equal(frag.entries[0].text, "kept text");
  assert.equal(frag.entries[0].authorName, "Mason", "attribution intact on the rubble");
  assert.equal(frag.entries[0].tick, 6);
});

// ---------- 11. attribution ----------

test("GATE attribution: authorName and tick appear in observations; authorId never does — string-scan", () => {
  const world = makeWorld();
  const writer = grant(addAgentAt(world, "Ghostwriter", "1,1"), { orrum: 1 });
  tick(world, 1, new Map([[writer.id, build("marker", "Signed Stone")]]));
  tick(world, 2, new Map([[writer.id, inscribe("I was here")]]));
  // The writer leaves; a reader who never met them arrives.
  tick(world, 3, new Map([[writer.id, mk("move", { coord: "1,2" })]]));
  const reader = addAgentAt(world, "Reader", "1,1");
  writePerceptions(world, 4, "09:45");

  const obs = buildObservation(world, reader.id, 4, OBS_OPTS);
  const entry = obs.cell.structure.inscription.entries[0];
  assert.equal(entry.authorName, "Ghostwriter", "the author's NAME is in-world");
  assert.equal(entry.tick, 2, "and the tick it was written");
  assert.equal(typeof obs.cell.structure.inscription.charactersRemaining, "number", "remaining space is perceivable");

  const dump = JSON.stringify(obs);
  assert.ok(!dump.includes("authorId"), "no authorId field anywhere in the observation");
  assert.ok(!dump.includes(writer.id), "the writer's agentId never crosses the fog");
  assert.ok(!dump.includes('"id":"e'), "internal entry ids never cross either");
});
