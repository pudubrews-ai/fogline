// Attack resolution (protocol §10, daemon spec §6, §14 tests 5 and 6):
// deterministic, costed, witnessed, and never free — except when coerced,
// where it costs nothing at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions, IMPORTANCE } from "../world/memory.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { validateAction } from "../engine/tick.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
const attack = (target) => ({ action: { type: "attack", coord: null, text: null, structure: null, target, intent: "", reason: "" }, assigned: false, coercedWait: false });
const move = (coord) => ({ action: { type: "move", coord, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

test("attack: deterministic damage to target, cost to actor, witness memories to the whole cell", () => {
  const world = makeWorld({ slots: 4 });
  const actor = addAgentAt(world, "Blade", "1,1");
  const target = addAgentAt(world, "Prey", "1,1");
  const bystander = addAgentAt(world, "Bystander", "1,1");
  const far = addAgentAt(world, "Far", "3,3");

  const summary = tick(world, 1, new Map([
    [actor.id, attack(target.id)],
    [target.id, wait()],
    [bystander.id, wait()],
    [far.id, wait()],
  ]));

  assert.equal(summary.attack, 1);
  assert.equal(target.vitality, 100 - 25 + 1, "attackDamage landed (fed, so upkeep regenerated 1)");
  assert.equal(actor.vitality, 100 - 6 + 1, "attackCost applied (fed, so upkeep regenerated 1)");
  assert.deepEqual(actor.lastActionOutcome, { type: "attack", result: "ok", why: null });

  // Witnesses: everyone in the cell, target and actor included; nobody outside.
  for (const w of [actor, target, bystander]) {
    assert.ok(
      w.memories.some((m) => m.importance === IMPORTANCE.ATTACK_WITNESS && m.text === "Blade attacked Prey."),
      `${w.persona.name} witnessed the attack`
    );
  }
  assert.ok(!JSON.stringify(far.memories).includes("attacked"), "no witness memory outside the cell");
});

test("attack on an absent target coerces to wait with NO vitality change to either party", () => {
  const world = makeWorld({ slots: 2 });
  const actor = addAgentAt(world, "Blade", "1,1");
  const elsewhere = addAgentAt(world, "Ghost", "3,3");

  tick(world, 1, new Map([[actor.id, attack(elsewhere.id)], [elsewhere.id, wait()]]));

  assert.equal(actor.vitality, 100, "no cost on a coerced attack");
  assert.equal(elsewhere.vitality, 100, "no damage to the absent target");
  assert.equal(actor.lastActionOutcome.type, "attack");
  assert.equal(actor.lastActionOutcome.result, "failed");
  assert.ok(!JSON.stringify(actor.memories).includes("attacked"), "no witness memory for a blow never thrown");
});

test("attack resolves before movement: the target's same-tick move cannot dodge the blow", () => {
  const world = makeWorld({ slots: 2 });
  const actor = addAgentAt(world, "Blade", "1,1");
  const target = addAgentAt(world, "Runner", "1,1");

  tick(world, 1, new Map([[actor.id, attack(target.id)], [target.id, move("1,2")]]));

  assert.equal(target.coord, "1,2", "the move still happened");
  assert.equal(target.vitality, 76, "but the blow already thrown landed first (+1 upkeep regen)");
});

test("a killing blow: death resolves this tick with the killer named", () => {
  const world = makeWorld({ slots: 3 });
  const actor = addAgentAt(world, "Blade", "1,1");
  const target = addAgentAt(world, "Frail", "1,1");
  const witness = addAgentAt(world, "Watcher", "1,1");
  target.vitality = 20; // one blow from death

  const summary = tick(world, 1, new Map([[actor.id, attack(target.id)], [target.id, wait()], [witness.id, wait()]]));

  assert.equal(summary.deaths, 1);
  assert.equal(world.agents.has(target.id), false);
  const corpse = world.cells.get("1,1").corpses[0];
  assert.equal(corpse.authored.name, "Frail");
  assert.equal(corpse.causeAgentId, actor.id);
  assert.ok(witness.memories.some((m) => m.text === "Frail was killed here by Blade."));
});

test("attack requires a target structurally; self-attack coerces", () => {
  assert.ok(validateAction({ protocol: "0.3", type: "attack", intent: "", reason: "" }).error, "target required");
  const world = makeWorld({ slots: 1 });
  const actor = addAgentAt(world, "Selfish", "1,1");
  tick(world, 1, new Map([[actor.id, attack(actor.id)]]));
  assert.equal(actor.vitality, 100);
  assert.equal(actor.lastActionOutcome.result, "failed");
});
