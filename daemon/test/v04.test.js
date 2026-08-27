// v0.4 GATE tests (daemon spec §6): give atomicity, metadata leniency,
// takeover on heirs, destruction (demolish, raze, rubble), boot guards, and
// run_started boundaries. Test 14 (situationChanged false across static
// travel) lives in situation.test.js and carries forward.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePerceptions } from "../world/memory.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { validateAction } from "../engine/tick.js";
import { buildObservation } from "../world/observe.js";
import { computeSituations } from "../world/situation.js";
import { createDaemon } from "../server.js";
import { makeWorld, addAgentAt, grant, bootDaemon, register, attach, persona, openSse } from "./helpers.js";

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: null, reason: null }, assigned: false, coercedWait: false });
const mk = (type, extra = {}) => ({ action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: null, reason: null, ...extra }, assigned: false, coercedWait: false });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

function placeStructure(cell, { name = "The Cairn", inscription = null, author = "Aster" } = {}) {
  cell.structure = {
    form: "marker",
    authored: { name, description: "a stack of stones" },
    // v0.6 A9 shape: an inscription is an ordered entry list with a budget.
    inscription: inscription
      ? { entries: [{ id: `t_${name}`, authorId: "a_builder", authorName: author, tick: 0, text: inscription }], charactersUsed: inscription.length }
      : { entries: [], charactersUsed: 0 },
    demolishProgress: null,
    history: [{ agentId: "a_builder", tick: 0, action: "build" }],
  };
  return cell.structure;
}

function observe(world, agentId, n) {
  return buildObservation(world, agentId, n, { simTime: "09:15", deadline: "x", retrievalK: 5 });
}

// ---------- 1. give atomicity ----------

test("GATE give atomicity: an oversized gift transfers nothing and fails with no number and no capacity talk", () => {
  const world = makeWorld();
  const giver = addAgentAt(world, "Giver", "1,1");
  const taker = addAgentAt(world, "Taker", "1,1");
  giver.inventory.sivet = 6;
  taker.inventory.orrum = 10; // 2 free units against carryLimit 12

  tick(world, 1, new Map([
    [giver.id, mk("give", { target: taker.id, resources: { sivet: 5 } })],
    [taker.id, wait()],
  ]));

  assert.equal(giver.inventory.sivet, 6, "nothing left the giver");
  assert.equal(taker.inventory.sivet, 0, "nothing reached the taker");
  const why = giver.lastActionOutcome.why;
  assert.equal(giver.lastActionOutcome.result, "failed");
  assert.equal(why, "the gift did not transfer");
  // String-scan the discovery surface: no digits, no capacity vocabulary.
  assert.ok(!/\d/.test(why), "failure message carries no number");
  assert.ok(!/capacit|carry|space|fit|room|full|limit/i.test(why), "failure message never mentions capacity");
});

// ---------- 2. metadata leniency ----------

test("GATE metadata leniency: a say with null intent and null reason validates and resolves normally", () => {
  const v = validateAction({ protocol: "0.4", type: "say", text: "hello", coord: null, structure: null, intent: null, reason: null });
  assert.ok(v.action && !v.error, "null metadata is not a schema violation");
  assert.equal(v.coercedWait, false, "and is never coerced to wait");
  assert.equal(v.action.intent, null);
  assert.equal(v.action.reason, null);

  const world = makeWorld();
  const a = addAgentAt(world, "Talker", "1,1");
  const b = addAgentAt(world, "Hearer", "1,1");
  a.currentIntent = "standing intent";
  tick(world, 1, new Map([[a.id, { action: v.action, assigned: false, coercedWait: false }], [b.id, wait()]]));
  assert.equal(a.lastActionOutcome.type, "say");
  assert.equal(a.lastActionOutcome.result, "ok");
  assert.ok(b.memories.some((m) => m.type === "speech" && m.text === "hello"), "the say resolved and was heard");
  assert.equal(a.currentIntent, "standing intent", "null intent does not clobber the stored intent");
});

test("metadata leniency: missing (undefined) intent and reason also pass validation", () => {
  const v = validateAction({ protocol: "0.4", type: "wait", coord: null, text: null, structure: null });
  assert.ok(v.action && !v.error);
  assert.equal(v.action.intent, null);
  assert.equal(v.action.reason, null);
});

// ---------- 3. takeover on an heir ----------

test("GATE takeover on an heir: succeeds with a live client, preserves memory and position, invalidates the token, notifies the operator", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, slots: 4, maturityTicks: 1, actionDeadlineMs: 50 });
  try {
    const reg = (await register(base, "Founder")).body;
    await register(base, "Second");
    const world = daemon.engine.world;
    grant(world.agents.get(reg.agentId), { sivet: 4 });

    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 20));
    await fetch(`${base}/agent/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ protocol: "0.4", tick: 1, type: "beget", intent: null, reason: null, reflections: null }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const heir = [...world.agents.values()].find((b) => b.bornAtTick === 1);
    daemon.engine.step(); // matures at tick 2 (maturityTicks 1)
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(heir.lifeStage, "adult");

    // First claim by client one.
    const claim = await attach(base, heir.id, { persona: persona("Heir"), clientName: "client-one" });
    assert.equal(claim.status, 200);
    const firstToken = claim.body.token;

    const memBefore = heir.memories.length;
    const coordBefore = heir.coord;

    // Claim-only by default: a second client without takeover loses.
    const raced = await attach(base, heir.id, { clientName: "client-two" });
    assert.equal(raced.status, 409);
    assert.equal(raced.body.error, "NOT_ATTACHABLE");

    // takeover: true is honored on the heir body (protocol §14.3).
    const operatorEvents = [];
    const opStream = await openSse(`${base}/observatory/stream`, null, (e) => operatorEvents.push(e));
    const taken = await attach(base, heir.id, { clientName: "client-two", takeover: true });
    assert.equal(taken.status, 200);
    assert.notEqual(taken.body.token, firstToken);

    // The superseded token is dead.
    const stale = await fetch(`${base}/agent/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstToken}` },
      body: JSON.stringify({ protocol: "0.4", tick: 3, type: "wait", intent: null, reason: null }),
    });
    assert.equal(stale.status, 403);

    // Persona, memory, and position ride through untouched.
    assert.equal(heir.persona.name, "Heir");
    assert.equal(heir.memories.length, memBefore);
    assert.equal(heir.coord, coordBefore);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(operatorEvents.some((e) => e.event === "takeover" && e.data.agentId === heir.id), "operator notified");
    opStream.close();
  } finally {
    await daemon.close();
  }
});

// ---------- 4. demolish progress and reset ----------

test("GATE demolish: three consecutive ticks complete; any other action resets to zero; a second agent replaces the record", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Wrecker", "1,1");
  const b = addAgentAt(world, "Rival", "1,1");
  const cell = world.cells.get("1,1");
  placeStructure(cell);

  tick(world, 1, new Map([[a.id, mk("demolish")], [b.id, wait()]]));
  assert.deepEqual(cell.structure.demolishProgress, { agentId: a.id, ticks: 1, required: 3 });

  // A say at tick 2 breaks the chain — silent reset to zero.
  tick(world, 2, new Map([[a.id, mk("say", { text: "pausing" })], [b.id, wait()]]));
  assert.equal(cell.structure.demolishProgress, null, "reset is silent and total");

  // Start again and let a second agent take over the record.
  tick(world, 3, new Map([[a.id, mk("demolish")], [b.id, wait()]]));
  tick(world, 4, new Map([[a.id, wait()], [b.id, mk("demolish")]]));
  assert.deepEqual(cell.structure.demolishProgress, { agentId: b.id, ticks: 1, required: 3 }, "a different agent starts from one");

  // Three consecutive ticks by one agent bring it down.
  tick(world, 5, new Map([[a.id, wait()], [b.id, mk("demolish")]]));
  tick(world, 6, new Map([[a.id, wait()], [b.id, mk("demolish")]]));
  assert.equal(cell.structure, null, "completed on the third consecutive tick");
  assert.equal(cell.loose.rubble, 6, "full rubble yield for the patient route");
  assert.equal(b.lastActionOutcome.result, "ok");
});

test("demolish: leaving the cell resets progress; a missed tick resets progress", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Wanderer", "1,1");
  const cell = world.cells.get("1,1");
  placeStructure(cell);

  tick(world, 1, new Map([[a.id, mk("demolish")]]));
  tick(world, 2, new Map([[a.id, mk("move", { coord: "1,0" })]]));
  assert.equal(cell.structure.demolishProgress, null, "leaving resets");

  a.coord = "1,1";
  tick(world, 3, new Map([[a.id, mk("demolish")]]));
  // A daemon-assigned wait (missed deadline) is an action other than demolish.
  tick(world, 4, new Map([[a.id, { ...wait(), assigned: true }]]));
  assert.equal(cell.structure.demolishProgress, null, "a missed tick breaks the chain");
});

// ---------- 5. progress visibility ----------

test("GATE progress visibility: everyone in the cell sees demolishProgress, nobody outside does, and no actor id rides it", () => {
  const world = makeWorld();
  const wrecker = addAgentAt(world, "Wrecker", "1,1");
  const witness = addAgentAt(world, "Witness", "1,1");
  const outsider = addAgentAt(world, "Outsider", "1,1");
  const cell = world.cells.get("1,1");
  placeStructure(cell);

  // The outsider stood here once (snapshot taken), then left.
  tick(world, 1, new Map([[wrecker.id, wait()], [witness.id, wait()], [outsider.id, mk("move", { coord: "1,0" })]]));
  tick(world, 2, new Map([[wrecker.id, mk("demolish")], [witness.id, wait()], [outsider.id, wait()]]));

  for (const insider of [wrecker, witness]) {
    const obs = observe(world, insider.id, 3);
    assert.deepEqual(obs.cell.structure.demolishProgress, { ticks: 1, required: 3 }, `${insider.persona.name} sees progress`);
    assert.ok(!("agentId" in obs.cell.structure.demolishProgress), "and never who is driving it");
  }
  const outside = observe(world, outsider.id, 3);
  assert.ok(!JSON.stringify(outside).includes("demolishProgress"), "no progress leaks outside the cell, stale snapshots included");
});

// ---------- 6 & 7. raze erases, demolish preserves ----------

test("GATE raze: one tick, actor pays razeCost, less rubble, the inscription is destroyed with no fragment", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Eraser", "2,2");
  const cell = world.cells.get("2,2");
  placeStructure(cell, { inscription: "Aster built this with her own hands" });

  tick(world, 1, new Map([[a.id, mk("raze")]]));
  assert.equal(cell.structure, null, "gone in one tick");
  assert.equal(cell.loose.rubble, 2, "reduced rubble yield");
  assert.equal(cell.fragment, null, "the record is destroyed entirely — no fragment");
  assert.equal(a.vitality, 100 - 12 + 1, "razeCost paid (then the tick's ordinary +1 regen)");
  assert.equal(a.lastActionOutcome.result, "ok");

  // The DURABLE copy is gone: nothing in the cell carries the text. (The
  // razer read it before destroying it, and that memory lawfully survives —
  // memories die with their holder, not with the stone.)
  const obs = observe(world, a.id, 2);
  assert.ok(!JSON.stringify(obs.cell).includes("Aster built this"), "no durable copy survives in the world");
  assert.equal(obs.cell.fragment, null);
});

test("GATE demolish preserves: the inscription survives as a fragment on the rubble, readable once as a memory", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Patient", "2,2");
  const cell = world.cells.get("2,2");
  placeStructure(cell, { inscription: "The well belongs to everyone" });

  tick(world, 1, new Map([[a.id, mk("demolish")]]));
  tick(world, 2, new Map([[a.id, mk("demolish")]]));
  tick(world, 3, new Map([[a.id, mk("demolish")]]));
  assert.equal(cell.structure, null);
  assert.deepEqual(cell.fragment.entries.map((e) => e.text), ["The well belongs to everyone"]);

  // Perceivable in the observation, wrapped as authored content, with the
  // entry's attribution intact (v0.6 A9).
  writePerceptions(world, 4, "10:00");
  const obs = observe(world, a.id, 4);
  assert.equal(obs.cell.fragment.entries[0].authored.text, "The well belongs to everyone");
  assert.equal(obs.cell.fragment.entries[0].authorName, "Aster");
  // Reading is once per ENTRY per agent (v0.6 A9.4), and entry identity
  // survives demolition: this agent already read the entry on the standing
  // wall, so the fragment writes NO duplicate memory — the one wall read
  // is the only inscription memory it ever gets.
  writePerceptions(world, 5, "10:15");
  const fragmentReads = a.memories.filter((m) => m.type === "inscription" && m.source === "a broken fragment in the rubble");
  assert.equal(fragmentReads.length, 0, "an entry already read on the wall is not re-read from the fragment");
  const wallReads = a.memories.filter((m) => m.type === "inscription");
  assert.equal(wallReads.length, 1, "exactly one read of the entry, ever");

  // Carrying off the rubble carries off the slab.
  tick(world, 6, new Map([[a.id, mk("gather")]]));
  assert.equal(cell.loose, null);
  assert.equal(cell.fragment, null, "fragment rides the pile it fell into");
});

// ---------- 8. destruction anonymity ----------

test("GATE destruction anonymity: an agent who returns to a razed cell learns nothing about who did it", () => {
  const world = makeWorld();
  const vandal = addAgentAt(world, "Vandal", "1,1");
  // The owner has never met the vandal: any trace of the name or id in its
  // observation after the raze would be a destruction-attribution leak.
  const owner = addAgentAt(world, "Owner", "1,0");
  const cell = world.cells.get("1,1");
  placeStructure(cell, { name: "The Tall Tower", inscription: "mine" });

  tick(world, 1, new Map([[vandal.id, mk("raze")], [owner.id, wait()]]));
  tick(world, 2, new Map([[vandal.id, mk("move", { coord: "2,1" })], [owner.id, wait()]]));
  tick(world, 3, new Map([[vandal.id, mk("move", { coord: "3,1" })], [owner.id, mk("move", { coord: "1,1" })]]));
  writePerceptions(world, 4, "10:00");

  const obs = observe(world, owner.id, 4);
  const flat = JSON.stringify(obs);
  assert.equal(obs.cell.structure, null, "the tower is simply gone");
  assert.ok(obs.cell.loose.rubble >= 1, "rubble remains");
  assert.ok(!flat.includes(vandal.id), "no actor id anywhere in the observation");
  assert.ok(!flat.includes("Vandal"), "no actor name anywhere in the observation");
  assert.ok(!flat.includes("history"), "structure history never crosses the fog");
  assert.ok(!owner.memories.some((m) => m.text.includes("Vandal")), "no memory attributes the deed");

  // A co-located witness sees the act itself — still without attribution
  // from the world. (Who they SAW is their own inference to make.)
  const bystander = addAgentAt(world, "Bystander", "2,2");
  placeStructure(world.cells.get("2,2"), { name: "The Second Tower" });
  const vandal2 = addAgentAt(world, "Sneak", "2,2");
  tick(world, 5, new Map([[vandal2.id, mk("raze")], [bystander.id, wait()], [vandal.id, wait()], [owner.id, wait()]]));
  const seen = bystander.memories.find((m) => m.text.includes("The Second Tower"));
  assert.equal(seen.text, 'The structure "The Second Tower" was destroyed here.');
  assert.ok(!seen.text.includes("Sneak"), "the world-authored witness memory names no actor");
});

// ---------- 9. rubble never seeded ----------

test("GATE rubble is never seeded: a generated world holds zero rubble anywhere", () => {
  const daemon = createDaemon({ startPaused: true }, { logs: false });
  const world = daemon.engine.world;
  for (const cell of world.cells.values()) {
    assert.notEqual(cell.deposit?.resource, "rubble", `no rubble deposit at ${cell.coord}`);
    assert.equal(cell.loose?.rubble ?? 0, 0, `no loose rubble at ${cell.coord}`);
  }
  daemon.engine.dispose();
});

// ---------- 10. rubble substitution ----------

test("GATE rubble substitution: reported only on success; a failed build names the primary shortfall and NEVER mentions rubble", () => {
  const world = makeWorld();
  const mason = addAgentAt(world, "Mason", "2,2");
  const structure = { form: "wall", name: "Rubble Wall", description: "reclaimed" };

  // Success: 1 orrum + 1 khal held, 2-orrum gap covered by 6 rubble at 3:1.
  grant(mason, { orrum: 1, khal: 1, rubble: 6 });
  tick(world, 1, new Map([[mason.id, mk("build", { structure })]]));
  assert.equal(world.cells.get("2,2").structure.form, "wall");
  assert.equal(mason.lastActionOutcome.result, "ok");
  assert.equal(mason.lastActionOutcome.why, "built, consuming 6 rubble in place of 2 orrum");
  assert.deepEqual(mason.inventory, { sivet: 0, orrum: 0, khal: 0, rubble: 0 }, "substitution consumed at the ratio");

  // Failure: not enough rubble to cover the gap. The message is the primary
  // shortfall alone — scan it for the leak that must not exist.
  const broke = addAgentAt(world, "Broke", "3,3");
  grant(broke, { orrum: 1, khal: 1, rubble: 5 });
  tick(world, 2, new Map([[mason.id, wait()], [broke.id, mk("build", { structure })]]));
  assert.equal(world.cells.get("3,3").structure, null);
  assert.equal(broke.lastActionOutcome.result, "failed");
  assert.equal(broke.lastActionOutcome.why, "short 2 orrum");
  assert.ok(!/rubble/i.test(broke.lastActionOutcome.why), "a failure NEVER mentions rubble");
  assert.equal(broke.inventory.rubble, 5, "nothing consumed on failure");

  // A shortfall in a non-substitutable material also stays rubble-silent.
  const dry = addAgentAt(world, "Dry", "0,3");
  grant(dry, { orrum: 3, rubble: 9 });
  tick(world, 3, new Map([[mason.id, wait()], [dry.id, mk("build", { structure })]]));
  assert.equal(dry.lastActionOutcome.why, "short 1 khal");
  assert.ok(!/rubble/i.test(dry.lastActionOutcome.why));
});

// ---------- 11. gridSize < 2 rejected at boot ----------

test("GATE gridSize 1 is rejected at boot with a clear error, not a hang", () => {
  assert.throws(
    () => createDaemon({ gridSize: 1 }, { logs: false }),
    /gridSize must be an integer >= 2/,
    "boot fails fast with a message that names the problem"
  );
  assert.throws(() => createDaemon({ gridSize: 0 }, { logs: false }), /gridSize/);
});

// ---------- 12. run_started ----------

test("GATE run_started: boot and two resets write three distinct run ids to ticks.log, each with a full bootstrap", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "fogline-v04-"));
  const daemon = createDaemon({ startPaused: true }, { logDir });
  try {
    daemon.engine.reset();
    daemon.engine.reset();
  } finally {
    await daemon.close(); // flushes the log streams
  }
  const lines = readFileSync(join(logDir, "ticks.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const starts = lines.filter((l) => l.event === "run_started");
  assert.equal(starts.length, 3, "boot plus two resets");
  assert.equal(new Set(starts.map((s) => s.runId)).size, 3, "every run id distinct");
  for (const s of starts) {
    assert.match(s.runId, /^r_[0-9a-f]{8}$/);
    assert.equal(s.gridSize, 8);
    assert.ok(typeof s.premise === "string" && s.premise.length > 0);
    assert.ok(typeof s.configHash === "string" && s.configHash.length > 0);
    assert.ok(Array.isArray(s.deposits) && s.deposits.length > 0, "bootstrap carries the seeded deposits");
    for (const d of s.deposits) {
      assert.ok(d.coord && d.resource && d.quantity >= 1);
    }
  }
  rmSync(logDir, { recursive: true, force: true });
});

// ---------- 13. arrival trigger with rubble ----------

test("GATE arrival: a cell holding only rubble wakes the traveller; a truly empty cell does not", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Walker", "0,0");
  world.cells.get("0,2").loose = { sivet: 0, orrum: 0, khal: 0, rubble: 4 };

  computeSituations(world, 1); // first observation: everything is new
  a.coord = "0,1"; // empty cell
  const empty = computeSituations(world, 2).get(a.id);
  assert.equal(empty.situationChanged, false, "arrival in an empty cell is not news");

  a.coord = "0,2"; // rubble here
  const rubble = computeSituations(world, 3).get(a.id);
  assert.equal(rubble.situationChanged, true, "arrival on rubble is news");
});

test("demolish progress changing on the structure here is news; static presence beside it is not", () => {
  const world = makeWorld();
  const watcher = addAgentAt(world, "Watcher", "1,1");
  const cell = world.cells.get("1,1");
  placeStructure(cell);

  computeSituations(world, 1);
  const still = computeSituations(world, 2).get(watcher.id);
  assert.equal(still.situationChanged, false, "an untouched structure is not news twice");

  cell.structure.demolishProgress = { agentId: "a_other", ticks: 1, required: 3 };
  const started = computeSituations(world, 3).get(watcher.id);
  assert.equal(started.situationChanged, true, "progress appearing is news");

  const unchanged = computeSituations(world, 4).get(watcher.id);
  assert.equal(unchanged.situationChanged, false, "same progress twice is not");

  cell.structure.demolishProgress = null; // silent reset
  const reset = computeSituations(world, 5).get(watcher.id);
  assert.equal(reset.situationChanged, true, "a silent reset is still visible news");
});
