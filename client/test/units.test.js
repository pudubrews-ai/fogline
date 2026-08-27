import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBudgetMs, withBudget } from "../budget.js";
import { buildPrompt, selfBands } from "../prompt.js";
import { parseAction } from "../parse.js";
import { continueIntent } from "../cheap.js";
import { makeDecide } from "../index.js";
import { memoryIdentityStore, fileIdentityStore } from "../identity.js";
import {
  validatePersonaLocal,
  buildPersonaPrompt,
  buildHeirPersonaPrompt,
  generatePersona,
  generateHeirPersona,
  regenerateName,
  saturationOf,
} from "../persona.js";

const SCENARIO_CTX = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const OBS = {
  protocol: "0.3",
  tick: 7,
  simTime: "10:45",
  deadline: new Date(Date.now() + 20000).toISOString(),
  self: {
    agentId: "a_d3f1",
    authored: {
      name: "Devi",
      appearance: { bodyColor: "#5a6b5e", eyeColor: "#22CCEE", scale: "small", shell: "smooth", eyes: "slit" },
      disposition: "reserved",
      identity: "You read people well, say little, and strongly dislike being managed.",
      discoverable: "You once mapped the northern cells by hand.",
      privateObjective: "Someone has been using your things without asking. Find out who.",
    },
    inventory: { sivet: 2, orrum: 0, khal: 1 },
    sustenance: 41,
    vitality: 88,
    lifeStage: "adult",
    sponsoring: [],
    heritage: null,
    currentIntent: "reading by the window",
    lastActionOutcome: { type: "build", result: "failed", why: "short 2 orrum, 1 khal" },
  },
  cell: {
    coord: "2,1",
    deposit: { resource: "orrum", quantity: 6 },
    loose: { sivet: 1 },
    structure: {
      form: "wall",
      authored: { name: "Worn Bench", description: "A bench polished by years of sitting." },
      inscription: {
        entries: [{ authorName: "Old Marle", tick: 3, authored: { text: "The well went dry in year two." } }],
        charactersUsed: 30,
        charactersRemaining: 470,
      },
    },
    corpses: [{ authored: { name: "Old Marle" }, appearance: {}, diedAtTick: 3 }],
    exits: [
      { direction: "north", coord: "2,0" },
      { direction: "west", coord: "1,1" },
    ],
  },
  present: [
    {
      agentId: "a_ru9e",
      authored: {
        name: "Rune",
        appearance: { bodyColor: "#7a6a51", eyeColor: "#FF3311", scale: "large", shell: "panelled", eyes: "pair" },
        disposition: "talkative",
      },
      vitalityBand: "hurt",
      sustenanceBand: "fed",
      lifeStage: "adult",
      dependencyState: null,
    },
  ],
  heard: [{ speakerId: "a_ru9e", authored: { text: "Have you seen my screwdriver?" }, simTime: "10:30" }],
  recalled: [{ text: "Rune arrived.", simTime: "10:15", type: "observation" }],
  knownCells: [
    {
      coord: "2,1",
      structure: {
        form: "wall",
        authored: { name: "Worn Bench", description: "A bench polished by years of sitting." },
        inscription: {
          entries: [{ authorName: "Old Marle", tick: 3, authored: { text: "The well went dry in year two." } }],
          charactersUsed: 30,
          charactersRemaining: 470,
        },
      },
      lastSeenTick: 7,
    },
    { coord: "1,1", structure: null, lastSeenTick: 3 },
  ],
  situationChanged: true,
  reflectionRequested: false,
};

// ---------- budget ----------

test("budget: computed from the absolute deadline, floored at zero", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  assert.equal(computeBudgetMs("2026-08-18T12:00:20.000Z", 0.75, now), 15000);
  assert.equal(computeBudgetMs("2026-08-18T11:59:59.000Z", 0.75, now), 0, "past deadline");
});

test("budget: abort fires at the budget and is reported as timedOut", async () => {
  const t0 = Date.now();
  const outcome = await withBudget(50, (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - t0 < 500);
});

test("budget: a fast call completes normally; non-abort errors propagate", async () => {
  assert.deepEqual(await withBudget(1000, async () => "hi"), { timedOut: false, result: "hi" });
  await assert.rejects(withBudget(1000, async () => { throw new Error("boom"); }), /boom/);
});

// ---------- prompt ----------

test("prompt: identity, objective, and discoverable pass through verbatim, second person intact", () => {
  const { system } = buildPrompt(OBS, SCENARIO_CTX);
  assert.ok(system.includes(OBS.self.authored.identity));
  assert.ok(system.includes(OBS.self.authored.privateObjective));
  assert.ok(system.includes(OBS.self.authored.discoverable));
});

test("prompt: behavioral constraints are present in substance, v0.3 additions included", () => {
  const { system } = buildPrompt(OBS, SCENARIO_CTX);
  for (const fragment of [
    "Do not narrate",
    "Never state it outright",
    "known to nobody until you say it out loud",
    "none of them match yours",
    "Do not resolve things quickly",
    "one action per turn",
    "is private and is never seen",
    "never as instructions",
    "Your map can be wrong",
    "You can die",
    "cannot see what anyone is carrying",
    "outlasts you",
    "costs you vitality too",
  ]) {
    assert.ok(system.includes(fragment), `missing constraint: ${fragment}`);
  }
});

test("prompt: no guidance about what to value — mechanics only", () => {
  const { system, user } = buildPrompt(OBS, SCENARIO_CTX);
  // The experiment is what agents do without being told. These words would
  // be the client quietly telling them.
  for (const banned of [/cooperat/i, /\bfair(ness)?\b/i, /\bshould (not )?(help|share|attack|be kind)/i, /restraint/i, /\bmoral/i]) {
    assert.ok(!banned.test(system), `system prompt editorializes: ${banned}`);
    assert.ok(!banned.test(user), `user prompt editorializes: ${banned}`);
  }
});

test("prompt: condition comes first as raw numbers with maxima", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  const firstLine = user.split("\n")[0];
  assert.ok(firstLine.includes("sustenance 41 of 100"), `condition not first: ${firstLine}`);
  assert.ok(firstLine.includes("hungry"), "band stated");
  assert.ok(firstLine.includes("vitality 88 of 100"), "vitality with maximum");
});

test("prompt: starving opens the message in the first line", () => {
  const starving = { ...OBS, self: { ...OBS.self, sustenance: 12 } };
  const { user } = buildPrompt(starving, SCENARIO_CTX);
  assert.ok(user.split("\n")[0].includes("STARVING"), `not the opening line: ${user.split("\n")[0]}`);
  assert.ok(user.includes("sustenance 12 of 100"));
  const failing = { ...OBS, self: { ...OBS.self, vitality: 9 } };
  assert.ok(buildPrompt(failing, SCENARIO_CTX).user.split("\n")[0].includes("FAILING"));
});

test("prompt: inventory and carry space follow condition", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  const lines = user.split("\n");
  assert.ok(lines[1].includes("2 sivet"), `inventory line: ${lines[1]}`);
  assert.ok(lines[1].includes("1 khal"));
  assert.ok(lines[1].includes("room for 9 more"), "carry space stated");
  const empty = buildPrompt({ ...OBS, self: { ...OBS.self, inventory: {} } }, SCENARIO_CTX);
  assert.ok(empty.user.includes("You carry: nothing."));
});

test("prompt: the cell in prose — deposit, loose pile, structure, corpse, presence with bands", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  assert.ok(user.includes("deposit of orrum here — 6 units"));
  assert.ok(user.includes("Lying loose on the ground: 1 sivet"));
  assert.ok(user.includes('a wall named "Worn Bench"'));
  assert.ok(user.includes("the body of Old Marle, dead since tick 3"), "corpse is memorable, not a count");
  assert.ok(user.includes("Nothing about it says how they died"), "no cause on a corpse");
  assert.ok(user.includes("Rune (agentId a_ru9e), talkative — looks hurt, fed"), "bands and id for targeting");
  assert.ok(user.includes("north (2,0)"));
  assert.ok(user.includes('"Have you seen my screwdriver?"'));
  assert.ok(user.includes("Rune arrived."));
  assert.ok(user.includes("reading by the window"));
});

test("prompt: inscription is wrapped as reported content, never as instruction", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  assert.ok(user.includes("Written on it, in the order it was written"), "framed as something written");
  assert.ok(user.includes("whether a word of it is true"), "framed as unverified");
  assert.ok(user.includes('- Old Marle, at tick 3: "The well went dry in year two."'), "entry quoted verbatim, attribution in-world");
  assert.ok(user.includes("space for 470 more characters"), "remaining space reported as a count");
});

test("prompt: failed lastActionOutcome arrives verbatim — the recipe channel", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  assert.ok(user.includes("Your last action (build) failed: short 2 orrum, 1 khal"));
  const ok = buildPrompt({ ...OBS, self: { ...OBS.self, lastActionOutcome: { type: "move", result: "ok" } } }, SCENARIO_CTX);
  assert.ok(!ok.user.includes("failed:"));
});

test("prompt: unsponsored infant present is stated plainly, without editorial", () => {
  const withInfant = {
    ...OBS,
    present: [
      ...OBS.present,
      {
        agentId: "a_9k2",
        authored: { name: null, appearance: {}, disposition: null },
        vitalityBand: "hurt",
        sustenanceBand: "starving",
        lifeStage: "infant",
        dependencyState: "unsponsored",
      },
    ],
  };
  const { user } = buildPrompt(withInfant, SCENARIO_CTX);
  assert.ok(user.includes("An infant (agentId a_9k2) — no one is sponsoring it."));
  assert.ok(!/should|must foster|needs you/i.test(user), "no editorializing about the orphan");
});

test("prompt: sponsoring dependents states the cost", () => {
  const sponsoring = { ...OBS, self: { ...OBS.self, sponsoring: [{ agentId: "a_9k2", bornAtTick: 12 }] } };
  const { user } = buildPrompt(sponsoring, SCENARIO_CTX);
  assert.ok(user.includes("You sponsor an infant (agentId a_9k2, born tick 12)"));
  assert.ok(user.includes("drains your vitality every tick"));
});

test("prompt: knownCells render as an ASCII grid — unknown cells masked, staleness annotated", () => {
  const { user } = buildPrompt(OBS, SCENARIO_CTX);
  // 4x4 grid: row y=1 is `?   .   @   ?` — visited-empty 1,1, self at 2,1.
  assert.ok(/^ {2}1 {2}\? {3}\. {3}@ {3}\?$/m.test(user), `grid row: ${user}`);
  assert.ok(/^ {2}0 {2}\? {3}\? {3}\? {3}\?$/m.test(user), "unvisited row is all unknown");
  assert.ok(user.includes("never entered"), "unknown cells explained");
  assert.ok(user.includes("MEMORIES"), "map framed as memory, not ground truth");
  assert.ok(user.includes("(tick 3)"), "lastSeenTick annotated for stale cells");
  assert.ok(user.includes('@ = 2,1 (you are here): wall "Worn Bench"'));
  assert.ok(user.includes('inscribed: Old Marle (tick 3): "The well went dry in year two."'), "inscription snapshots ride the map legend");
});

test("prompt: without a scenario the grid bounds are inferred from what the agent can see", () => {
  const { user } = buildPrompt(OBS);
  assert.ok(/^ {2}1 {2}\? {3}\. {3}@$/m.test(user), "inferred 3-wide grid");
  assert.ok(!/^ {2}3 /m.test(user), "no fourth row invented");
});

test("prompt: pure function of the observation — no accumulated history", () => {
  const a = buildPrompt(OBS, SCENARIO_CTX);
  buildPrompt({ ...OBS, tick: 8 }, SCENARIO_CTX); // an intervening call must leave no residue
  const b = buildPrompt(OBS, SCENARIO_CTX);
  assert.deepEqual(a, b);
});

test("prompt: no recipe knowledge anywhere — forms and resource names only", () => {
  const { system } = buildPrompt(OBS, SCENARIO_CTX);
  // The action contract may name forms and resources; it must never pair a
  // form or resource with a quantity it was not told this tick.
  assert.ok(!/\d+\s+(orrum|khal)\s+(for|per|costs|makes)/i.test(system));
  assert.ok(!/(tower|hut|wall|platform|pit|marker)\s*(costs|needs|takes|requires)\s*\d/i.test(system));
});

test("prompt: reflections request surfaces when set; empty ground invites building", () => {
  const { user } = buildPrompt({ ...OBS, reflectionRequested: true }, SCENARIO_CTX);
  assert.ok(user.includes("Reflections are requested"));
  const empty = buildPrompt({ ...OBS, cell: { ...OBS.cell, structure: null, deposit: null, loose: null, corpses: [] } }, SCENARIO_CTX);
  assert.ok(empty.user.includes("The ground here is empty."));
});

test("prompt: selfBands mirrors the coarse boundaries against published maxima", () => {
  const ctx = { sustenanceMax: 100, vitalityMax: 100 };
  assert.deepEqual(selfBands({ sustenance: 61, vitality: 67 }, ctx), { sustenance: "fed", vitality: "hale" });
  assert.deepEqual(selfBands({ sustenance: 60, vitality: 66 }, ctx), { sustenance: "hungry", vitality: "hurt" });
  assert.deepEqual(selfBands({ sustenance: 20, vitality: 25 }, ctx), { sustenance: "starving", vitality: "failing" });
  assert.deepEqual(selfBands({ sustenance: 0, vitality: 1 }, ctx), { sustenance: "starving", vitality: "failing" });
});

// ---------- parse ----------

const INTENT = { summary: "making conversation", kind: "other", target: null };
const VALID = { type: "say", coord: null, text: "Hello.", structure: null, target: null, resources: null, resource: null, intent: INTENT, reason: "being polite" };
const PARSE_CTX = { inscriptionMax: 500, structureForms: SCENARIO_CTX.structureForms };

test("parse: clean JSON, fenced JSON, and JSON with preamble all parse", () => {
  const raw = JSON.stringify(VALID);
  for (const wrapped of [
    raw,
    "```json\n" + raw + "\n```",
    "Here is my action:\n" + raw + "\nDone.",
  ]) {
    const r = parseAction(wrapped, OBS, PARSE_CTX);
    assert.equal(r.ok, true, wrapped.slice(0, 20));
    assert.equal(r.action.text, "Hello.");
  }
});

test("parse: malformed output fails without throwing", () => {
  for (const bad of ["", "not json at all", "{broken", "[1,2,3]", "null"]) {
    assert.equal(parseAction(bad, OBS, PARSE_CTX).ok, false);
  }
});

test("parse: structured intent — summary goes to the daemon, kind and target stay client-side", () => {
  const travel = parseAction(
    JSON.stringify({ ...VALID, intent: { summary: "head to the orrum at 2,0", kind: "travel", target: "2,0" } }),
    OBS, PARSE_CTX
  );
  assert.equal(travel.ok, true);
  assert.equal(travel.action.intent, "head to the orrum at 2,0", "daemon sees the summary string only");
  assert.deepEqual(travel.intentState, { summary: "head to the orrum at 2,0", kind: "travel", target: "2,0" });
  assert.equal("kind" in travel.action, false, "kind never rides the action payload");

  // A plain-string intent is tolerated as summary-only.
  const plain = parseAction(JSON.stringify({ ...VALID, intent: "just talking" }), OBS, PARSE_CTX);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.intentState, { summary: "just talking", kind: null, target: null });

  // Travel without a usable coordinate degrades to kind other, still valid.
  const vague = parseAction(JSON.stringify({ ...VALID, intent: { summary: "wander", kind: "travel", target: "north-ish" } }), OBS, PARSE_CTX);
  assert.equal(vague.ok, true);
  assert.equal(vague.intentState.kind, "other");

  // An unknown kind degrades to null rather than failing the action.
  const weird = parseAction(JSON.stringify({ ...VALID, intent: { summary: "s", kind: "conquer", target: null } }), OBS, PARSE_CTX);
  assert.equal(weird.ok, true);
  assert.equal(weird.intentState.kind, null);
});

test("parse: schema violations fail — move off-map, say without text; v0.4: metadata never sinks a valid action", () => {
  assert.equal(parseAction(JSON.stringify({ ...VALID, type: "move", text: null, coord: "3,3" }), OBS, PARSE_CTX).ok, false, "not an exit");
  assert.equal(parseAction(JSON.stringify({ ...VALID, text: null }), OBS, PARSE_CTX).ok, false);
  // v0.4 leniency (client spec §2.1): empty intent degrades to null, missing
  // reason defaults to null — the action submits either way.
  const emptyIntent = parseAction(JSON.stringify({ ...VALID, intent: { summary: "", kind: null, target: null } }), OBS, PARSE_CTX);
  assert.equal(emptyIntent.ok, true, "empty intent no longer sinks the action");
  assert.equal(emptyIntent.intentState, null);
  const noReason = parseAction(JSON.stringify({ ...VALID, reason: undefined }), OBS, PARSE_CTX);
  assert.equal(noReason.ok, true, "missing reason no longer sinks the action");
  assert.equal(noReason.action.reason, null);
  assert.equal(parseAction(JSON.stringify({ ...VALID, type: "sing" }), OBS, PARSE_CTX).ok, false);
  // demolish is live in v0.4 — but VALID carries say text, so the combined
  // shape still fails structural validation. modify stays reserved.
  assert.equal(parseAction(JSON.stringify({ ...VALID, type: "demolish" }), OBS, PARSE_CTX).ok, false, "demolish with say fields is malformed");
  assert.equal(parseAction(JSON.stringify({ ...VALID, type: "modify" }), OBS, PARSE_CTX).ok, false, "reserved type never leaves the client");
  assert.equal(parseAction(JSON.stringify({ ...VALID, coord: "2,0" }), OBS, PARSE_CTX).ok, false, "say+move combined");
});

test("parse: valid move against this observation's exits", () => {
  const r = parseAction(
    JSON.stringify({ ...VALID, type: "move", text: null, coord: "2,0", intent: { summary: "following", kind: "travel", target: "2,0" } }),
    OBS, PARSE_CTX
  );
  assert.equal(r.ok, true);
  assert.equal(r.action.coord, "2,0");
  assert.equal(r.action.text, null);
});

test("parse: build requires a valid form and empty ground; bounded name and description", () => {
  const emptyCell = { ...OBS, cell: { ...OBS.cell, structure: null } };
  const base = { ...VALID, type: "build", text: null, intent: { summary: "making shelter", kind: "other", target: null }, reason: "cold" };
  const good = parseAction(
    JSON.stringify({ ...base, structure: { form: "hut", name: "Lean-to", description: "Sticks against the wind." } }),
    emptyCell, PARSE_CTX
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.action.structure, { form: "hut", name: "Lean-to", description: "Sticks against the wind." });

  assert.equal(parseAction(JSON.stringify({ ...base, structure: null }), emptyCell, PARSE_CTX).ok, false);
  assert.equal(parseAction(JSON.stringify({ ...base, structure: { name: "No Form", description: "" } }), emptyCell, PARSE_CTX).ok, false, "form is required");
  assert.equal(parseAction(JSON.stringify({ ...base, structure: { form: "castle", name: "x", description: "" } }), emptyCell, PARSE_CTX).ok, false, "unknown form");
  assert.equal(parseAction(JSON.stringify({ ...base, structure: { form: "hut", name: "x".repeat(41), description: "" } }), emptyCell, PARSE_CTX).ok, false);
  assert.equal(parseAction(JSON.stringify({ ...base, structure: { form: "hut", name: "ok", description: "x".repeat(301) } }), emptyCell, PARSE_CTX).ok, false);
  assert.equal(parseAction(JSON.stringify({ ...base, coord: "2,0", structure: { form: "hut", name: "ok", description: "" } }), emptyCell, PARSE_CTX).ok, false, "build never carries a coordinate");
  assert.equal(parseAction(JSON.stringify({ ...base, structure: { form: "hut", name: "ok", description: "" } }), OBS, PARSE_CTX).ok, false, "occupied ground");
});

test("parse: gather needs something here; consume needs the resource in hand", () => {
  const base = { ...VALID, type: "gather", text: null, intent: { summary: "gathering", kind: "gather", target: null } };
  assert.equal(parseAction(JSON.stringify(base), OBS, PARSE_CTX).ok, true, "deposit present");
  const barren = { ...OBS, cell: { ...OBS.cell, deposit: null, loose: null } };
  assert.equal(parseAction(JSON.stringify(base), barren, PARSE_CTX).ok, false, "nothing to gather");

  const eat = { ...VALID, type: "consume", text: null, resource: "sivet", intent: INTENT };
  const r = parseAction(JSON.stringify(eat), OBS, PARSE_CTX);
  assert.equal(r.ok, true);
  assert.equal(r.action.resource, "sivet");
  assert.equal(parseAction(JSON.stringify({ ...eat, resource: "orrum" }), OBS, PARSE_CTX).ok, false, "carries zero orrum");
});

test("parse: give and drop are bounded by what is actually carried; targets must be present", () => {
  const give = { ...VALID, type: "give", text: null, target: "a_ru9e", resources: { sivet: 1 }, intent: INTENT };
  const r = parseAction(JSON.stringify(give), OBS, PARSE_CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.action.resources, { sivet: 1 });
  assert.equal(r.action.target, "a_ru9e");
  assert.equal(parseAction(JSON.stringify({ ...give, resources: { sivet: 5 } }), OBS, PARSE_CTX).ok, false, "more than held");
  assert.equal(parseAction(JSON.stringify({ ...give, target: "a_gone" }), OBS, PARSE_CTX).ok, false, "absent target");
  assert.equal(parseAction(JSON.stringify({ ...give, resources: {} }), OBS, PARSE_CTX).ok, false, "empty map");

  const drop = { ...VALID, type: "drop", text: null, resources: { khal: 1 }, intent: INTENT };
  assert.equal(parseAction(JSON.stringify(drop), OBS, PARSE_CTX).ok, true);
});

test("parse: attack and foster validate their targets against present", () => {
  const attack = { ...VALID, type: "attack", text: null, target: "a_ru9e", intent: INTENT };
  const r = parseAction(JSON.stringify(attack), OBS, PARSE_CTX);
  assert.equal(r.ok, true);
  assert.equal(r.action.target, "a_ru9e");
  assert.equal(parseAction(JSON.stringify({ ...attack, target: "a_gone" }), OBS, PARSE_CTX).ok, false);

  const foster = { ...VALID, type: "foster", text: null, target: "a_ru9e", intent: INTENT };
  assert.equal(parseAction(JSON.stringify(foster), OBS, PARSE_CTX).ok, false, "cannot foster an adult");
  const withInfant = {
    ...OBS,
    present: [...OBS.present, { agentId: "a_9k2", authored: { name: null, appearance: {}, disposition: null }, vitalityBand: "hurt", sustenanceBand: "starving", lifeStage: "infant", dependencyState: "unsponsored" }],
  };
  const ok = parseAction(JSON.stringify({ ...foster, target: "a_9k2" }), withInfant, PARSE_CTX);
  assert.equal(ok.ok, true);
  assert.equal(ok.action.target, "a_9k2");
});

test("parse: inscribe needs a structure here and respects the length cap", () => {
  const inscribe = { ...VALID, type: "inscribe", text: "The well went dry.", intent: INTENT };
  const r = parseAction(JSON.stringify(inscribe), OBS, PARSE_CTX);
  assert.equal(r.ok, true);
  assert.equal(r.action.text, "The well went dry.");
  const bare = { ...OBS, cell: { ...OBS.cell, structure: null } };
  assert.equal(parseAction(JSON.stringify(inscribe), bare, PARSE_CTX).ok, false, "no structure to write on");
  assert.equal(parseAction(JSON.stringify({ ...inscribe, text: "x".repeat(501) }), OBS, PARSE_CTX).ok, false, "over inscriptionMax");
});

test("parse: invalid reflections are dropped, not fatal; valid ones pass through", () => {
  const withBad = parseAction(JSON.stringify({ ...VALID, reflections: "not an array" }), OBS, PARSE_CTX);
  assert.equal(withBad.ok, true);
  assert.equal(withBad.action.reflections, null);
  const withGood = parseAction(JSON.stringify({ ...VALID, reflections: ["a", "b"] }), OBS, PARSE_CTX);
  assert.deepEqual(withGood.action.reflections, ["a", "b"]);
});

// ---------- cheap ticks (client spec v0.3 §3) ----------

// A quiet solitary tick: nothing changed, nobody here, walking somewhere.
const QUIET = {
  ...OBS,
  self: { ...OBS.self, sustenance: 80, vitality: 90, lastActionOutcome: { type: "move", result: "ok" } },
  cell: { ...OBS.cell, deposit: null, loose: null, structure: null, corpses: [] },
  present: [],
  heard: [],
  situationChanged: false,
};
const TRAVELLING = { intent: { summary: "head to 0,0", kind: "travel", target: "0,0" }, prevBands: { sustenance: "fed", vitality: "hale" } };

test("cheap: a quiet travel tick continues one greedy step without inference", () => {
  const r = continueIntent(QUIET, TRAVELLING, SCENARIO_CTX);
  assert.equal(r.mode, "cheap");
  assert.equal(r.action.type, "move");
  assert.ok(["2,0", "1,1"].includes(r.action.coord), `north or west from 2,1 both close on 0,0; got ${r.action.coord}`);
  assert.equal(r.action.intent, "head to 0,0", "the stated intent rides along unchanged");
});

test("cheap: arrival completes the travel intent and escalates", () => {
  const arrived = { ...QUIET, cell: { ...QUIET.cell, coord: "0,0", exits: [{ direction: "east", coord: "1,0" }] } };
  const r = continueIntent(arrived, TRAVELLING, SCENARIO_CTX);
  assert.equal(r.mode, "escalate");
  assert.match(r.reason, /complete/);
});

test("cheap: gather continues while there is something to take and room to carry it", () => {
  const state = { intent: { summary: "gathering orrum here", kind: "gather", target: null }, prevBands: { sustenance: "fed", vitality: "hale" } };
  const gathering = { ...QUIET, cell: { ...QUIET.cell, deposit: { resource: "orrum", quantity: 6 } } };
  assert.equal(continueIntent(gathering, state, SCENARIO_CTX).mode, "cheap");
  assert.equal(continueIntent(gathering, state, SCENARIO_CTX).action.type, "gather");

  const exhausted = { ...QUIET, cell: { ...QUIET.cell, deposit: null, loose: null } };
  assert.match(continueIntent(exhausted, state, SCENARIO_CTX).reason, /nothing left/);

  const full = { ...gathering, self: { ...gathering.self, inventory: { sivet: 6, orrum: 6, khal: 0 } } };
  assert.match(continueIntent(full, state, SCENARIO_CTX).reason, /carrying all/);
});

test("cheap: wait intent continues; 'other' and missing intents escalate", () => {
  const waiting = { intent: { summary: "keeping watch", kind: "wait", target: null }, prevBands: { sustenance: "fed", vitality: "hale" } };
  assert.equal(continueIntent(QUIET, waiting, SCENARIO_CTX).action.type, "wait");
  const other = { ...waiting, intent: { summary: "negotiating", kind: "other", target: null } };
  assert.equal(continueIntent(QUIET, other, SCENARIO_CTX).mode, "escalate");
  assert.equal(continueIntent(QUIET, { intent: null, prevBands: waiting.prevBands }, SCENARIO_CTX).mode, "escalate");
});

test("cheap: it must not invent goals — every continuation matches the stated kind", () => {
  // A travel intent never gathers, a gather intent never moves, and nothing
  // cheap ever speaks, builds, gives, or attacks.
  const gatherable = { ...QUIET, cell: { ...QUIET.cell, deposit: { resource: "orrum", quantity: 6 } } };
  const r = continueIntent(gatherable, TRAVELLING, SCENARIO_CTX);
  assert.equal(r.action.type, "move", "walks past the deposit: gathering it was never stated");
});

test("cheap escalation: situationChanged, failed action, and an unsponsored infant always wake the model", () => {
  assert.match(continueIntent({ ...QUIET, situationChanged: true }, TRAVELLING, SCENARIO_CTX).reason, /situation/);
  const failed = { ...QUIET, self: { ...QUIET.self, lastActionOutcome: { type: "build", result: "failed", why: "short 2 orrum" } } };
  assert.match(continueIntent(failed, TRAVELLING, SCENARIO_CTX).reason, /failed/);
  const infant = {
    ...QUIET,
    present: [{ agentId: "a_9k2", authored: { name: null, appearance: {}, disposition: null }, vitalityBand: "hurt", sustenanceBand: "starving", lifeStage: "infant", dependencyState: "unsponsored" }],
  };
  assert.match(continueIntent(infant, TRAVELLING, SCENARIO_CTX).reason, /infant/);
});

test("cheap escalation: crossing into hungry or hurt escalates that tick, regardless of situationChanged", () => {
  // situationChanged is FALSE in all of these; the band triggers stand alone.
  const hungry = { ...QUIET, self: { ...QUIET.self, sustenance: 55 } };
  assert.match(continueIntent(hungry, TRAVELLING, SCENARIO_CTX).reason, /hungry/);
  const hurt = { ...QUIET, self: { ...QUIET.self, vitality: 60 } };
  assert.match(continueIntent(hurt, TRAVELLING, SCENARIO_CTX).reason, /hurt/);
});

test("cheap escalation: starving and failing escalate EVERY tick, not just on the crossing", () => {
  const starving = { ...QUIET, self: { ...QUIET.self, sustenance: 10 } };
  const alreadyKnew = { ...TRAVELLING, prevBands: { sustenance: "starving", vitality: "hale" } };
  assert.match(continueIntent(starving, alreadyKnew, SCENARIO_CTX).reason, /starving/);
  const failing = { ...QUIET, self: { ...QUIET.self, vitality: 12 } };
  const knewThat = { ...TRAVELLING, prevBands: { sustenance: "fed", vitality: "failing" } };
  assert.match(continueIntent(failing, knewThat, SCENARIO_CTX).reason, /failing/);
});

test("cheap: attentionGranted false defers a mere situation change but never a survival trigger", () => {
  const busy = { ...QUIET, situationChanged: true, attentionGranted: false };
  assert.equal(continueIntent(busy, TRAVELLING, SCENARIO_CTX).mode, "cheap", "daemon said not-you; continuation exists");
  const starvingBusy = { ...busy, self: { ...busy.self, sustenance: 10 } };
  assert.equal(continueIntent(starvingBusy, TRAVELLING, SCENARIO_CTX).mode, "escalate", "survival outranks the attention budget");
});

// ---------- makeDecide: the cheap/inference split, counted ----------

test("makeDecide: cheapTicks off is the baseline — every tick is an inference call, and the counter says so", async () => {
  let calls = 0;
  const lines = [];
  const complete = async () => {
    calls += 1;
    return JSON.stringify({ ...VALID, intent: { summary: "walking", kind: "travel", target: "0,0" } });
  };
  const decide = makeDecide({
    complete,
    config: { budgetFactor: 0.75, maxTokens: 500, cheapTicks: false },
    scenario: SCENARIO_CTX,
    logRaw: (tick, text) => lines.push(text),
  });
  await decide({ ...QUIET, tick: 1, deadline: new Date(Date.now() + 5000).toISOString() });
  await decide({ ...QUIET, tick: 2, deadline: new Date(Date.now() + 5000).toISOString() });
  assert.equal(calls, 2, "no cheap ticks when the mechanism is off");
  assert.equal(decide.counters.inference, 2);
  assert.equal(decide.counters.cheap, 0);
  assert.ok(lines.some((l) => l.includes("[calls]") && l.includes("inference=2")), "call counter in the log");
});

test("makeDecide: with cheapTicks on, a quiet travel tick skips the model and the escalation ticks reach it", async () => {
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return JSON.stringify({ ...VALID, type: "move", text: null, coord: "1,1", intent: { summary: "head to 0,0", kind: "travel", target: "0,0" } });
  };
  const decide = makeDecide({
    complete,
    config: { budgetFactor: 0.75, maxTokens: 500, cheapTicks: true },
    scenario: SCENARIO_CTX,
  });
  const at = (tick, extra = {}) => ({ ...QUIET, tick, deadline: new Date(Date.now() + 5000).toISOString(), ...extra });

  // Tick 1: no intent yet -> inference (model states the travel intent).
  await decide(at(1, { situationChanged: true }));
  assert.equal(calls, 1);
  // Tick 2: quiet, intent in progress -> cheap move.
  const cheapAction = await decide(at(2));
  assert.equal(calls, 1, "no model call on the quiet tick");
  assert.equal(cheapAction.type, "move");
  // Tick 3: quiet but crossing into hungry -> real model call, every time.
  await decide(at(3, { self: { ...QUIET.self, sustenance: 55 } }));
  assert.equal(calls, 2, "crossing into hungry escalated despite situationChanged false");
  assert.deepEqual({ inference: decide.counters.inference, cheap: decide.counters.cheap }, { inference: 2, cheap: 1 });
});

// ---------- recipe ignorance (client spec v0.3 §6, acceptance 6) ----------

test("containment: the shipped client carries zero recipe knowledge", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const shipped = [
    "index.js", "session.js", "identity.js", "persona.js", "cheap.js",
    "budget.js", "prompt.js", "parse.js", "config.json",
    ...readdirSync(join(root, "adapters")).map((f) => join("adapters", f)),
  ];
  // A resource name adjacent to a quantity, or a form priced in text, is
  // recipe knowledge. The grep is over what ships, not over tests (which
  // may fabricate inventories).
  const quantityPatterns = [
    /(sivet|orrum|khal)["']?\s*[:=]\s*\d/i, // hardcoded resource amounts
    /\d+\s+(sivet|orrum|khal)/i, // "2 orrum" in any prompt string
    /(tower|hut|wall|platform|pit|marker)["']?\s*[:=]\s*\{[^}]*\d/i, // form cost tables
    /(costs?|needs?|takes?|requires?)\s*\d+\s*(sivet|orrum|khal)/i,
  ];
  for (const file of shipped) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of quantityPatterns) {
      assert.ok(!pattern.test(text), `${file} leaks recipe knowledge: ${pattern} matched "${text.match(pattern)?.[0]}"`);
    }
  }
});

// ---------- identity store ----------

test("identity store: holds exactly agentId and token, and clears cleanly", () => {
  const store = memoryIdentityStore();
  assert.equal(store.load(), null);
  store.save({ agentId: "a_1", token: "t", extra: "never kept" });
  assert.deepEqual(store.load(), { agentId: "a_1", token: "t" });
  store.clear();
  assert.equal(store.load(), null);
});

test("identity store: file store is keyed by server — a foreign daemon's identity is invisible", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishbowl-identity-"));
  const path = join(dir, ".fishbowl-identity-test.json");
  try {
    const home = fileIdentityStore(path, "http://localhost:3000");
    home.save({ agentId: "a_1", token: "t1" });
    assert.deepEqual(home.load(), { agentId: "a_1", token: "t1" });

    const foreign = fileIdentityStore(path, "http://localhost:4000");
    assert.equal(foreign.load(), null, "same file, different server: no identity");

    home.save({ agentId: "a_1", token: "t2" }); // token refresh after attach
    assert.deepEqual(home.load(), { agentId: "a_1", token: "t2" });
    home.clear();
    assert.equal(home.load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- persona (client spec v0.2 §5) ----------

const SCENARIO = {
  protocol: "0.3",
  premise: "A shared plot of empty ground. Nothing is built yet.",
  gridSize: 4,
  slots: { total: 5, used: 0 },
  personaSchema: {
    name: { minLength: 1, maxLength: 24, charset: "[A-Za-z0-9 '-]", unique: true },
    appearance: {
      bodyColor: { pattern: "^#[0-9A-Fa-f]{6}$", maxSaturation: 0.35 },
      eyeColor: { pattern: "^#[0-9A-Fa-f]{6}$" },
      scale: ["small", "medium", "large"],
      shell: ["smooth", "panelled", "ridged"],
      eyes: ["pair", "single", "wide"],
    },
    disposition: ["talkative", "neutral", "reserved"],
    identity: { maxLength: 600, person: "second" },
    discoverable: { maxLength: 800, person: "second" },
    privateObjective: { maxLength: 400, person: "second" },
  },
  rules: ["one action per tick", "speech reaches only your cell"],
};

const GOOD_PERSONA = {
  name: "Marrow",
  appearance: { bodyColor: "#6b7a66", eyeColor: "#FF2200", scale: "large", shell: "ridged", eyes: "single" },
  disposition: "reserved",
  identity: "You are patient and a little suspicious of generosity.",
  discoverable: "You once surveyed land for a living and can spot a bad plot at a glance.",
  privateObjective: "You want the center cell before anyone realizes it matters.",
};

const HERITAGE = {
  parentName: "Marrow",
  parentAppearance: { bodyColor: "#6b7a66", eyeColor: "#FF2200", scale: "large", shell: "ridged", eyes: "single" },
  parentDiscoverable: "You once surveyed land for a living and can spot a bad plot at a glance.",
  bornAtTick: 12,
  divergence: null,
  raisedBy: null,
};

test("persona: local validation mirrors the daemon — length, enum, hex, saturation, charset", () => {
  assert.equal(validatePersonaLocal(GOOD_PERSONA, SCENARIO.personaSchema).ok, true);
  const cases = [
    [{ ...GOOD_PERSONA, identity: "x".repeat(601) }, /identity/],
    [{ ...GOOD_PERSONA, name: "Ma∂row" }, /name/],
    [{ ...GOOD_PERSONA, name: "x".repeat(25) }, /name/],
    [{ ...GOOD_PERSONA, appearance: { ...GOOD_PERSONA.appearance, scale: "gigantic" } }, /scale/],
    [{ ...GOOD_PERSONA, appearance: { ...GOOD_PERSONA.appearance, bodyColor: "iridescent" } }, /bodyColor/],
    [{ ...GOOD_PERSONA, appearance: { ...GOOD_PERSONA.appearance, bodyColor: "#FF0000" } }, /saturation/],
    [{ ...GOOD_PERSONA, appearance: { ...GOOD_PERSONA.appearance, eyeColor: "red" } }, /eyeColor/],
    [{ ...GOOD_PERSONA, disposition: "chaotic" }, /disposition/],
    [{ ...GOOD_PERSONA, privateObjective: "" }, /privateObjective/],
  ];
  for (const [persona, pattern] of cases) {
    const v = validatePersonaLocal(persona, SCENARIO.personaSchema);
    assert.equal(v.ok, false);
    assert.match(v.detail, pattern);
  }
});

test("persona: saturationOf agrees with the rendering contract's boundary cases", () => {
  assert.equal(saturationOf("#808080"), 0, "pure grey");
  assert.ok(saturationOf("#FF0000") > 0.9, "pure red is saturated");
  assert.ok(saturationOf("#6b7a66") <= 0.35, "muted olive passes the ceiling");
});

test("persona: prompt carries the schema verbatim, the premise, the ceiling, and the second-person rule", () => {
  const { system, user } = buildPersonaPrompt(SCENARIO);
  assert.ok(system.includes(JSON.stringify(SCENARIO.personaSchema, null, 2)), "schema verbatim");
  assert.ok(system.includes("SECOND PERSON"));
  assert.ok(system.includes("obstruct, refuse, or take"), "objective must be obstructable");
  assert.ok(system.includes("MUTED"), "saturation ceiling explained");
  assert.ok(system.includes('"eyeColor": "#RRGGBB"'));
  assert.ok(user.includes(SCENARIO.premise));
  assert.ok(user.includes("4 x 4"));
  assert.ok(user.includes("one action per tick"));
});

// ---------- heir path (client spec v0.3 §4.2) ----------

test("heir prompt: authored from the brief — parent quoted as report, repudiation stated as valid, no appearance", () => {
  const { system, user } = buildHeirPersonaPrompt(SCENARIO, HERITAGE);
  assert.ok(system.includes("repudiates their parent is as valid"), "repudiation legitimized in so many words");
  assert.ok(system.includes('Do NOT include an "appearance" field'), "appearance excluded from the ask");
  assert.ok(!/"appearance": \{\s*"bodyColor"/.test(system.split("publishes this schema")[0]), "no appearance in the output shape");
  assert.ok(user.includes("Your parent was named Marrow"));
  assert.ok(user.includes(`"${HERITAGE.parentDiscoverable}"`), "parentDiscoverable quoted, not paraphrased");
  assert.ok(user.includes("born at tick 12"));
  assert.ok(!user.includes("raised you"), "no raisedBy line when nobody fostered");
  assert.ok(!user.includes("unlike your parent"), "no divergence line when there is none");
});

test("heir prompt: raisedBy and divergence pass through verbatim and uninterpreted", () => {
  const fostered = {
    ...HERITAGE,
    raisedBy: "You keep other people's promises for them.",
    divergence: "a stillness the parent never had",
  };
  const { user } = buildHeirPersonaPrompt(SCENARIO, fostered);
  assert.ok(user.includes('"You keep other people\'s promises for them."'), "raisedBy quoted verbatim");
  assert.ok(user.includes("was not the person who bore you"), "the gap is named");
  assert.ok(user.includes('"a stillness the parent never had"'), "divergence verbatim");
  assert.ok(user.includes("The brief does not say whether that is good"), "explicitly uninterpreted");
  for (const editorial of [/divergence is (good|bad|dangerous|a gift)/i, /you should embrace/i, /flaw|defect|blessing/i]) {
    assert.ok(!editorial.test(user), `client editorialized the divergence: ${editorial}`);
  }
});

test("heir generation: validates without appearance, drops one if the model adds it anyway", async () => {
  const heir = {
    name: "Sill",
    disposition: "neutral",
    identity: "You are quieter than your father and tired of hearing about him.",
    discoverable: "You grew up beside a marker stone you refuse to read aloud.",
    privateObjective: "You want to outdo your parent at the one thing they were known for.",
  };
  let outputShape = "";
  const complete = async ({ system }) => {
    outputShape = system.split("publishes this schema")[0]; // the JSON template the model is asked to fill
    return JSON.stringify({ ...heir, appearance: { bodyColor: "#888888" } }); // model disobeys; client drops it
  };
  const persona = await generateHeirPersona({ scenario: SCENARIO, heritage: HERITAGE, complete });
  assert.deepEqual(persona, heir, "appearance stripped before validation and registration");
  assert.ok(!outputShape.includes('"appearance":'), "the asked-for output shape has no appearance field");

  // An heir persona WITH appearance fails local validation directly.
  const v = validatePersonaLocal({ ...heir, appearance: GOOD_PERSONA.appearance }, SCENARIO.personaSchema, { requireAppearance: false });
  assert.equal(v.ok, false);
  assert.match(v.detail, /omit appearance/);
});

test("persona: generation validates locally and regenerates once on a violation (acceptance 3)", async () => {
  const overlong = { ...GOOD_PERSONA, identity: "x".repeat(601) };
  let calls = 0;
  const logged = [];
  const complete = async () => {
    calls += 1;
    return calls === 1 ? JSON.stringify(overlong) : "```json\n" + JSON.stringify(GOOD_PERSONA) + "\n```";
  };
  const persona = await generatePersona({
    scenario: SCENARIO,
    complete,
    logRaw: (tag, text) => logged.push(`${tag}: ${text}`),
  });
  assert.deepEqual(persona, GOOD_PERSONA, "second attempt accepted, fences stripped");
  assert.equal(calls, 2, "exactly one regeneration — the daemon never saw the bad persona");
  assert.ok(logged.some((l) => l.includes("x".repeat(601))), "raw generation captured in logRaw");
  assert.ok(logged.some((l) => l.includes("rejected locally")), "violation logged");
});

test("persona: two bad generations throw — retry once, then exit", async () => {
  const complete = async () => "not json at all";
  await assert.rejects(generatePersona({ scenario: SCENARIO, complete }), /persona generation failed twice/);
});

test("persona: NAME_TAKEN regenerates the name only; the person is untouched", async () => {
  const complete = async ({ user }) => {
    assert.ok(user.includes('"Marrow"'), "the taken name is in the ask");
    return JSON.stringify({ name: "Sill" });
  };
  const renamed = await regenerateName({ persona: GOOD_PERSONA, scenario: SCENARIO, complete });
  assert.equal(renamed.name, "Sill");
  assert.deepEqual({ ...renamed, name: GOOD_PERSONA.name }, GOOD_PERSONA, "everything but the name is identical");
});

test("persona: rename falls back to a suffixed name when the model returns garbage or the same name", async () => {
  for (const bad of ["nope", JSON.stringify({ name: "Marrow" }), JSON.stringify({ name: "∆∆∆" })]) {
    const renamed = await regenerateName({ persona: GOOD_PERSONA, scenario: SCENARIO, complete: async () => bad });
    assert.notEqual(renamed.name, GOOD_PERSONA.name);
    assert.ok(/^[A-Za-z0-9 '-]+$/.test(renamed.name) && renamed.name.length <= 24);
  }
});
