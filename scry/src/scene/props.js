// Deposits, loose piles, rubble, corpses, and the inscription fragment slab
// (observatory spec §5.6). Everything here maps 1:1 to a field in a cell
// record. If it is in the frame, the daemon placed it or an agent caused it.

import * as THREE from "three";
import { PALETTE, AGENT_SCALE, stoneMaterial } from "../theme.js";
import { cellToWorld } from "./ground.js";

const chunkGeos = [
  new THREE.BoxGeometry(0.13, 0.1, 0.11),
  new THREE.BoxGeometry(0.1, 0.14, 0.09),
  new THREE.BoxGeometry(0.16, 0.08, 0.12),
];

// A cluster of angular masses, count scaled to quantity. Deterministic
// placement from the coordinate so re-syncs do not shuffle the ground.
function cluster({ coord, count, material, radius, low = false }) {
  const g = new THREE.Group();
  const [cx, cy] = coord.split(",").map(Number);
  const seedBase = cx * 31 + cy * 17;
  for (let i = 0; i < count; i++) {
    const seed = seedBase + i * 7;
    const angle = (seed % 20) * 0.32;
    const r = radius * (0.25 + ((seed % 7) / 7) * 0.75);
    const m = new THREE.Mesh(chunkGeos[i % chunkGeos.length], material);
    m.position.set(Math.cos(angle) * r, low ? 0.035 : 0.05 + (i % 3) * 0.045, Math.sin(angle) * r);
    m.rotation.set(0, angle * 2.3, (seed % 5) * 0.06);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

export function createProps(scene, gridSize) {
  const group = new THREE.Group();
  group.name = "props";
  scene.add(group);

  const byCoord = new Map(); // coord -> {root, key}
  const materials = {
    deposit: Object.fromEntries(Object.entries(PALETTE.deposit).map(([r, c]) => [r, stoneMaterial(c, { roughness: 0.93 })])),
    loose: stoneMaterial(PALETTE.structureAlt, { roughness: 0.95 }),
    rubble: stoneMaterial(PALETTE.rubble, { roughness: 0.98 }),
    corpse: stoneMaterial(PALETTE.corpse, { roughness: 0.95 }),
    fragment: stoneMaterial(0xb3ab9c, { roughness: 0.95 }),
    deadEye: stoneMaterial(0x2a2724, { roughness: 0.9 }),
  };

  // One stable key per cell's prop content: rebuild only when it changes.
  function keyOf(cell, tick) {
    const corpseAges = cell.corpses.map((c) => Math.min(3, Math.floor((tick - c.diedAtTick) / 100))).join(".");
    return JSON.stringify([cell.deposit, cell.loose, cell.fragment, cell.corpses.length, corpseAges]);
  }

  function buildCellProps(cell, tick) {
    const root = new THREE.Group();
    const p = cellToWorld(cell.coord, gridSize);
    root.position.set(p.x, 0, p.z);

    // Deposit: low cluster of angular forms, count scaled to quantity, a
    // slightly different stone tone per resource. Vanishes at zero.
    if (cell.deposit && cell.deposit.quantity >= 1) {
      const mat = materials.deposit[cell.deposit.resource] ?? materials.loose;
      const count = Math.max(2, Math.min(9, Math.round(cell.deposit.quantity / 2)));
      root.add(cluster({ coord: cell.coord, count, material: mat, radius: 0.3 }));
    }

    // Loose piles: smaller, scattered, visibly informal. Rubble is distinct —
    // dustier, darker, reads as former structure, not a resource node.
    if (cell.loose) {
      const rubble = cell.loose.rubble ?? 0;
      const other = Object.entries(cell.loose).filter(([r, n]) => r !== "rubble" && n > 0);
      const otherTotal = other.reduce((s, [, n]) => s + n, 0);
      if (otherTotal > 0) {
        const count = Math.max(1, Math.min(6, Math.round(otherTotal / 2)));
        const g = cluster({ coord: cell.coord, count, material: materials.loose, radius: 0.22, low: true });
        g.position.set(0.18, 0, 0.14);
        root.add(g);
      }
      if (rubble > 0) {
        const count = Math.max(2, Math.min(10, Math.round(rubble / 1.5)));
        const g = cluster({ coord: cell.coord, count, material: materials.rubble, radius: 0.3, low: true });
        g.position.set(-0.08, 0, -0.05);
        root.add(g);
      }
    }

    // The fragment: a single tilted slab in the pile — the visible fact that
    // a record survived. A razed cell has rubble and NO slab; that absence
    // is the point (spec §5.2b).
    if (cell.fragment) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.04), materials.fragment);
      slab.name = "fragment-slab"; // its absence on a razed pile is the visible fact
      slab.position.set(-0.12, 0.12, -0.1);
      slab.rotation.set(0.35, 0.4, 0.55);
      slab.castShadow = true;
      root.add(slab);
    }

    // Corpses: the agent's sphere, unlit eyes, resting on the ground, matte
    // and darkening with age. Permanent. Not stylised.
    cell.corpses.forEach((corpse, i) => {
      const scale = (AGENT_SCALE[corpse.appearance?.scale] ?? AGENT_SCALE.medium) * 0.96;
      const age = Math.min(1, Math.max(0, (tick - corpse.diedAtTick) / 400));
      const mat = materials.corpse.clone();
      mat.color.lerp(new THREE.Color(0x2e2b27), age * 0.6);
      const body = new THREE.Mesh(new THREE.SphereGeometry(scale, 20, 14), mat);
      body.position.set(0.22 * (i - (cell.corpses.length - 1) / 2), scale * 0.62, 0.22);
      body.scale.y = 0.72; // settled, not posed
      body.castShadow = true;
      const eye = new THREE.Mesh(new THREE.CircleGeometry(scale * 0.14, 10), materials.deadEye);
      eye.position.set(body.position.x, body.position.y + scale * 0.1, body.position.z + scale * 0.95);
      root.add(body, eye);
    });

    return root;
  }

  function sync(state) {
    const seen = new Set();
    for (const cell of state.cells.values()) {
      const has = cell.deposit || cell.loose || cell.fragment || cell.corpses.length > 0;
      if (!has) continue;
      seen.add(cell.coord);
      const key = keyOf(cell, state.tick);
      const existing = byCoord.get(cell.coord);
      if (existing && existing.key === key) continue;
      if (existing) group.remove(existing.root);
      const root = buildCellProps(cell, state.tick);
      group.add(root);
      byCoord.set(cell.coord, { root, key });
    }
    for (const [coord, entry] of byCoord) {
      if (!seen.has(coord)) {
        group.remove(entry.root);
        byCoord.delete(coord);
      }
    }
  }

  return { group, sync };
}
