// Genotype composition (daemon spec §8, §14 test 8): 500 compositions stay
// inside the enumerations and the saturation ceiling, mutation lands near its
// configured rate, and divergence notes never editorialize.

import { test } from "node:test";
import assert from "node:assert/strict";
import { APPEARANCE_ENUMS, saturationOf } from "../world/appearance.js";
import { composeGenotype, genotypeConfig } from "../world/genotype.js";

// Deterministic LCG so the statistical assertions cannot flake.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PARENT = {
  bodyColor: "#8A7F74",
  eyeColor: "#FF4400",
  scale: "medium",
  shell: "panelled",
  eyes: "pair",
};

// The daemon never authors motive: no divergence note may carry evaluative
// language (protocol invariant 6, hard constraint 4).
const EVALUATIVE = /\b(violent|hostile|dangerous|bad|evil|cruel|aggressive|wicked|criminal|vicious|menacing|threatening|villain|monster|wrong|broken|defective|good|gifted|special|superior|blessed|cursed)\b/i;

test("500 begets: enums hold, ceiling holds, mutation rate lands, divergence stays neutral", () => {
  const gc = genotypeConfig({});
  const rng = lcg(42);
  let mutatedTraits = 0;
  let divergences = 0;
  const N = 500;

  for (let i = 0; i < N; i++) {
    const { appearance, divergence } = composeGenotype(PARENT, gc, rng);
    for (const [trait, values] of Object.entries(APPEARANCE_ENUMS)) {
      assert.ok(values.includes(appearance[trait]), `${trait}=${appearance[trait]} is in its enumeration`);
      if (appearance[trait] !== PARENT[trait]) mutatedTraits += 1;
    }
    assert.match(appearance.bodyColor, /^#[0-9a-f]{6}$/i);
    assert.match(appearance.eyeColor, /^#[0-9a-f]{6}$/i);
    assert.ok(
      saturationOf(appearance.bodyColor) <= gc.saturationCeiling + 0.005,
      `body saturation ${saturationOf(appearance.bodyColor)} under the ceiling`
    );
    if (divergence !== null) {
      divergences += 1;
      assert.equal(EVALUATIVE.test(divergence), false, `divergence note is neutral: "${divergence}"`);
      assert.match(divergence, /unlike the parent/, "a divergence is a fact about ancestry");
    }
  }

  // Three traits per beget, each mutating at 0.2: expect ~0.2 within tolerance.
  const observedRate = mutatedTraits / (N * 3);
  assert.ok(Math.abs(observedRate - gc.mutationRate) < 0.05, `mutation rate ${observedRate} within tolerance of ${gc.mutationRate}`);

  // Divergence at 0.03: expect ~15 of 500; loose bounds, deterministic seed.
  assert.ok(divergences >= 4 && divergences <= 40, `divergence count ${divergences} near rate`);
});

test("the eye stays saturated: eyeColor is exempt from the ceiling", () => {
  const gc = genotypeConfig({});
  const rng = lcg(7);
  let sawSaturatedEye = false;
  for (let i = 0; i < 50; i++) {
    const { appearance } = composeGenotype(PARENT, gc, rng);
    if (saturationOf(appearance.eyeColor) > gc.saturationCeiling) sawSaturatedEye = true;
  }
  assert.ok(sawSaturatedEye, "children of a saturated-eyed parent keep saturated eyes");
});
