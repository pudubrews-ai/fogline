// Sustenance, vitality, upkeep order, and derived bands (daemon spec §4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { vitalsConfig, vitalityBand, sustenanceBand, runUpkeep } from "../world/vitals.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const vc = vitalsConfig({});

test("bands are derived at the documented thresholds and never stored", () => {
  assert.equal(vitalityBand(100, vc), "hale");
  assert.equal(vitalityBand(67, vc), "hale");
  assert.equal(vitalityBand(66, vc), "hurt");
  assert.equal(vitalityBand(26, vc), "hurt");
  assert.equal(vitalityBand(25, vc), "failing");
  assert.equal(vitalityBand(0, vc), "failing");
  assert.equal(sustenanceBand(100, vc), "fed");
  assert.equal(sustenanceBand(61, vc), "fed");
  assert.equal(sustenanceBand(60, vc), "hungry");
  assert.equal(sustenanceBand(21, vc), "hungry");
  assert.equal(sustenanceBand(20, vc), "starving");
  assert.equal(sustenanceBand(0, vc), "starving");

  const world = makeWorld();
  const body = addAgentAt(world, "Bandy", "0,0");
  assert.ok(!("vitalityBand" in body) && !("sustenanceBand" in body), "no band is ever stored on a body");
});

test("registered bodies start at full vitals with an empty inventory", () => {
  const world = makeWorld();
  const body = addAgentAt(world, "Fresh", "0,0");
  assert.equal(body.sustenance, 100);
  assert.equal(body.vitality, 100);
  assert.deepEqual(body.inventory, { sivet: 0, orrum: 0, khal: 0, rubble: 0 });
});

test("upkeep: sustenance decays; at zero, starvation damage lands; fed agents regenerate", () => {
  const world = makeWorld();
  const starving = addAgentAt(world, "Thin", "0,0");
  const healing = addAgentAt(world, "Whole", "1,0");
  starving.sustenance = 1;
  healing.sustenance = 80;
  healing.vitality = 90;

  runUpkeep(world, vc); // Thin: decay runs first (1 -> 0), so starvation bites the same tick
  assert.equal(starving.sustenance, 0);
  assert.equal(starving.vitality, 100 - 3, "decay runs before the starvation check, so zero bites this tick");
  assert.equal(healing.vitality, 91, "above the regen threshold, vitality climbs");

  runUpkeep(world, vc);
  assert.equal(starving.vitality, 100 - 6, "starvation damage per tick while at zero");
});

test("upkeep: vitality never regenerates past max and decay never goes below zero sustenance", () => {
  const world = makeWorld();
  const body = addAgentAt(world, "Cap", "0,0");
  body.sustenance = 2;
  for (let i = 0; i < 5; i++) runUpkeep(world, vc);
  assert.equal(body.sustenance, 0, "clamped at zero");
  body.sustenance = 100;
  body.vitality = 100;
  runUpkeep(world, vc);
  assert.equal(body.vitality, 100, "never past max");
});
