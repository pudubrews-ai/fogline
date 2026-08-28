import { defaultDefinition } from "../world/definition.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorld,
  exitsFor,
  nameTaken,
  parseCoord,
  releaseAgent,
  validatePersona,
} from "../world/world.js";
import { simTimeAtTick } from "../engine/clock.js";
import { makeWorld, addAgentAt, persona } from "./helpers.js";

test("grid: all N² cells exist at boot with structure null, never lazily created", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 5 });
  assert.equal(world.cells.size, 16);
  for (const cell of world.cells.values()) assert.equal(cell.structure, null);
  assert.equal(world.agents.size, 0, "the world boots with zero agents");
  assert.deepEqual(world.slots, { total: 5, used: 0 });
});

test("adjacency is computed: corner 2, edge 3, center 4, no diagonals, no wrapping", () => {
  const world = createWorld({ defaults: defaultDefinition(),  gridSize: 4, slots: 5 });
  const dirs = (coord) => exitsFor(world, coord).map((e) => `${e.direction}:${e.coord}`);
  assert.deepEqual(dirs("0,0"), ["east:1,0", "south:0,1"], "northwest corner");
  assert.deepEqual(dirs("3,3"), ["north:3,2", "west:2,3"], "southeast corner");
  assert.deepEqual(dirs("2,0"), ["east:3,0", "south:2,1", "west:1,0"], "north edge");
  assert.deepEqual(dirs("1,2"), ["north:1,1", "east:2,2", "south:1,3", "west:0,2"], "center");
});

test("parseCoord accepts only x,y with digits", () => {
  assert.deepEqual(parseCoord("2,1"), { x: 2, y: 1 });
  assert.equal(parseCoord("2, 1"), null);
  assert.equal(parseCoord("-1,0"), null);
  assert.equal(parseCoord("north"), null);
});

test("persona validation: valid persona passes and name is trimmed", () => {
  const v = validatePersona(persona("  Devi  "));
  assert.equal(v.ok, true);
  assert.equal(v.persona.name, "Devi");
});

test("persona validation is a guard: every malformed field rejected, never truncated", () => {
  const cases = [
    [persona("x".repeat(25)), /name/],
    [persona(""), /name/],
    [persona("Bad;Name"), /name/],
    [persona("Devi", { appearance: { shell: "iridescent" } }), /shell/],
    [persona("Devi", { appearance: { bodyColor: "red" } }), /bodyColor/],
    [persona("Devi", { appearance: { bodyColor: "#12345" } }), /bodyColor/],
    [persona("Devi", { appearance: { bodyColor: "#FF0000" } }), /saturation/],
    [persona("Devi", { appearance: { eyeColor: "orange" } }), /eyeColor/],
    [persona("Devi", { disposition: "chatty" }), /disposition/],
    [persona("Devi", { identity: "x".repeat(601) }), /identity/],
    [persona("Devi", { discoverable: "x".repeat(801) }), /discoverable/],
    [persona("Devi", { privateObjective: "x".repeat(401) }), /privateObjective/],
    [persona("Devi", { identity: "You are \u0007 bell." }), /control/],
    [persona("Devi", { identity: 42 }), /identity/],
  ];
  for (const [p, re] of cases) {
    const v = validatePersona(p);
    assert.equal(v.ok, false, `should reject: ${JSON.stringify(p).slice(0, 60)}`);
    assert.match(v.detail, re);
  }
  // Newlines in freeform text are fine; only other control chars are rejected.
  assert.equal(validatePersona(persona("Devi", { identity: "You are.\nYou remain." })).ok, true);
});

test("name uniqueness is case-insensitive and trimmed", () => {
  const world = makeWorld();
  addAgentAt(world, "Devi", "0,0");
  assert.equal(nameTaken(world, "devi"), true);
  assert.equal(nameTaken(world, "  DEVI  "), true);
  assert.equal(nameTaken(world, "Rune"), false);
});

test("persona is frozen at registration — no write path can alter it", () => {
  const world = makeWorld();
  const body = addAgentAt(world, "Devi", "0,0");
  assert.throws(() => {
    "use strict";
    body.persona.name = "Impostor";
  }, TypeError);
  assert.throws(() => {
    "use strict";
    body.persona.appearance.bodyColor = "#000000";
  }, TypeError);
  assert.equal(body.persona.name, "Devi");
});

test("registration consumes a slot; release frees it and marks the id reclaimed", () => {
  const world = makeWorld({ slots: 2 });
  const a = addAgentAt(world, "Devi", "0,0");
  addAgentAt(world, "Rune", "1,0");
  assert.equal(world.slots.used, 2);
  assert.equal(releaseAgent(world, a.id), true);
  assert.equal(world.slots.used, 1);
  assert.equal(world.agents.has(a.id), false);
  assert.equal(world.reclaimedIds.has(a.id), true);
});

test("spawned agent's known map contains exactly the spawn cell", () => {
  const world = makeWorld();
  const body = addAgentAt(world, "Devi", "2,1");
  assert.deepEqual([...body.knownCells.keys()], ["2,1"]);
  assert.equal(body.knownCells.get("2,1").structureSnapshot, null);
});

test("sim clock advances per tick and wraps midnight", () => {
  assert.equal(simTimeAtTick("09:00", 15, 0), "09:00");
  assert.equal(simTimeAtTick("09:00", 15, 1), "09:15");
  assert.equal(simTimeAtTick("09:00", 15, 4), "10:00");
  assert.equal(simTimeAtTick("23:45", 15, 2), "00:15");
});
