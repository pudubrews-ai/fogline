// Discrete inheritance, mutation, divergence (protocol §11.2, daemon spec
// §8). Mechanical, credential-free, and mute on meaning: the daemon composes
// bodies, never characters. Divergence notes state that something came out
// unlike the parent — they MUST NOT say whether that is good or bad, and the
// wordlist test holds this module to it.

import { APPEARANCE_ENUMS, hexToHsl, hslToHex } from "./appearance.js";

export const GENOTYPE_DEFAULTS = {
  mutationRate: 0.2,
  hueJitter: 18,
  saturationCeiling: 0.35,
  divergenceRate: 0.03,
};

export const genotypeConfig = (config) => ({ ...GENOTYPE_DEFAULTS, ...(config.genotype ?? {}) });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Neutral, factual, ancestry-only. The adopting client decides what a
// divergence means; the daemon does not (protocol invariant 6).
function divergenceNote(mutations) {
  if (mutations.length > 0) {
    const m = mutations[0];
    return `Came out unlike the parent: ${m.trait} is ${m.to} where the parent's was ${m.from}.`;
  }
  return "Came out unlike the parent: the coloring drifted well away from the parent's.";
}

// Compose an infant's appearance from its parent's. Enum traits copy with
// p = 1 - mutationRate, otherwise pick uniformly from the remaining values.
// bodyColor jitters within bounds and stays under the saturation ceiling;
// eyeColor jitters slightly and is exempt (the rendering contract).
export function composeGenotype(parentAppearance, gc, rng = Math.random) {
  const appearance = {};
  const mutations = [];
  for (const [trait, values] of Object.entries(APPEARANCE_ENUMS)) {
    if (rng() < gc.mutationRate) {
      const rest = values.filter((v) => v !== parentAppearance[trait]);
      appearance[trait] = rest[Math.floor(rng() * rest.length)];
      mutations.push({ trait, from: parentAppearance[trait], to: appearance[trait] });
    } else {
      appearance[trait] = parentAppearance[trait];
    }
  }

  const jitter = (range) => (rng() * 2 - 1) * range;
  const body = hexToHsl(parentAppearance.bodyColor);
  appearance.bodyColor = hslToHex({
    h: body.h + jitter(gc.hueJitter),
    s: clamp(body.s + jitter(0.05), 0, gc.saturationCeiling),
    l: clamp(body.l + jitter(0.06), 0.15, 0.85),
  });
  const eye = hexToHsl(parentAppearance.eyeColor);
  appearance.eyeColor = hslToHex({
    h: eye.h + jitter(6),
    s: eye.s,
    l: clamp(eye.l + jitter(0.03), 0.2, 0.8),
  });

  const divergence = rng() < gc.divergenceRate ? divergenceNote(mutations) : null;
  return { appearance, divergence };
}
