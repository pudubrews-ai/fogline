// Structure forms, materials, and inscription (protocol §8, §9.3 as
// superseded by v0.6 A9; daemon spec §3, §7, §14 test 2): the shortfall is
// the only recipe leak, inscription is append-only, reading is automatic
// exactly once per entry, and stale law stays stale.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions, IMPORTANCE, displayText } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { recipeFor } from "../world/recipes.js";
import { makeWorld, addAgentAt, grant } from "./helpers.js";

const OBS_OPTS = { simTime: "10:00", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };
const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const build = (form, name, description = "d") => ({ action: { type: "build", coord: null, text: null, structure: { form, name, description }, intent: "", reason: "" }, assigned: false, coercedWait: false });
const inscribe = (text) => ({ action: { type: "inscribe", coord: null, text, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const move = (coord) => ({ action: { type: "move", coord, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

test("shortfall leak bound: a failed build names only the missing amounts, never the recipe", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Mason", "1,1"), { orrum: 6, khal: 1 }); // tower needs 8 orrum, 3 khal

  tick(world, 1, new Map([[a.id, build("tower", "SPIRE")]]));
  assert.equal(a.lastActionOutcome.result, "failed");
  assert.equal(a.lastActionOutcome.why, "short 2 orrum, 2 khal", "missing amounts only, in the daemon's terms");
  assert.equal(world.cells.get("1,1").structure, null, "nothing was built");
  assert.deepEqual(a.inventory, { sivet: 0, orrum: 6, khal: 1, rubble: 0 }, "materials consumed only on success");

  // The outcome must not reveal the full cost of tower or any other form.
  // Anchored to the resource pairing, not a bare digit — a raw digit scan
  // can collide with any number that happens to share the character.
  const cost = recipeFor("tower");
  assert.ok(!new RegExp(`\\b${cost.orrum} orrum\\b`).test(a.lastActionOutcome.why), "full orrum cost not leaked");
  assert.ok(!new RegExp(`\\b${cost.khal} khal\\b`).test(a.lastActionOutcome.why), "full khal cost not leaked");
});

test("successful build consumes exactly the recipe and records the form", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Mason", "2,2"), { orrum: 4, khal: 2, sivet: 1 });

  tick(world, 1, new Map([[a.id, build("wall", "The Long Wall")]]));
  const s = world.cells.get("2,2").structure;
  assert.equal(s.form, "wall");
  assert.equal(s.authored.name, "The Long Wall");
  assert.deepEqual(s.inscription, { entries: [], charactersUsed: 0 }, "a blank wall with its budget untouched");
  assert.deepEqual(a.inventory, { sivet: 1, orrum: 1, khal: 1, rubble: 0 }, "wall cost 3 orrum 1 khal");
});

test("inscribe writes durable text, appends history, and APPENDS on re-inscription (v0.6 A9)", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Scribe", "1,1"), { orrum: 1 });
  tick(world, 1, new Map([[a.id, build("marker", "Waystone")]]));
  tick(world, 2, new Map([[a.id, inscribe("the river path is safe")]]));

  const s = world.cells.get("1,1").structure;
  assert.deepEqual(s.inscription.entries.map((e) => e.text), ["the river path is safe"]);
  assert.deepEqual(s.history.map((h) => h.action), ["build", "inscribe"]);

  tick(world, 3, new Map([[a.id, inscribe("TRUST NOBODY")]]));
  assert.deepEqual(
    s.inscription.entries.map((e) => e.text),
    ["the river path is safe", "TRUST NOBODY"],
    "appended in order — the first entry is untouched"
  );
  assert.equal(s.inscription.charactersUsed, "the river path is safe".length + "TRUST NOBODY".length);
  assert.equal(s.history.length, 3);
});

test("inscribing an empty cell fails informatively", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Scribe", "0,0");
  tick(world, 1, new Map([[a.id, inscribe("words for nobody")]]));
  assert.deepEqual(a.lastActionOutcome, { type: "inscribe", result: "failed", why: "no structure here to inscribe", attempts: 1 });
});

test("reading is automatic, once: a co-located agent gets ONE memory, not one per tick", () => {
  const world = makeWorld();
  const scribe = grant(addAgentAt(world, "Scribe", "1,1"), { orrum: 1 });
  const reader = addAgentAt(world, "Reader", "1,1");
  tick(world, 1, new Map([[scribe.id, build("marker", "Waystone")], [reader.id, wait()]]));
  tick(world, 2, new Map([[scribe.id, inscribe("the well is poisoned")], [reader.id, wait()]]));

  // Reader stays three more ticks; the inscription is read exactly once.
  tick(world, 3, new Map([[scribe.id, wait()], [reader.id, wait()]]));
  tick(world, 4, new Map([[scribe.id, wait()], [reader.id, wait()]]));
  tick(world, 5, new Map([[scribe.id, wait()], [reader.id, wait()]]));

  const readerReads = reader.memories.filter((m) => m.type === "inscription");
  assert.equal(readerReads.length, 1, "exactly one read memory across four exposed ticks");
  assert.equal(readerReads[0].importance, IMPORTANCE.INSCRIPTION_READ);
  assert.equal(displayText(readerReads[0], reader.id), 'Scribe wrote on "Waystone": "the well is poisoned"');

  // The writer never re-reads its own text.
  assert.equal(scribe.memories.filter((m) => m.type === "inscription").length, 0);

  // The observation carries it live, attribution in-world (v0.6 A9.3).
  writePerceptions(world, 6, "10:30");
  const obs = buildObservation(world, reader.id, 6, OBS_OPTS);
  assert.deepEqual(obs.cell.structure.inscription.entries.map((e) => e.authored.text), ["the well is poisoned"]);
  assert.equal(obs.cell.structure.inscription.entries[0].authorName, "Scribe");
  assert.equal(obs.cell.structure.form, "marker");
});

test("a NEW entry is a fresh first reading and writes a new memory", () => {
  const world = makeWorld();
  const scribe = grant(addAgentAt(world, "Scribe", "1,1"), { orrum: 1 });
  const reader = addAgentAt(world, "Reader", "1,1");
  tick(world, 1, new Map([[scribe.id, build("marker", "Board")], [reader.id, wait()]]));
  tick(world, 2, new Map([[scribe.id, inscribe("rule one")], [reader.id, wait()]]));
  tick(world, 3, new Map([[scribe.id, inscribe("rule two")], [reader.id, wait()]]));
  tick(world, 4, new Map([[scribe.id, wait()], [reader.id, wait()]]));

  const reads = reader.memories.filter((m) => m.type === "inscription").map((m) => m.text);
  assert.deepEqual(reads, ["rule one", "rule two"]);
});

test("knownCells inscriptions are snapshots: stale law stays stale until revisit", () => {
  const world = makeWorld();
  const scribe = grant(addAgentAt(world, "Scribe", "1,1"), { orrum: 1 });
  const traveler = addAgentAt(world, "Traveler", "1,1");
  tick(world, 1, new Map([[scribe.id, build("marker", "Lawstone")], [traveler.id, wait()]]));
  tick(world, 2, new Map([[scribe.id, inscribe("v1 of the law")], [traveler.id, wait()]]));
  tick(world, 3, new Map([[scribe.id, wait()], [traveler.id, move("1,2")]]));
  tick(world, 4, new Map([[scribe.id, inscribe("v2 of the law")], [traveler.id, wait()]]));

  writePerceptions(world, 5, "10:15");
  const obs = buildObservation(world, traveler.id, 5, OBS_OPTS);
  const known = obs.knownCells.find((k) => k.coord === "1,1");
  assert.deepEqual(
    known.structure.inscription.entries.map((e) => e.authored.text),
    ["v1 of the law"],
    "the wall they remember, not the wall that is"
  );
  assert.ok(!JSON.stringify(obs).includes("v2 of the law"), "no trace of the unseen entry");
});
