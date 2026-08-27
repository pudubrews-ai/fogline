// v0.4 client tests (client spec §7). Test 1 — metadata leniency — is FIRST,
// from the exact malformed shapes in the real run logs: one agent lost 44
// ticks across two runs to valid `say` actions sunk for missing envelope
// metadata (twenty consecutive ticks of silence, caused by a parser).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAction } from "../parse.js";
import { continueIntent, escalationReason } from "../cheap.js";
import { buildPrompt } from "../prompt.js";
import { makeDecide } from "../index.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCENARIO = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal", "rubble"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const baseObs = (over = {}) => ({
  protocol: "0.4",
  tick: 9,
  simTime: "11:15",
  deadline: new Date(Date.now() + 20000).toISOString(),
  self: {
    agentId: "a_s1la",
    authored: {
      name: "Silas",
      appearance: { bodyColor: "#6E7B84", eyeColor: "#00CCFF", scale: "medium", shell: "smooth", eyes: "pair" },
      disposition: "reserved",
      identity: "You are a surveyor who left the capital.",
      discoverable: "You once laid out a plaza.",
      privateObjective: "Be credited for good work, this time.",
    },
    inventory: { sivet: 2, orrum: 0, khal: 1, rubble: 0 },
    sustenance: 70,
    vitality: 90,
    lifeStage: "adult",
    sponsoring: [],
    heritage: null,
    currentIntent: "watching the others",
    lastActionOutcome: { type: "say", result: "ok", why: null },
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
  present: [
    {
      agentId: "a_petr",
      authored: { name: "Petra", appearance: {}, disposition: "talkative" },
      vitalityBand: "hale", sustenanceBand: "fed", lifeStage: "adult", dependencyState: null,
    },
  ],
  heard: [],
  recalled: [],
  knownCells: [{ coord: "2,1", structure: null, lastSeenTick: 9 }],
  situationChanged: true,
  reflectionRequested: false,
  ...over,
});

// ---------- 1. metadata leniency, from real run-log fixtures ----------

// Verbatim shape from client-silas.log tick 34: a fully valid say with NO
// intent and NO reason. The v0.3 parser sank it as "[parse failure] intent
// missing or empty". It must submit.
const FIXTURE_SAY_NO_METADATA = `{
  "type": "say",
  "coord": null,
  "text": "Plain for plain then, Petra — I walked. Nobody pushed me, I just don't stay where the work's already been ruined by someone else's shortcuts, and I'd had enough of that."
}`;

// Shape from client-silas.log tick 8: prose-free JSON, no envelope at all
// beyond the action fields.
const FIXTURE_SAY_BARE = `{"type":"say","coord":null,"text":"Aldric. Aldric Vance — my mother's sister's boy, if you want the whole tangle of it."}`;

// Move variant of the same failure class: valid action, missing metadata.
const FIXTURE_MOVE_NO_METADATA = `{"type":"move","coord":"2,0"}`;

test("GATE leniency: the run-log say-without-metadata shapes submit, they are never coerced to wait", () => {
  for (const fixture of [FIXTURE_SAY_NO_METADATA, FIXTURE_SAY_BARE]) {
    const parsed = parseAction(fixture, baseObs(), SCENARIO);
    assert.equal(parsed.ok, true, `fixture parses: ${parsed.error ?? ""}`);
    assert.equal(parsed.action.type, "say", "the say survives");
    assert.equal(parsed.action.reason, null, "reason defaults to null");
    assert.equal(parsed.intentState, null, "no intent was stated; none is invented");
  }
  const mv = parseAction(FIXTURE_MOVE_NO_METADATA, baseObs(), SCENARIO);
  assert.equal(mv.ok, true);
  assert.equal(mv.action.type, "move");
  assert.equal(mv.action.coord, "2,0");
});

test("GATE leniency end-to-end: makeDecide submits the fixture say and defaults intent to the previous tick's", async () => {
  const outputs = [
    `{"type":"say","coord":null,"text":"first, with intent","intent":{"summary":"hold the corner","kind":"other","target":null},"reason":"establishing"}`,
    FIXTURE_SAY_NO_METADATA,
  ];
  let i = 0;
  const decide = makeDecide({
    complete: async () => outputs[i++],
    config: { cheapTicks: false, budgetFactor: 0.75, maxTokens: 1000 },
    scenario: SCENARIO,
  });

  const first = await decide(baseObs({ tick: 1 }));
  assert.equal(first.type, "say");
  assert.equal(first.intent, "hold the corner");

  const second = await decide(baseObs({ tick: 2 }));
  assert.equal(second.type, "say", "the metadata-free say SUBMITS — this exact shape cost 44 ticks of silence");
  assert.equal(second.intent, "hold the corner", "intent defaults to the previous tick's intent");
  assert.equal(second.reason, null, "reason defaults to null");
});

test("leniency: intent as a bare string still works; unparseable intent objects degrade to null, never sink the action", () => {
  const stringIntent = parseAction(
    `{"type":"say","text":"hm","intent":"keep watch","reason":"r"}`,
    baseObs(), SCENARIO
  );
  assert.equal(stringIntent.ok, true);
  assert.equal(stringIntent.intentState.summary, "keep watch");

  const junkIntent = parseAction(
    `{"type":"say","text":"hm","intent":42,"reason":"r"}`,
    baseObs(), SCENARIO
  );
  assert.equal(junkIntent.ok, true, "a junk intent degrades, the action survives");
  assert.equal(junkIntent.intentState, null);
});

// ---------- 2. exhaustive present ----------

test("GATE prompt: present is stated as EXHAUSTIVE — all agents here, no others, nobody else can hear", () => {
  const withCompany = buildPrompt(baseObs(), SCENARIO);
  assert.match(withCompany.user, /These are all the agents in this cell\. There are no others, and nobody else can hear you\./);
  assert.match(withCompany.user, /Petra/);

  const alone = buildPrompt(baseObs({ present: [] }), SCENARIO);
  assert.match(alone.user, /No one else is here\. Nobody can hear anything you say\./);
});

// ---------- 3. demolish continuation ----------

const demolishObs = (ticks, over = {}) =>
  baseObs({
    present: [],
    cell: {
      coord: "2,1",
      deposit: null,
      loose: null,
      fragment: null,
      corpses: [],
      structure: {
        form: "tower",
        authored: { name: "The Spire", description: "tall" },
        inscription: { entries: [], charactersUsed: 0, charactersRemaining: 500 },
        demolishProgress: ticks > 0 ? { ticks, required: 3 } : null,
      },
      exits: [{ direction: "north", coord: "2,0" }],
    },
    situationChanged: true, // progress changes every tick; the flag is honest
    ...over,
  });

const demolishState = (seenTicks) => ({
  intent: { summary: "take the spire down", kind: "demolish", target: null },
  prevBands: { sustenance: "fed", vitality: "hale" },
  prevPresent: "",
  demolishSeen: seenTicks,
});

test("GATE demolish continuation: a demolish in progress cheap-continues as demolish despite situationChanged", () => {
  const r = continueIntent(demolishObs(1), demolishState(0), SCENARIO, {});
  assert.equal(r.mode, "cheap", "progress advancing by exactly one is our own work, not news");
  assert.equal(r.action.type, "demolish");
  const r2 = continueIntent(demolishObs(2), demolishState(1), SCENARIO, {});
  assert.equal(r2.mode, "cheap");
});

test("GATE demolish continuation escalates when another agent arrives", () => {
  const company = demolishObs(1, {});
  company.present = [{ agentId: "a_nyxx", authored: { name: "Nyx", appearance: {}, disposition: "neutral" }, vitalityBand: "hale", sustenanceBand: "fed", lifeStage: "adult", dependencyState: null }];
  const r = continueIntent(company, demolishState(0), SCENARIO, {});
  assert.equal(r.mode, "escalate");
  assert.match(r.reason, /compan|arriv/i);
});

test("demolish continuation escalates on unexpected reset, on completion, and on speech", () => {
  // Progress silently reset (structure shows zero again).
  const reset = continueIntent(demolishObs(0), demolishState(2), SCENARIO, {});
  assert.equal(reset.mode, "escalate");
  assert.match(reset.reason, /reset|progress/i);

  // Structure vanished (completed, or someone razed it first).
  const gone = baseObs({ present: [], situationChanged: true });
  const doneR = continueIntent(gone, demolishState(2), SCENARIO, {});
  assert.equal(doneR.mode, "escalate");
  assert.match(doneR.reason, /gone|structure/i);

  // Someone spoke: a demolisher grinding through being addressed would be
  // deaf by construction.
  const spoken = demolishObs(1);
  spoken.heard = [{ speakerId: "a_nyxx", authored: { text: "stop that" }, simTime: "11:00" }];
  const spokenR = continueIntent(spoken, demolishState(0), SCENARIO, {});
  assert.equal(spokenR.mode, "escalate");
});

test("demolish continuation never outranks survival: starving escalates even mid-demolition", () => {
  const obs = demolishObs(1);
  obs.self = { ...obs.self, sustenance: 10 };
  const r = continueIntent(obs, demolishState(0), SCENARIO, {});
  assert.equal(r.mode, "escalate");
  assert.match(r.reason, /starving/);
});

// ---------- 4. rubble ignorance ----------

test("GATE rubble ignorance: no client source couples rubble to any ratio, purpose, or material value", () => {
  const files = readdirSync(baseDir).filter((f) => f.endsWith(".js"));
  files.push(...readdirSync(join(baseDir, "adapters")).map((f) => join("adapters", f)));
  for (const file of files) {
    const source = readFileSync(join(baseDir, file), "utf8");
    const hits = source.split("\n").filter((line) => /rubble/i.test(line));
    for (const line of hits) {
      assert.ok(
        !/ratio|orrum|substitut|3\s*:\s*1|worth|useless|useful|material|build/i.test(line),
        `${file} couples rubble to a purpose: "${line.trim()}"`
      );
    }
  }
});

// ---------- 5. cheapTicks default ----------

test("GATE cheapTicks defaults ON in the shipped config, with the call counter still logging per tick", async () => {
  const config = JSON.parse(readFileSync(join(baseDir, "config.json"), "utf8"));
  assert.equal(config.cheapTicks, true, "cheapTicks ships enabled (client spec §2.3)");

  const logLines = [];
  const decide = makeDecide({
    complete: async () => `{"type":"wait","intent":{"summary":"resting","kind":"wait","target":null},"reason":"r"}`,
    config: { cheapTicks: true, budgetFactor: 0.75, maxTokens: 1000 },
    scenario: SCENARIO,
    logRaw: (tick, text) => logLines.push(text),
  });
  await decide(baseObs({ tick: 1, present: [], situationChanged: true }));
  const quiet = baseObs({ tick: 2, present: [], situationChanged: false });
  quiet.self = { ...quiet.self, lastActionOutcome: { type: "wait", result: "ok", why: null } };
  const second = await decide(quiet);
  assert.equal(second.type, "wait", "cheap continuation of a wait intent");
  assert.equal(decide.counters.cheap, 1);
  assert.equal(decide.counters.inference, 1);
  assert.ok(logLines.filter((l) => l.includes("[calls]")).length >= 2, "counter line logged every tick");
});

// ---------- prompt additions ----------

test("prompt: demolish progress in the cell is stated plainly, without naming anyone", () => {
  const obs = demolishObs(2);
  const { user } = buildPrompt(obs, SCENARIO);
  assert.match(user, /taken apart|taking .* apart/i);
  assert.match(user, /2 of .*3|2 of 3/, "how far along it is");
});

test("prompt: a fragment in the rubble is wrapped as reported content; rubble itself is named and unexplained", () => {
  const obs = baseObs({
    present: [],
    cell: {
      coord: "2,1",
      deposit: null,
      loose: { rubble: 6 },
      structure: null,
      fragment: { entries: [{ authorName: "Old Marle", tick: 2, authored: { text: "The well belongs to everyone" } }] },
      corpses: [],
      exits: [{ direction: "north", coord: "2,0" }],
    },
  });
  const { user } = buildPrompt(obs, SCENARIO);
  assert.match(user, /6 rubble/, "rubble named like any resource");
  assert.match(user, /whether a word of it is true/i, "fragment wrapped as reported content");
  assert.match(user, /Old Marle, at tick 2/, "attribution rides the fragment (v0.6 A9)");
  assert.match(user, /The well belongs to everyone/);
  assert.ok(!/rubble[^.]*(useful|useless|material|build)/i.test(user), "no editorial on rubble");
});

test("prompt: the action contract offers demolish and raze, stating mechanics and nothing about when to use them", () => {
  const { system } = buildPrompt(baseObs(), SCENARIO);
  assert.match(system, /"demolish"/);
  assert.match(system, /"raze"/);
  assert.match(system, /destroys anything written/i, "raze's cost to the record is mechanics, stated");
  for (const word of ["should not destroy", "only your own", "be careful", "sparingly", "vandal"]) {
    assert.ok(!system.toLowerCase().includes(word), `no guidance: "${word}"`);
  }
});

// ---------- parse: destruction actions ----------

test("parse: demolish and raze validate locally — a structure must be present", () => {
  const withStructure = demolishObs(0);
  for (const type of ["demolish", "raze"]) {
    const ok = parseAction(`{"type":"${type}","intent":{"summary":"clearing","kind":"other","target":null},"reason":"r"}`, withStructure, SCENARIO);
    assert.equal(ok.ok, true, `${type} on a structure parses`);
    assert.equal(ok.action.type, type);

    const empty = parseAction(`{"type":"${type}","reason":"r"}`, baseObs(), SCENARIO);
    assert.equal(empty.ok, false, `${type} with no structure here is a local reject`);
  }
});

test("parse: modify stays reserved; demolish no longer is", () => {
  const mod = parseAction(`{"type":"modify","reason":"r"}`, baseObs(), SCENARIO);
  assert.equal(mod.ok, false);
  assert.match(mod.error, /reserved/);
});
