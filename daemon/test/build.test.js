// Build resolution (daemon spec §6, §9 tests 3/7/8): builds are silent,
// contested builds resolve to the lowest agentId, and the reserved actions
// are rejected rather than coerced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { captureRoster, resolveTick } from "../engine/resolve.js";
import { validateAction } from "../engine/tick.js";
import { makeWorld, addAgentAt, grant } from "./helpers.js";

const OBS_OPTS = { simTime: "10:00", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };

const wait = () => ({ action: { type: "wait", coord: null, text: null, structure: null, intent: "", reason: "" }, assigned: false, coercedWait: false });
// Markers cost 1 orrum; tests grant materials explicitly.
const build = (name, description, form = "marker") => ({ action: { type: "build", coord: null, text: null, structure: { form, name, description }, intent: "", reason: "" }, assigned: false, coercedWait: false });

function tick(world, n, actions) {
  writePerceptions(world, n, "09:15");
  const roster = captureRoster(world);
  return resolveTick(world, n, "09:15", actions, roster);
}

test("silent build: no other agent's memory stream contains any fragment of the structure", () => {
  const world = makeWorld();
  const builder = grant(addAgentAt(world, "Mason", "1,1"), { orrum: 1 });
  const near = addAgentAt(world, "Near", "1,0"); // adjacent, not co-located
  const far = addAgentAt(world, "Far", "3,3");

  tick(world, 1, new Map([
    [builder.id, build("SECRET-KIOSK", "UNBROADCAST paint, still wet")],
    [near.id, wait()],
    [far.id, wait()],
  ]));

  assert.equal(world.cells.get("1,1").structure.authored.name, "SECRET-KIOSK");
  for (const other of [near, far]) {
    const dump = JSON.stringify(other.memories);
    assert.ok(!dump.includes("SECRET-KIOSK") && !dump.includes("UNBROADCAST"), `${other.persona.name}'s stream is clean`);
    writePerceptions(world, 2, "09:30");
    const obs = buildObservation(world, other.id, 2, OBS_OPTS);
    const obsDump = JSON.stringify(obs);
    assert.ok(!obsDump.includes("SECRET-KIOSK") && !obsDump.includes("UNBROADCAST"), `${other.persona.name}'s observation is clean`);
  }

  // The builder's own stream remembers, and the outcome reports success.
  assert.ok(JSON.stringify(builder.memories).includes("SECRET-KIOSK"));
  assert.deepEqual(builder.lastActionOutcome, { type: "build", result: "ok", why: null });
});

test("contested build: exactly one structure exists; the loser's outcome reports the failure", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Alpha", "2,2"), { orrum: 1 });
  const b = grant(addAgentAt(world, "Beta", "2,2"), { orrum: 1 });

  const summary = tick(world, 1, new Map([
    [a.id, build("ALPHA-HUT", "first draft")],
    [b.id, build("BETA-HUT", "rival draft")],
  ]));

  assert.equal(summary.build, 1, "exactly one build applied");
  assert.equal(summary.failedBuild, 1);

  const winnerId = [a.id, b.id].sort()[0]; // stable rule: lowest agentId
  const winner = world.agents.get(winnerId);
  const loser = world.agents.get(winnerId === a.id ? b.id : a.id);

  const structure = world.cells.get("2,2").structure;
  assert.equal(structure.authored.name, winner === a ? "ALPHA-HUT" : "BETA-HUT");
  assert.deepEqual(structure.history, [{ agentId: winnerId, tick: 1, action: "build" }]);

  assert.deepEqual(winner.lastActionOutcome, { type: "build", result: "ok", why: null });
  assert.equal(loser.lastActionOutcome.type, "build");
  assert.equal(loser.lastActionOutcome.result, "failed");
  assert.equal(loser.lastActionOutcome.why, "cell was built this tick");
});

test("building on an already-built cell coerces to wait and reports through lastActionOutcome", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Alpha", "2,2"), { orrum: 2 });
  tick(world, 1, new Map([[a.id, build("FIRST", "original")]]));
  const summary = tick(world, 2, new Map([[a.id, build("SECOND", "rebuild attempt")]]));

  assert.equal(summary.failedBuild, 1);
  assert.equal(world.cells.get("2,2").structure.authored.name, "FIRST", "original untouched");
  assert.equal(a.lastActionOutcome.result, "failed");
  assert.match(a.lastActionOutcome.why, /already has a structure/);
});

test("build history is append-only and an array from the outset", () => {
  const world = makeWorld();
  const a = grant(addAgentAt(world, "Alpha", "0,0"), { orrum: 1 });
  tick(world, 1, new Map([[a.id, build("HUT", "one entry")]]));
  const structure = world.cells.get("0,0").structure;
  assert.ok(Array.isArray(structure.history));
  assert.equal(structure.history.length, 1);
});

test("reserved action modify is rejected with INVALID_ACTION, not coerced; demolish is live in v0.4", () => {
  const v = validateAction({ protocol: "0.2", type: "modify", intent: "", reason: "" });
  assert.equal(v.error, true, "modify is rejected");
  assert.match(v.detail, /reserved/);
  // demolish left the reserved list in v0.4 (protocol §10).
  const d = validateAction({ protocol: "0.2", type: "demolish", intent: "", reason: "" });
  assert.ok(d.action && !d.error, "demolish is a live action now");
  // Unknown types, by contrast, still coerce to wait.
  const unknown = validateAction({ protocol: "0.2", type: "dance", intent: "", reason: "" });
  assert.equal(unknown.coercedWait, true);
  assert.equal(unknown.action.type, "wait");
});

test("build action structural validation: limits, control chars, no coordinate", () => {
  const ok = validateAction({ protocol: "0.2", type: "build", structure: { form: "hut", name: "Hut", description: "small" }, intent: "", reason: "" });
  assert.ok(ok.action && !ok.error);

  const cases = [
    [{ type: "build", intent: "", reason: "" }, /structure is required/],
    [{ type: "build", structure: { form: "palace", name: "Hut", description: "d" }, intent: "", reason: "" }, /form/],
    [{ type: "build", structure: { form: "hut", name: "", description: "d" }, intent: "", reason: "" }, /name/],
    [{ type: "build", structure: { form: "hut", name: "x".repeat(41), description: "d" }, intent: "", reason: "" }, /name/],
    [{ type: "build", structure: { form: "hut", name: "Hut", description: "x".repeat(301) }, intent: "", reason: "" }, /description/],
    [{ type: "build", structure: { form: "hut", name: "Hut", description: "bad\u0007char" }, intent: "", reason: "" }, /control/],
    [{ type: "build", coord: "1,1", structure: { form: "hut", name: "Hut", description: "d" }, intent: "", reason: "" }, /coordinate/],
  ];
  for (const [payload, re] of cases) {
    const v = validateAction({ protocol: "0.2", ...payload });
    assert.equal(v.error, true, JSON.stringify(payload).slice(0, 60));
    assert.match(v.detail, re);
  }
});
