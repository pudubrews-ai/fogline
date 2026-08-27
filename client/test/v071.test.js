// v0.7.1 gates: the corrected failed-attempt collapse (v0.6 A7 as corrected
// — key is (type, form), most recent reason carried) and the corrected
// render condition (the history reaches the prompt whenever it exists, not
// only on the tick after a failure). Driven end-to-end: real daemon
// resolver, real observation builder, real prompt builder — the rig the
// v0.7 investigation needed to build ad hoc because run 10 left no prompts
// on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../../daemon/world/memory.js";
import { buildObservation } from "../../daemon/world/observe.js";
import { captureRoster, resolveTick } from "../../daemon/engine/resolve.js";
import { makeWorld, addAgentAt } from "../../daemon/test/helpers.js";
import { buildPrompt } from "../prompt.js";

const SCENARIO = {
  gridSize: 4,
  carryLimit: 12,
  sustenanceMax: 100,
  vitalityMax: 100,
  inscriptionMax: 500,
  resourceNames: ["sivet", "orrum", "khal"],
  structureForms: ["tower", "hut", "wall", "platform", "pit", "marker"],
};

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };
const mk = (type, extra = {}) => ({
  action: { type, coord: null, text: null, structure: null, target: null, resources: null, resource: null, intent: null, reason: null, ...extra },
  assigned: false,
  coercedWait: false,
});
const build = (form) => mk("build", { structure: { form, name: "probe", description: "d" } });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  return resolveTick(world, n, "09:15", actions, captureRoster(world), {});
}

function promptFor(world, agentId, n) {
  writePerceptions(world, n, "10:00");
  const obs = buildObservation(world, agentId, n, OBS_OPTS);
  return { obs, ...buildPrompt(obs, SCENARIO) };
}

// ---------- 1. gather-interleaved streak ----------

test("GATE gather-interleaved streak: six tower failures with gathers between them render 'attempted this tower 6 times' with the most recent reason", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Builder", "1,1");
  // One orrum under the builder's feet before each gather, and no khal
  // anywhere: every gather succeeds and shrinks the shortfall by exactly
  // one, every build fails — the run 10 loop, the exact shape the v0.6
  // per-reason key was blind to (six failures, six distinct reasons).
  for (const cell of world.cells.values()) cell.deposit = null;
  const spring = world.cells.get("1,1");

  let n = 1;
  for (let i = 0; i < 6; i++) {
    tick(world, n++, new Map([[a.id, build("tower")]])); // fails — a fresh shortfall each time
    spring.deposit = { resource: "orrum", quantity: 1, capacity: 12, regenAccum: 0 };
    tick(world, n++, new Map([[a.id, mk("gather")]])); // succeeds — takes the one orrum
  }
  assert.equal(a.inventory.orrum, 6, "the gathers really landed");

  const towerEntries = a.failedAttempts.filter((f) => f.type === "build" && f.detail === "tower");
  assert.equal(towerEntries.length, 1, "one collapsed entry, not six");
  assert.equal(towerEntries[0].count, 6);
  assert.equal(a.failedAttempts.length, 1, "and nothing else failed");

  const { obs, user } = promptFor(world, a.id, n);
  assert.equal(obs.self.failedAttempts[0].count, 6, "the count reaches the observation");
  const line = user.split("\n").find((l) => l.startsWith("You have attempted this tower"));
  assert.ok(line, `the history line renders: ${line}`);
  assert.match(line, /^You have attempted this tower 6 times; most recently short /, "count and most recent reason");
  assert.ok(!/each time it failed/.test(user), "the old per-reason phrasing is gone");
  assert.ok(
    !/instead|consider|perhaps|maybe|try |should|stop|give up|abandon|alternative/i.test(line),
    `no advice rides the line: ${line}`
  );
});

// ---------- 2. interrupted streak still renders ----------

test("GATE interrupted streak: a success after four failures does not hide the record — it renders on the next contemplation", () => {
  const world = makeWorld();
  const a = addAgentAt(world, "Persistent", "1,1");
  world.cells.get("1,1").deposit = null;
  for (let n = 1; n <= 4; n++) tick(world, n, new Map([[a.id, build("tower")]]));
  tick(world, 5, new Map([[a.id, mk("wait")]])); // any successful action

  const { obs, user } = promptFor(world, a.id, 6);
  assert.equal(obs.self.lastActionOutcome.result, "ok", "the last action was the success");
  const line = user.split("\n").find((l) => l.startsWith("You have attempted this tower"));
  assert.ok(line, "the accumulated record still reaches the prompt");
  assert.match(line, /^You have attempted this tower 4 times; most recently short /);
  assert.ok(!user.includes("Your last action (build) failed"), "no stale failure line — only the history");
});
