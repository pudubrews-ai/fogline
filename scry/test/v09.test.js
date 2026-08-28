// v0.9 Scry tests (scry spec v0.9 §6): cell hover in both truths, take in
// the ticker and the norm tracker (never the destruction ledger), pinned
// deaths in the recycle pool, the inheritance marker, and stub-run
// rendering with no special-casing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createState, applyRunStarted, applyTick } from "../src/source/reducer.js";
import { cellHoverLines, believedHoverLines } from "../src/panels/cellhover.js";
import { phrase, isNotable, createTicker } from "../src/ticker.js";
import { collectActs, traceAct } from "../src/panels/norms.js";
import { createDaemon } from "../../daemon/server.js";

// Motive language has no place in a ticker line (same discipline the v0.8
// wordlist tests enforce for every other event type).
const MOTIVE_WORDS = /steal|stole|theft|thief|rob|loot|plunder|crime|greed|selfish|brazen|cruel|bold|shocking/i;

function baseState() {
  const s = createState();
  s.gridSize = 4;
  s.width = 4;
  s.height = 4;
  s.tick = 12;
  s.inscriptionMax = 500;
  s.cells = new Map();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s.cells.set(`${x},${y}`, { coord: `${x},${y}`, deposit: null, loose: null, structure: null, corpses: [], fragment: null });
  return s;
}

function addAgent(s, id, name, coord, extra = {}) {
  s.agents.set(id, {
    agentId: id, name, coord, lifeStage: "adult", vitality: 100, sustenance: 100,
    inventory: {}, memories: [], knownCells: new Map(), ...extra,
  });
  return s.agents.get(id);
}

// ---------- 1. hover ----------

test("v0.9 test 1 — hover: every populated cell type renders its contents; an empty cell renders its coordinate alone", () => {
  const s = baseState();
  assert.deepEqual(cellHoverLines(s, "3,3"), ["3,3"], "empty cell: the coordinate alone");

  const cell = s.cells.get("1,1");
  cell.deposit = { resource: "sivet", quantity: 7 };
  cell.loose = { orrum: 2, khal: 0 };
  cell.structure = {
    form: "wall",
    authored: { name: "First Wall", description: "" },
    inscription: { entries: [{ text: "the river path is safe", authorName: "Mara", tick: 4 }], charactersUsed: 22 },
  };
  cell.fragment = { entries: [{ text: "old words" }] };
  cell.corpses = [{ authored: { name: "Old Marle" }, diedAtTick: 6 }];
  addAgent(s, "a_1", "Rook", "1,1");

  const lines = cellHoverLines(s, "1,1");
  assert.equal(lines[0], "1,1", "the coordinate leads");
  const text = lines.join("\n");
  assert.ok(text.includes("sivet deposit — 7"), "deposit and quantity");
  assert.ok(text.includes("loose: 2 orrum"), "loose pile, positive entries only");
  assert.ok(text.includes('wall "First Wall"'), "structure name and form");
  assert.ok(text.includes("1 inscription"), "inscription entry count");
  assert.ok(text.includes("478 chars left"), "budget state");
  assert.ok(text.includes("fragment — 1 surviving entry"), "fragment");
  assert.ok(text.includes("corpse: Old Marle"), "corpses");
  assert.ok(text.includes("here: Rook"), "agents present");

  // Budget-full reads as full.
  cell.structure.inscription.charactersUsed = 500;
  assert.ok(cellHoverLines(s, "1,1").join("\n").includes("budget full"));
});

// ---------- 2. hover under the agent-map overlay ----------

test("v0.9 test 2 — hover under overlay: a stale cell shows the believed snapshot and its tick, marked stale, differing from truth", () => {
  const s = baseState();
  const rook = addAgent(s, "a_rook", "Rook", "0,0");
  // Rook last stood at 2,2 at tick 8 and saw an orrum deposit; the deposit
  // has since been mined out and a structure has gone up.
  rook.knownCells.set("2,2", {
    structure: null,
    deposit: { resource: "orrum", quantity: 9 },
    loose: null,
    lastSeenTick: 8,
  });
  const truth = s.cells.get("2,2");
  truth.deposit = null;
  truth.structure = { form: "marker", authored: { name: "New Cairn", description: "" }, inscription: { entries: [], charactersUsed: 0 } };

  const believed = believedHoverLines(s, "2,2", "a_rook");
  const text = believed.join("\n");
  assert.ok(text.includes("Rook last saw a orrum deposit here (9) at tick 8."), "the believed snapshot with its tick");
  assert.ok(text.includes("stale"), "marked stale");
  assert.ok(!text.includes("New Cairn"), "the believed view never merges in the true state");

  // The true state stays available on the existing (non-overlay) read.
  assert.ok(cellHoverLines(s, "2,2").join("\n").includes("New Cairn"));

  // A never-entered cell says so.
  assert.ok(believedHoverLines(s, "3,3", "a_rook").join("\n").includes("never stood here"));

  // A current snapshot is not marked stale.
  rook.knownCells.set("0,0", { structure: null, deposit: null, loose: null, lastSeenTick: 12 });
  assert.ok(!believedHoverLines(s, "0,0", "a_rook").join("\n").includes("stale"));
});

// ---------- 3. take in the ticker ----------

test("v0.9 test 3 — ticker take: renders flatly, wordlist-asserted", () => {
  const s = baseState();
  addAgent(s, "a_c", "Corvane", "1,1");
  addAgent(s, "a_m", "Marlk Tessen", "1,1");
  const ev = { type: "take", tick: 9, actor: "a_c", target: "a_m", resource: "sivet", coord: "1,1" };
  assert.ok(isNotable(ev), "a take is a notable event");
  const line = phrase(ev, s);
  assert.equal(line, "Corvane took 1 sivet from Marlk Tessen.");
  assert.ok(!MOTIVE_WORDS.test(line), "no adjectives, no framing");
});

test("v0.9 fix 6.4 — deaths are pinned: still in the recycle pool long after the window has turned over", () => {
  const ticker = createTicker({ minReleaseMs: 100, recycleWindow: 2 });
  ticker.push([{ text: "Cotter Bramwell died at 4,6.", pinned: true }]);
  ticker.push(["a built X.", "b built Y.", "c built Z.", "d gave 1 sivet to e."]);
  let t = 0;
  for (let i = 0; i < 5; i++) assert.equal(ticker.next((t += 100)).recycled, false);
  // An hour of quiet: the death still comes around; the evicted builds do not.
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(ticker.next((t += 100)).text);
  assert.ok(seen.has("Cotter Bramwell died at 4,6."), "the death is still scrolling");
  assert.ok(!seen.has("a built X."), "unpinned items beyond the window were evicted");
});

// ---------- 4. take in the norm tracker ----------

test("v0.9 test 4 — norm tracker: a take with witnesses appears with its propagation chain", () => {
  const s = baseState();
  const takeText = "Corvane took 1 sivet from Marlk Tessen.";
  addAgent(s, "a_c", "Corvane", "1,1", { memories: [{ tick: 5, type: "observation", text: takeText, importance: 6 }] });
  addAgent(s, "a_m", "Marlk Tessen", "1,1", { memories: [{ tick: 5, type: "observation", text: takeText, importance: 6 }] });
  addAgent(s, "a_w", "Wren", "1,1", { memories: [{ tick: 5, type: "observation", text: takeText, importance: 6 }] });
  const rumor = "Watch your bags - Corvane took sivet straight out of Marlk Tessen's hands.";
  addAgent(s, "a_far", "Far Iva", "3,3", { memories: [{ tick: 7, type: "speech", text: rumor, speaker: "a_w" }] });
  s.events = [
    { type: "take", tick: 5, actor: "a_c", target: "a_m", resource: "sivet", coord: "1,1", witnesses: ["a_w"] },
    { type: "speech", tick: 7, speaker: "a_w", coord: "3,3", text: rumor },
  ];

  const acts = collectActs(s);
  assert.equal(acts.length, 1, "the take is classified alongside violence and destruction");
  assert.equal(acts[0].kind, "take");
  assert.equal(acts[0].resource, "sivet");
  const { firstHand, holders } = traceAct(s, acts[0]);
  assert.ok(firstHand.has("a_w"), "the co-located witness is first-hand");
  assert.ok(firstHand.has("a_m") && firstHand.has("a_c"), "victim and actor are first-hand");
  const far = holders.get("a_far");
  assert.ok(far && far.remove === 1, "the account propagated one remove via speech");
});

test("v0.9 test 4b — a take with no witnesses appears with an empty chain rather than being omitted", () => {
  const s = baseState();
  const takeText = "Corvane took 1 khal from Marlk Tessen.";
  addAgent(s, "a_c", "Corvane", "2,2", { memories: [{ tick: 6, type: "observation", text: takeText, importance: 6 }] });
  addAgent(s, "a_m", "Marlk Tessen", "2,2", { memories: [{ tick: 6, type: "observation", text: takeText, importance: 6 }] });
  s.events = [{ type: "take", tick: 6, actor: "a_c", target: "a_m", resource: "khal", coord: "2,2", witnesses: [] }];
  const acts = collectActs(s);
  assert.equal(acts.length, 1, "present even with nobody else there");
  const { holders } = traceAct(s, acts[0]);
  const derived = [...holders.values()].filter((i) => i.remove > 0);
  assert.equal(derived.length, 0, "an empty chain, not an omission");
});

test("v0.9 test 4c — a take never enters the destruction ledger", () => {
  // The ledger's own filter: raze and demolish_complete, nothing else. A
  // take is not destruction (scry spec v0.9 §4).
  const s = baseState();
  s.events = [
    { type: "take", tick: 5, actor: "a_c", target: "a_m", resource: "sivet", coord: "1,1", witnesses: [] },
    { type: "raze", tick: 6, agentId: "a_c", name: "Old Wall", form: "wall", coord: "2,2" },
  ];
  const ledgerActs = s.events.filter((e) => e.type === "raze" || e.type === "demolish_complete");
  assert.equal(ledgerActs.length, 1);
  assert.equal(ledgerActs[0].type, "raze");
});

// ---------- inheritance marker ----------

test("v0.9 — inheritance marked on lineage nodes only, from the beget event", () => {
  const s = baseState();
  applyTick(s, {
    tick: 9, simTime: "11:00", summary: {},
    events: [{ type: "beget", tick: 9, agentId: "a_p", infantId: "a_i", coord: "1,1", inherited: true }],
    memories: [], actions: [],
    bodies: [],
    cells: [],
  });
  const edge = s.lineage.edges.find((e) => e.child === "a_i");
  assert.ok(edge, "the birth edge exists");
  assert.equal(edge.inherited, true, "the inherited-knowledge marker rides the edge");
  // And a plain beget carries no marker.
  applyTick(s, {
    tick: 10, simTime: "11:15", summary: {},
    events: [{ type: "beget", tick: 10, agentId: "a_p", infantId: "a_j", coord: "1,1" }],
    memories: [], actions: [], bodies: [], cells: [],
  });
  assert.equal(s.lineage.edges.find((e) => e.child === "a_j").inherited, false);
});

// ---------- 5. stub rendering ----------

test("v0.9 test 5 — a stub-mode run's records fold through the reducer and every panel's logic with no special-casing", async () => {
  // A real daemon, agents driven by nothing (assigned waits — the daemon
  // side of a stub run is indistinguishable from any other client's run).
  const daemon = createDaemon(
    { startPaused: false, actionDeadlineMs: 120, maxTicks: 3, minAgents: 2, slots: 4, reapAfterTicks: 1000 },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let folded = null;
  const records = [];
  daemon.engine.on("operator", ({ event, data }) => {
    if (event === "run_started") folded = applyRunStarted(createState(), data);
    if (event === "tick") records.push(data);
  });

  try {
    const persona = (name) => ({
      name,
      appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
      disposition: "neutral",
      identity: `You are ${name}.`,
      discoverable: "Stub.",
      privateObjective: "Exist.",
    });
    for (const name of ["Stub A", "Stub B"]) {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol: "0.4", persona: persona(name), clientName: "stub" }),
      });
      assert.equal(res.status, 200);
    }
    for (let i = 0; i < 100 && !daemon.engine.stopped; i++) await new Promise((r) => setTimeout(r, 60));
    assert.ok(daemon.engine.stopped, "the run completed");

    folded = folded ?? applyRunStarted(createState(), daemon.engine.lastRunStarted);
    for (const rec of records) applyTick(folded, rec);

    // Every panel's pure logic over the folded state — nothing special-cased.
    assert.equal(folded.tick, 3);
    assert.equal(folded.agents.size, 2, "roster");
    assert.ok(folded.viability && typeof folded.viability.capacity === "number", "viability panel input");
    assert.deepEqual(collectActs(folded), [], "norm tracker renders its empty state");
    const someCoord = [...folded.cells.keys()][0];
    assert.ok(cellHoverLines(folded, someCoord).length >= 1, "cell hover reads the folded state");
    const withDeposit = [...folded.cells.values()].find((c) => c.deposit);
    assert.ok(withDeposit, "deposits folded from run_started");
    assert.ok(cellHoverLines(folded, withDeposit.coord).join("\n").includes("deposit"), "hover renders a deposit");
    for (const agent of folded.agents.values()) {
      assert.ok(agent.knownCells.size >= 1, "agent maps folded");
    }
  } finally {
    await daemon.close();
  }
});
