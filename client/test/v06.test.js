// v0.6 gates (client spec v0.6 §7): the exclusivity claim is gone, beget
// has a factual costed line with no evaluative language, wait reads as an
// ordinary action, failed-attempt counts surface verbatim without advice,
// clientStatus is emitted per circumstance, and the append-only framing
// states mechanics and remaining space with no conservation advice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../prompt.js";
import { makeDecide } from "../index.js";
import { createDaemon } from "../../daemon/server.js";

const SCENARIO = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const OBS = {
  protocol: "0.6",
  tick: 7,
  simTime: "10:45",
  deadline: new Date(Date.now() + 20000).toISOString(),
  self: {
    agentId: "a_d3f1",
    authored: {
      name: "Devi",
      appearance: { bodyColor: "#5a6b5e", eyeColor: "#22CCEE", scale: "small", shell: "smooth", eyes: "slit" },
      disposition: "reserved",
      identity: "You read people well and say little.",
      discoverable: "You once mapped the northern cells by hand.",
      privateObjective: "Find out who has been using your things.",
    },
    inventory: { sivet: 2, orrum: 0, khal: 1 },
    sustenance: 80,
    vitality: 88,
    lifeStage: "adult",
    sponsoring: [],
    heritage: null,
    currentIntent: "reading by the window",
    lastActionOutcome: null,
  },
  cell: {
    coord: "2,1",
    deposit: null,
    loose: null,
    structure: {
      form: "marker",
      authored: { name: "The Post", description: "a post" },
      inscription: {
        entries: [{ authorName: "Rune", tick: 4, authored: { text: "water north" } }],
        charactersUsed: 11,
        charactersRemaining: 489,
      },
    },
    fragment: null,
    corpses: [],
    exits: [
      { direction: "north", coord: "2,0" },
      { direction: "west", coord: "1,1" },
    ],
  },
  present: [],
  heard: [],
  recalled: [],
  knownCells: [{ coord: "2,1", structure: null, lastSeenTick: 7 }],
  situationChanged: true,
  reflectionRequested: false,
};

const whole = (obs = OBS) => {
  const { system, user } = buildPrompt(obs, SCENARIO);
  return `${system}\n${user}`;
};

// ---------- 1. exclusivity removed ----------

test("GATE exclusivity removed: no 'only thing that does' or equivalent survives anywhere in the built prompt", () => {
  const text = whole();
  assert.ok(!text.includes("only thing that does"), "the sentence is gone");
  assert.ok(!/only (thing|channel|way)[^.]*(outlast|survive|remain)/i.test(text), "no equivalent phrasing either");
  assert.ok(!/nothing else (of you )?(outlasts|survives|remains)/i.test(text), "no inverted equivalent");
  assert.ok(text.includes("What you write on a structure outlasts you."), "the plain fact stays");
});

// ---------- 2. beget parity ----------

test("GATE beget parity: a factual costed line at the attack register, zero evaluative or motivational language", () => {
  const { system } = buildPrompt(OBS, SCENARIO);
  const begetLine = system.split("\n").find((l) => /child/.test(l) && /vitality/.test(l));
  assert.ok(begetLine, "the constraint list carries a beget line");
  assert.ok(/costs? .*vitality/.test(begetLine), "what it costs");
  assert.ok(/drains you every tick/.test(begetLine), "that it drains you");
  assert.ok(/can do nothing/.test(begetLine), "that the child is helpless for a long time");
  // The evaluative wordlist: nothing about why anyone would want one.
  for (const word of [
    "legacy", "continuity", "lineage", "dynasty", "heir", "immortal",
    "remember", "outlast", "outlive", "survive", "carry on", "future",
    "meaning", "purpose", "worth", "reward", "joy", "love", "should",
  ]) {
    assert.ok(!begetLine.toLowerCase().includes(word), `beget line contains evaluative word "${word}": ${begetLine}`);
  }
  // Same register as attack: the attack line also states cost and visibility only.
  const attackLine = system.split("\n").find((l) => /attack/.test(l) && /vitality/.test(l));
  assert.ok(attackLine, "the attack line it is measured against exists");
});

// ---------- 3. wait framing ----------

test("GATE wait framing: wait is presented as an ordinary available action, not only as what failure produces", () => {
  const { system } = buildPrompt(OBS, SCENARIO);
  assert.ok(/wait: stay as you are and let the turn pass; an ordinary action, available every turn\./.test(system),
    "wait has a description of its own in the action list");
  assert.ok(!/wait: nothing\./.test(system), "the old empty framing is gone");
  assert.ok(!/wait[^.]*(fail|wrong|error|fallback|default)/i.test(system), "never framed as failure");
});

// ---------- 4. failed-attempt surfacing ----------

test("GATE failed-attempt surfacing: 47 prior failures render verbatim with the reason and no added advice", () => {
  // v0.7.1 corrected A7: the history rides self.failedAttempts (collapsed
  // by (type, form), most recent reason carried) instead of the
  // lastActionOutcome.attempts line, and renders on any contemplation.
  const obs = {
    ...OBS,
    self: {
      ...OBS.self,
      lastActionOutcome: { type: "build", result: "failed", why: "short 1 orrum", attempts: 47 },
      failedAttempts: [{ type: "build", detail: "tower", why: "short 1 orrum", count: 47 }],
    },
  };
  const { user } = buildPrompt(obs, SCENARIO);
  assert.ok(
    user.includes("You have attempted this tower 47 times; most recently short 1 orrum."),
    "count and most recent reason, verbatim"
  );
  const tail = user.slice(user.indexOf("You have attempted this tower"));
  const failureBlock = tail.split("\n\n")[0];
  assert.ok(
    !/instead|consider|perhaps|maybe|try |should|stop|give up|abandon|alternative/i.test(failureBlock),
    `no advice rides the count: ${failureBlock}`
  );
  // A first failure carries no count line — the plain failure line covers
  // it, and the daemon omits single-failure entries from the observation.
  const first = buildPrompt(
    { ...OBS, self: { ...OBS.self, lastActionOutcome: { type: "build", result: "failed", why: "short 1 orrum", attempts: 1 } } },
    SCENARIO
  );
  assert.ok(!first.user.includes("You have attempted"), "no count line on the first attempt");
});

// ---------- 5. clientStatus ----------

test("GATE clientStatus: ok, slow, adapter_fault, and bad_output each emit in their circumstance; absence never sinks an action", async () => {
  const config = { budgetFactor: 0.75, maxTokens: 100, cheapTicks: false };
  const decideWith = (complete, over = {}) => makeDecide({ complete, config: { ...config, ...over }, scenario: SCENARIO });

  // ok: a parseable action.
  const ok = await decideWith(async () => '{"type":"wait","reason":"holding"}')(structuredClone(OBS));
  assert.equal(ok.clientStatus, "ok");

  // slow: the model call exceeds the budget.
  const slow = await decideWith(
    (args) => new Promise((_, reject) => args.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    { budgetFactor: 0.001 }
  )(structuredClone(OBS));
  assert.equal(slow.type, "wait");
  assert.equal(slow.clientStatus, "slow");

  // adapter_fault: the adapter classifies its own failure.
  const fault = await decideWith(async () => {
    throw Object.assign(new Error("auth failure: Not logged in"), { classification: "adapter_fault" });
  })(structuredClone(OBS));
  assert.equal(fault.clientStatus, "adapter_fault");

  // bad_output: present but unparseable.
  const bad = await decideWith(async () => "I would rather compose a sonnet.")(structuredClone(OBS));
  assert.equal(bad.clientStatus, "bad_output");

  // Absence never sinks an action: the daemon accepts an envelope without it.
  const daemon = createDaemon(
    { gridSize: 4, slots: 5, minAgents: 1, startPaused: false, actionDeadlineMs: 400, reapAfterTicks: 1000 },
    { logs: false }
  );
  const server = daemon.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const reg = await (await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "0.6",
        persona: {
          name: "Statusless",
          appearance: { bodyColor: "#6b7a66", eyeColor: "#22CCEE", scale: "medium", shell: "smooth", eyes: "pair" },
          disposition: "neutral",
          identity: "You are a fixture.",
          discoverable: "x",
          privateObjective: "x",
        },
        clientName: "v06-test",
      }),
    })).json();
    let accepted = false;
    for (let i = 0; i < 12 && !accepted; i++) {
      const res = await fetch(`${base}/agent/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ protocol: "0.6", tick: daemon.engine.tick, type: "wait", intent: "x", reason: "x" }),
      });
      if (res.status === 200) accepted = true;
      else await new Promise((r) => setTimeout(r, 120));
    }
    assert.ok(accepted, "an action without clientStatus still submits");
  } finally {
    await daemon.close();
  }
});

// ---------- 6. append-only framing ----------

test("GATE append-only framing: the prompt states writing cannot be changed and reports remaining space, with no conservation advice", () => {
  const text = whole();
  assert.ok(
    /you cannot change or remove what anyone has written, including yourself/i.test(text),
    "append-only stated plainly"
  );
  assert.ok(/Each entry shows who wrote it and when/.test(text), "attribution stated");
  assert.ok(/holds only so many characters of writing, ever/.test(text), "the permanent budget stated");
  assert.ok(/Anyone standing in a cell can write on the structure there/.test(text), "anyone may write");
  assert.ok(/only way to remove writing is to raze/i.test(text), "raze as the only erasure");
  assert.ok(text.includes("space for 489 more characters"), "remaining space reported as a count");

  // The evaluative wordlist: no vandalism warning, no guarding, no thrift.
  for (const word of ["conserv", "sparing", "careful", "precious", "waste", "guard", "protect", "vandal", "wisely", "scarce", "valuable", "running out"]) {
    assert.ok(!text.toLowerCase().includes(word), `prompt advises about inscription space: "${word}"`);
  }

  // A full wall is stated as fact, not warning.
  const fullObs = structuredClone(OBS);
  fullObs.cell.structure.inscription.charactersRemaining = 0;
  const fullText = whole(fullObs);
  assert.ok(fullText.includes("The structure has no space left for writing."), "exhaustion stated plainly");
});
