// Beget, heritage, infancy, maturation, fostering, orphans (protocol §11,
// daemon spec §9, §14 tests 9-11). The orphan test is load-bearing: it
// asserts the ABSENCE of a daemon-assigned guardian.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt, grant, bootDaemon, register, attach, persona } from "./helpers.js";

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const mk = (type, extra = {}) => ({ action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: "", reason: "", ...extra }, assigned: false, coercedWait: false });

function tick(world, n, actions = new Map()) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

function begetInfant(world, parent, n = 1) {
  grant(parent, { sivet: 4 });
  tick(world, n, new Map([[parent.id, mk("beget")]]));
  return [...world.agents.values()].find((b) => b.lifeStage === "infant" && b.sponsorId === parent.id);
}

test("beget: costs vitality and resources, needs a free slot, infant lands in the parent's cell", () => {
  const world = makeWorld({ slots: 3 });
  const parent = addAgentAt(world, "Parent", "1,1", {
    discoverable: "PARENT-DISCOVERABLE tends a garden",
    privateObjective: "SECRET-PARENT-OBJECTIVE hoard sivet",
  });
  const infant = begetInfant(world, parent);

  assert.ok(infant, "infant exists");
  assert.equal(infant.coord, "1,1");
  assert.equal(infant.persona, null, "no persona: no name, no identity, no objective");
  assert.equal(infant.lifeStage, "infant");
  assert.equal(infant.bornAtTick, 1);
  assert.equal(world.slots.used, 2, "the infant holds a slot");
  assert.equal(parent.vitality, 100 - 20 - 1 + 1, "begetVitalityCost paid; sponsor drain starts this tick; +1 regen");
  assert.equal(parent.inventory.sivet, 0, "begetResourceCost consumed");
  assert.deepEqual(parent.lastActionOutcome, { type: "beget", result: "ok", why: null });

  // Heritage brief: snapshotted at birth, nature only, no private tier.
  assert.equal(infant.heritage.parentName, "Parent");
  assert.equal(infant.heritage.parentDiscoverable, "PARENT-DISCOVERABLE tends a garden");
  assert.equal(infant.heritage.bornAtTick, 1);
  assert.equal(infant.heritage.raisedBy, null);
  assert.ok(!JSON.stringify(infant.heritage).includes("SECRET-PARENT-OBJECTIVE"), "privateObjective never in a brief");
});

test("beget fails without a slot (WORLD_FULL) or without the resources, and costs nothing then", () => {
  const world = makeWorld({ slots: 1 });
  const parent = grant(addAgentAt(world, "Cramped", "0,0"), { sivet: 4 });
  tick(world, 1, new Map([[parent.id, mk("beget")]]));
  assert.deepEqual(parent.lastActionOutcome, { type: "beget", result: "failed", why: "WORLD_FULL", attempts: 1 });
  assert.equal(parent.inventory.sivet, 4, "no cost on failure");

  const world2 = makeWorld({ slots: 3 });
  const broke = addAgentAt(world2, "Broke", "0,0");
  tick(world2, 1, new Map([[broke.id, mk("beget")]]));
  assert.deepEqual(broke.lastActionOutcome, { type: "beget", result: "failed", why: "short 4 sivet", attempts: 1 });
});

test("heritage snapshots at BIRTH: the parent's later changes never reach the brief", () => {
  const world = makeWorld({ slots: 3 });
  const parent = addAgentAt(world, "Shifty", "1,1");
  const infant = begetInfant(world, parent);
  const briefBefore = JSON.stringify(infant.heritage);

  // The parent's body changes; a frozen persona cannot, but appearance in the
  // brief must be the birth-time copy, not a live reference.
  assert.notEqual(infant.heritage.parentAppearance, parent.appearance, "copy, not reference");
  assert.equal(JSON.stringify(infant.heritage), briefBefore);
});

test("infant: immobile, drains its sponsor every tick, dies of nothing else while sponsored", () => {
  const world = makeWorld({ slots: 3 });
  const parent = addAgentAt(world, "Parent", "2,2");
  const infant = begetInfant(world, parent);
  const vitalityAfterBirth = parent.vitality;

  tick(world, 2, new Map([[parent.id, wait()]]));
  tick(world, 3, new Map([[parent.id, wait()]]));
  assert.equal(infant.coord, "2,2", "infants do not move");
  assert.equal(parent.vitality, vitalityAfterBirth - 2 + 2, "sponsor drain 1/tick offset by regen 1/tick while fed");
  assert.equal(infant.vitality, 100, "a sponsored infant holds steady");
});

test("orphan: sponsor dies, nobody present — the infant decays and dies UNFOSTERED", () => {
  const world = makeWorld({ slots: 3 });
  // Maturity far out: this test is about the orphan timer, not the race
  // between the timer and coming of age (that race is config's business).
  world.lineage.maturityTicks = 100;
  const parent = addAgentAt(world, "Doomed", "3,3");
  const infant = begetInfant(world, parent);

  // The sponsor dies alone with the child.
  parent.vitality = 0;
  tick(world, 2, new Map([[parent.id, wait()]]));
  assert.equal(world.agents.has(parent.id), false);
  assert.equal(infant.sponsorId, null, "unsponsored at the sponsor's death");
  assert.equal(infant.unsponsoredAtTick, 2);

  // Nobody is present, and nobody comes. orphanDamagePerTick 4 against
  // vitality 100: the child dies on a timer, unwitnessed.
  let n = 2;
  while (world.agents.has(infant.id) && n < 60) {
    n += 1;
    tick(world, n);
    // THE hard constraint (protocol §11.5): no daemon-assigned guardian, no
    // nearest-agent fallback, no grace. Sponsorship never returns on its own.
    assert.equal(infant.sponsorId, null, "no daemon-assigned guardian, ever");
  }
  assert.equal(world.agents.has(infant.id), false, "the orphan died");
  assert.ok(n < 60, "on a timer, not never");
  const corpse = world.cells.get("3,3").corpses.find((c) => c.authored.name === null);
  assert.ok(corpse, "an unnamed corpse in an empty corner");
  assert.equal(world.slots.used, 0, "both slots freed");
});

test("foster: a present agent assumes sponsorship; the brief gains raisedBy; the drain moves", () => {
  const world = makeWorld({ slots: 4 });
  const parent = addAgentAt(world, "Parent", "1,1");
  const stranger = addAgentAt(world, "Stranger", "1,1", { discoverable: "STRANGER-WAYS you mend things" });
  const infant = begetInfant(world, parent);

  parent.vitality = 0;
  tick(world, 2, new Map([[parent.id, wait()], [stranger.id, wait()]]));
  assert.equal(infant.sponsorId, null);

  tick(world, 3, new Map([[stranger.id, mk("foster", { target: infant.id })]]));
  assert.equal(infant.sponsorId, stranger.id);
  assert.equal(infant.unsponsoredAtTick, null);
  assert.equal(infant.heritage.raisedBy, "STRANGER-WAYS you mend things", "nurture appended from the fosterer");
  assert.deepEqual(stranger.lastActionOutcome, { type: "foster", result: "ok", why: null });

  // Fostering a sponsored infant, or from another cell, fails.
  const far = addAgentAt(world, "Far", "3,3");
  tick(world, 4, new Map([[stranger.id, wait()], [far.id, mk("foster", { target: infant.id })]]));
  assert.equal(far.lastActionOutcome.result, "failed");
});

test("maturation: at bornAtTick + maturityTicks the body is an attachable adult with its map at home", () => {
  const world = makeWorld({ slots: 3 });
  world.lineage.maturityTicks = 3;
  const parent = addAgentAt(world, "Parent", "1,1");
  const infant = begetInfant(world, parent);

  tick(world, 2, new Map([[parent.id, wait()]]));
  tick(world, 3, new Map([[parent.id, wait()]]));
  assert.equal(infant.lifeStage, "infant", "not yet");
  tick(world, 4, new Map([[parent.id, wait()]]));
  assert.equal(infant.lifeStage, "adult", "of age at bornAtTick + maturityTicks");
  assert.equal(infant.persona, null, "still unclaimed");
  assert.ok(infant.knownCells.has("1,1"), "its map begins where it grew up");
});

test("HTTP: infants are NOT_ATTACHABLE; matured bodies list in /scenario and attach with an authored persona, appearance ignored", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, slots: 4, maturityTicks: 1, actionDeadlineMs: 50 });
  try {
    const reg = (await register(base, "Founder")).body;
    await register(base, "Second");
    const world = daemon.engine.world;
    const founder = world.agents.get(reg.agentId);
    grant(founder, { sivet: 4 });

    // Tick 1: Founder begets over HTTP-driven engine stepping.
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 20));
    await fetch(`${base}/agent/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ protocol: "0.3", tick: 1, type: "beget", intent: "lineage", reason: "test", reflections: null }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const infant = [...world.agents.values()].find((b) => b.bornAtTick === 1);
    assert.ok(infant, "infant begotten");
    assert.equal(daemon.engine.lastObservationFor(infant.id), null, "infants receive no observation");
    assert.equal(infant.connection.token, null, "and generate no client traffic — no token exists for them");

    // Unattachable while an infant.
    const early = await attach(base, infant.id, { persona: persona("Keen") });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "NOT_ATTACHABLE");

    // Mature it (maturityTicks 1): run tick 2.
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(infant.lifeStage, "adult");

    const scenario = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(scenario.attachable.length, 1);
    assert.equal(scenario.attachable[0].agentId, infant.id);
    assert.equal(scenario.attachable[0].heritage.parentName, "Founder");
    // The parent's actual private objective text must not ride the brief.
    assert.ok(!JSON.stringify(scenario.attachable).includes("You want the tests to pass"), "no private tier in attachable");

    // Claim it: persona authored from the brief; submitted appearance ignored.
    const genotypeBefore = JSON.stringify(infant.appearance);
    const claim = await attach(base, infant.id, {
      persona: persona("Heir", { appearance: { bodyColor: "#111111" } }),
      clientName: "heir-client",
    });
    assert.equal(claim.status, 200);
    assert.match(claim.body.token, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(infant.appearance), genotypeBefore, "genotype kept; appearance ignored on attach");
    assert.equal(infant.persona.name, "Heir");

    // The raced second claimant loses while the first client is live.
    const raced = await attach(base, infant.id, { persona: persona("Late") });
    assert.equal(raced.status, 409);
    assert.equal(raced.body.error, "NOT_ATTACHABLE");

    // And it no longer lists as attachable.
    const after = await fetch(`${base}/scenario`).then((r) => r.json());
    assert.equal(after.attachable.length, 0);
  } finally {
    await daemon.close();
  }
});
