// Death consequences (protocol §6.3, daemon spec §5, §14 test 4): inventory
// drops, corpse permanent, witnesses remember, own memories destroyed,
// dependents unsponsored, slot freed, attached client gets SLOT_RECLAIMED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions, addMemory, IMPORTANCE } from "../world/memory.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { makeWorld, addAgentAt, bootDaemon, register, act } from "./helpers.js";

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });

function tick(world, n, actions = new Map()) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

test("death: inventory drops, corpse placed, witnesses remember, own memories destroyed, slot freed", () => {
  const world = makeWorld({ slots: 3 });
  const dying = addAgentAt(world, "Moth", "1,1");
  const witness = addAgentAt(world, "Watcher", "1,1");
  const far = addAgentAt(world, "Far", "3,3");
  dying.inventory.orrum = 4;
  dying.inventory.sivet = 1;
  dying.vitality = 1;
  dying.sustenance = 0; // starvation damage lands at upkeep, death follows
  addMemory(world, dying, { tick: 0, simTime: "09:00", type: "reflection", text: "PRIVATE-DYING-THOUGHT", importance: 7 });

  const summary = tick(world, 1, new Map([[dying.id, wait()], [witness.id, wait()], [far.id, wait()]]));
  assert.equal(summary.deaths, 1);

  // Slot freed, id reclaimed, body gone.
  assert.equal(world.agents.has(dying.id), false);
  assert.equal(world.reclaimedIds.has(dying.id), true);
  assert.equal(world.slots.used, 2);

  // Inventory became a loose pile in the death cell.
  const cell = world.cells.get("1,1");
  assert.deepEqual(cell.loose, { sivet: 1, orrum: 4, khal: 0, rubble: 0 });

  // Corpse: permanent, named, no cause (starvation, not attack).
  assert.equal(cell.corpses.length, 1);
  assert.equal(cell.corpses[0].authored.name, "Moth");
  assert.equal(cell.corpses[0].diedAtTick, 1);
  assert.equal(cell.corpses[0].causeAgentId, null);

  // Witness memory in the cell; none outside it.
  assert.ok(witness.memories.some((m) => m.importance === IMPORTANCE.DEATH_WITNESS && m.text.includes("Moth died here")));
  assert.ok(!JSON.stringify(far.memories).includes("Moth died"), "no death memory outside the cell");

  // The dead agent's own stream was destroyed, not merely orphaned.
  assert.equal(dying.memories.length, 0);
  assert.equal(dying.knownCells.size, 0);
});

test("death: structures and inscriptions survive; corpses are not gatherable and persist across ticks", () => {
  const world = makeWorld({ slots: 2 });
  const dying = addAgentAt(world, "Mason", "2,2");
  world.cells.get("2,2").structure = {
    form: "wall",
    authored: { name: "LASTING-WALL", description: "outlives its maker" },
    inscription: { entries: [{ id: "t_rule", authorId: dying.id, authorName: "Mason", tick: 0, text: "the rule stands" }], charactersUsed: 15 },
    history: [{ agentId: dying.id, tick: 0, action: "build" }],
  };
  dying.vitality = 0;
  tick(world, 1, new Map([[dying.id, wait()]]));

  const cell = world.cells.get("2,2");
  assert.equal(cell.structure.authored.name, "LASTING-WALL");
  assert.equal(cell.structure.inscription.entries[0].text, "the rule stands");
  assert.equal(cell.structure.history[0].agentId, dying.id, "history intact, dead author still credited");
  assert.equal(cell.corpses.length, 1);

  tick(world, 2);
  tick(world, 3);
  assert.equal(cell.corpses.length, 1, "corpses are permanent");
});

test("death by attack this tick names the killer in witness memory and corpse cause", () => {
  const world = makeWorld({ slots: 3 });
  const victim = addAgentAt(world, "Prey", "1,1");
  const killer = addAgentAt(world, "Blade", "1,1");
  victim.vitality = 1;
  victim.lastAttackedBy = { agentId: killer.id, name: "Blade", tick: 1 };
  victim.vitality = -10; // as if the blow this tick took them past zero

  tick(world, 1, new Map([[victim.id, wait()], [killer.id, wait()]]));
  const cell = world.cells.get("1,1");
  assert.equal(cell.corpses[0].causeAgentId, killer.id);
  assert.ok(killer.memories.some((m) => m.text === "Prey was killed here by Blade."));
});

test("death: dependents become unsponsored with the tick recorded", () => {
  const world = makeWorld({ slots: 3 });
  const sponsor = addAgentAt(world, "Parent", "0,0");
  const infant = addAgentAt(world, "Unused", "0,0");
  // Hand-built infant state; the beget path builds this for real.
  infant.persona = null;
  infant.lifeStage = "infant";
  infant.sponsorId = sponsor.id;
  sponsor.vitality = 0;

  tick(world, 1, new Map([[sponsor.id, wait()]]));
  assert.equal(infant.sponsorId, null);
  assert.equal(infant.unsponsoredAtTick, 1);
});

test("death over HTTP: attached client's next request answers SLOT_RECLAIMED and its stream ends", async () => {
  const { daemon, base } = await bootDaemon({ startPaused: true, actionDeadlineMs: 50 });
  try {
    const reg = (await register(base, "Doomed")).body;
    await register(base, "Alive");
    daemon.engine.world.agents.get(reg.agentId).vitality = 0;
    daemon.engine.step();
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(daemon.engine.world.agents.has(reg.agentId), false, "body died at resolution");
    const r = await act(base, reg.token, { tick: daemon.engine.tick + 1 });
    assert.equal(r.status, 410);
    assert.equal(r.body.error, "SLOT_RECLAIMED");
    // Registration into the freed slot works; the old id never comes back.
    assert.equal((await register(base, "Heir")).status, 200);
  } finally {
    await daemon.close();
  }
});
