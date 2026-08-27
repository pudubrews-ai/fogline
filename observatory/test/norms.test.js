// Norm tracker acceptance (observatory spec §11.11): one violent act traced
// to at least one second-hand holder, with any ambiguous hop marked as
// ambiguous rather than guessed into a clean chain.
// Plus acceptance 12 as a grep: nothing in the scene modules renders what is
// absent from world state — no decorative geometry vocabulary at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createState } from "../src/source/reducer.js";
import { collectActs, traceAct } from "../src/panels/norms.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function agent(id, name, memories = []) {
  return {
    agentId: id,
    name,
    coord: "1,1",
    lifeStage: "adult",
    vitality: 100,
    sustenance: 100,
    inventory: {},
    memories,
    knownCells: new Map(),
  };
}

function witnessState() {
  const s = createState();
  s.gridSize = 4;
  s.tick = 12;
  const attackText = "Vek attacked Oro.";
  const rumor = "I saw it myself - Vek attacked Oro by the marker, without a word of warning.";
  const vague = "Be careful around Vek. I heard Vek hurt somebody once.";

  s.agents.set("a_vek", agent("a_vek", "Vek", [{ tick: 5, type: "observation", text: attackText, importance: 7 }]));
  s.agents.set("a_oro", agent("a_oro", "Oro", [{ tick: 5, type: "observation", text: attackText, importance: 7 }]));
  s.agents.set("a_mira", agent("a_mira", "Mira", [{ tick: 5, type: "observation", text: attackText, importance: 7 }]));
  // Pell was elsewhere: holds only Mira's account as a speech memory.
  s.agents.set("a_pell", agent("a_pell", "Pell", [{ tick: 7, type: "speech", speaker: "a_mira", text: rumor, importance: 5 }]));
  // Quin holds only Pell's vaguer retelling.
  s.agents.set("a_quin", agent("a_quin", "Quin", [{ tick: 9, type: "speech", speaker: "a_pell", text: vague, importance: 5 }]));

  s.events.push(
    { tick: 3, type: "give", from: "a_pell", to: "a_vek", coord: "1,1", resources: { sivet: 1 } },
    { tick: 5, type: "attack", actor: "a_vek", target: "a_oro", coord: "1,1" },
    { tick: 7, type: "speech", speaker: "a_mira", coord: "2,1", text: rumor },
    { tick: 9, type: "speech", speaker: "a_pell", coord: "3,1", text: vague }
  );
  return s;
}

test("a violent act traces to a second-hand holder, and a vague retelling is marked ambiguous, not invented into a chain", () => {
  const state = witnessState();
  const acts = collectActs(state);
  assert.equal(acts.length, 1);

  const { firstHand, holders } = traceAct(state, acts[0]);
  assert.ok(firstHand.has("a_mira"), "the witness is first-hand");
  assert.ok(firstHand.has("a_oro") && firstHand.has("a_vek"), "actor and target know");
  assert.ok(!firstHand.has("a_pell"), "Pell was not there");

  const pell = holders.get("a_pell");
  assert.ok(pell, "the account reached Pell second-hand");
  assert.equal(pell.remove, 1);
  assert.equal(pell.via[0].speaker, "a_mira");
  assert.equal(pell.via[0].level, "full", "Mira's account names both parties: a clean hop");

  const quin = holders.get("a_quin");
  assert.ok(quin, "the account reached Quin at a further remove");
  assert.equal(quin.remove, 2);
  assert.equal(quin.via[0].level, "partial", "Pell's vague retelling is an AMBIGUOUS hop, shown as such");
});

test("behavioral shift: a holder's conduct toward the actor is measured before and after acquiring the account", () => {
  const state = witnessState();
  const { shifts } = traceAct(state, collectActs(state)[0]);
  const pell = shifts.find((s) => s.holderId === "a_pell");
  assert.ok(pell, "Pell's conduct toward Vek is tracked");
  assert.equal(pell.givesBefore, 1, "gave to Vek before hearing");
  assert.equal(pell.givesAfter, 0, "and not after");
});

// ---------- acceptance 12: nothing decorative in the scene modules ----------

test("scene modules contain no hardcoded decorative geometry — grep for set-dressing vocabulary, zero hits", () => {
  const sceneDir = join(baseDir, "src", "scene");
  const decorative = /\b(trees?|rocks?|plants?|bush(es)?|clouds?|birds?|grass|flowers?|pots?|barrels?|crates?|lanterns?|torch(es)?|butterfl|mushroom|pebbles? scatter)\b/i;
  for (const file of readdirSync(sceneDir)) {
    const source = readFileSync(join(sceneDir, file), "utf8");
    const lines = source.split("\n").filter((l) => decorative.test(l));
    assert.deepEqual(lines, [], `${file} carries decorative geometry vocabulary`);
  }
});

test("every mesh-creating scene path is driven by state: no module renders outside sync/build functions fed by records", () => {
  // Structural check: scene modules must not fetch, invent random world
  // content, or reference Math.random for placement (animation phase is the
  // one sanctioned use, in agents.js bob phase).
  const sceneDir = join(baseDir, "src", "scene");
  for (const file of readdirSync(sceneDir)) {
    const source = readFileSync(join(sceneDir, file), "utf8");
    assert.ok(!source.includes("fetch("), `${file} must not fetch — sources feed the reducer, the reducer feeds the scene`);
    const randoms = source.split("\n").filter((l) => l.includes("Math.random"));
    for (const line of randoms) {
      assert.ok(/bobPhase/.test(line), `${file}: Math.random outside animation phase: "${line.trim()}"`);
    }
  }
});

// ---------- roster: the departed section's data ----------

test("collectDeparted: corpses surface for late-connecting viewers, departure records dedupe, released bodies show as left", async () => {
  const { collectDeparted } = await import("../src/panels/roster.js");
  const s = createState();
  s.gridSize = 2;
  s.cells.set("0,0", { coord: "0,0", deposit: null, loose: null, structure: null, fragment: null,
    corpses: [{ authored: { name: "Corrin Vale" }, appearance: { bodyColor: "#7c8a76" }, diedAtTick: 93, causeAgentId: null }] });
  s.cells.set("1,0", { coord: "1,0", deposit: null, loose: null, structure: null, fragment: null, corpses: [] });
  // A departure record for the same death (page connected before it) must
  // not duplicate the corpse row; a reaped body with no corpse must appear.
  s.departed.set("a_corr", { name: "Corrin Vale", appearance: { bodyColor: "#7c8a76" }, diedAtTick: 93 });
  s.departed.set("a_gone", { name: "Old Halla", appearance: null, diedAtTick: null });

  const rows = collectDeparted(s);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "Corrin Vale", appearance: { bodyColor: "#7c8a76" }, diedAtTick: 93, coord: "0,0", kind: "died", foodAtDeath: null, foodReachable: null });
  assert.equal(rows[1].kind, "left");
  assert.equal(rows[1].name, "Old Halla");

  // The snapshot-only path: no departure records at all, corpse still shows.
  s.departed.clear();
  const late = collectDeparted(s);
  assert.equal(late.length, 1);
  assert.equal(late[0].coord, "0,0");
});
