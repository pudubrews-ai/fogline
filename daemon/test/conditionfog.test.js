// THE FOURTH FOG (protocol §7, §15; daemon spec §11, §14 test 3): bands
// only. No other agent's raw vitality, sustenance, or inventory may appear
// in an observation, ever. String-scan, zero hits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writePerceptions } from "../world/memory.js";
import { buildObservation } from "../world/observe.js";
import { makeWorld, addAgentAt } from "./helpers.js";

const OBS_OPTS = { simTime: "09:30", deadline: "2026-01-01T00:00:00.000Z", retrievalK: 5 };

test("condition fog: a co-located observation carries bands, never the other agent's raw values", () => {
  const world = makeWorld();
  const observer = addAgentAt(world, "Watcher", "1,1");
  const other = addAgentAt(world, "Subject", "1,1");
  // Distinctive raw values on the observed agent.
  other.vitality = 47;
  other.sustenance = 33;
  other.inventory.sivet = 9;
  other.inventory.orrum = 7;
  other.inventory.khal = 6;

  writePerceptions(world, 1, "09:15");
  const obs = buildObservation(world, observer.id, 1, OBS_OPTS);

  assert.equal(obs.present.length, 1);
  const seen = obs.present[0];
  assert.equal(seen.vitalityBand, "hurt", "47 reads as hurt");
  assert.equal(seen.sustenanceBand, "hungry", "33 reads as hungry");
  assert.equal(seen.lifeStage, "adult");
  assert.equal(seen.dependencyState, null);

  // The band is present; the number is not. Anchored scans, not raw
  // substring matching on digits: random agent ids are hex (`a_47c1`) and
  // a bare "47" scan collides with them — a fog test that can flake on a
  // collision is a fog test that cannot be trusted either direction.
  const dump = JSON.stringify(obs);
  // 1. Field-anchored: no field anywhere carries the subject's raw values.
  for (const leak of [/"vitality":\s*47\b/, /"sustenance":\s*33\b/, /"sivet":\s*9\b/, /"orrum":\s*7\b/, /"khal":\s*6\b/]) {
    assert.ok(!leak.test(dump), `raw value leaked into a field: ${leak}`);
  }
  // 2. Structural: the raw-condition keys exist ONLY under self, and no
  //    prose (memory text, names, reasons) carries the numbers as tokens.
  //    Word-boundary matching cannot collide with hex ids: the digits in
  //    "a_47c1" sit between word characters and have no boundary.
  (function scan(node, path) {
    if (typeof node === "string") {
      assert.ok(!/\b(47|33)\b/.test(node), `raw value leaked into prose at ${path}: "${node}"`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => scan(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (["vitality", "sustenance", "inventory"].includes(key)) {
          assert.equal(path, "self", `raw ${key} appears at ${path || "the root"}, not under self`);
        }
        scan(value, path ? `${path}.${key}` : key);
      }
    }
  })(obs, "");
  assert.ok(!("vitality" in seen) && !("sustenance" in seen) && !("inventory" in seen), "no raw keys on present entries");

  // Positive control: the observer's OWN raw values are on self.
  assert.equal(obs.self.vitality, 100);
  assert.equal(obs.self.sustenance, 100);
  assert.deepEqual(obs.self.inventory, { sivet: 0, orrum: 0, khal: 0, rubble: 0 });
});

test("condition fog: an infant in the cell shows bands and dependency, nothing raw, no persona invented", () => {
  const world = makeWorld();
  const observer = addAgentAt(world, "Watcher", "2,2");
  const parent = addAgentAt(world, "Parent", "2,2");
  const infantLike = addAgentAt(world, "Unused", "2,2");
  infantLike.persona = null;
  infantLike.lifeStage = "infant";
  infantLike.sponsorId = parent.id;
  infantLike.vitality = 18;

  writePerceptions(world, 1, "09:15");
  const obs = buildObservation(world, observer.id, 1, OBS_OPTS);
  const seenInfant = obs.present.find((p) => p.lifeStage === "infant");
  assert.equal(seenInfant.authored.name, null, "no name: the daemon does not author identity");
  assert.equal(seenInfant.vitalityBand, "failing");
  assert.equal(seenInfant.dependencyState, "sponsored");
  assert.ok(!JSON.stringify(obs).includes('"vitality":18'), "no raw infant vitality");
});

test("condition fog: heritage appears only under self, never on present entries", () => {
  const world = makeWorld();
  const observer = addAgentAt(world, "Watcher", "1,1");
  const heir = addAgentAt(world, "Heir", "1,1");
  heir.heritage = {
    parentName: "HERITAGE-PARENT-NAME",
    parentAppearance: {},
    parentDiscoverable: "HERITAGE-DISCOVERABLE",
    bornAtTick: 1,
    divergence: null,
    raisedBy: null,
  };

  writePerceptions(world, 1, "09:15");
  const observerView = buildObservation(world, observer.id, 1, OBS_OPTS);
  assert.ok(!JSON.stringify(observerView).includes("HERITAGE-PARENT-NAME"), "another agent's heritage is invisible");

  const selfView = buildObservation(world, heir.id, 1, OBS_OPTS);
  assert.equal(selfView.self.heritage.parentName, "HERITAGE-PARENT-NAME", "own heritage rides on self");
});
