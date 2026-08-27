// Palette, materials, constants (observatory spec §4). Locked art direction:
// cool, sparse, architectural. Roughness at or above 0.85 everywhere,
// metalness 0 — the single fastest way to make this look like a toy is a
// specular highlight. Saturation lives ONLY in eyes; agent bodies arrive
// from the daemon already clamped.

import * as THREE from "three";

export const PALETTE = {
  ground: 0x6b6157, // cool grey-brown
  gridLine: 0x7c7268, // barely lighter, thin
  structure: 0xd8d2c6, // off-white stone
  structureAlt: 0xc4bdb0,
  corpse: 0x5a544d,
  haze: 0x8a8378,
  rubble: 0x4e4842, // dustier and darker than quarried stone: former structure
  // Quarried stone in the off-white family, tone varying by resource
  // (spec §2.7). Never near-black — dark-and-dusty is rubble's register,
  // and rubble is never seeded.
  deposit: {
    sivet: 0xccd1b8, // green-leaning off-white
    orrum: 0xd8cfc0, // warm off-white
    khal: 0xc4cbd6, // cool off-white
  },
};

// Every material in the frame goes through here, so the roughness floor and
// metalness zero are structural, not conventional.
export function stoneMaterial(color, { roughness = 0.9 } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: Math.max(0.85, roughness),
    metalness: 0,
  });
}

// The one exception: eyes. Emissive, saturated, the only bloom source.
export function eyeMaterial(hexColor, intensity = 1) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(hexColor),
    emissiveIntensity: intensity,
    roughness: 0.85,
    metalness: 0,
  });
}

export const AGENT_SCALE = { small: 0.28, medium: 0.34, large: 0.4 };

export const CELL = 1; // one cell = one world unit
