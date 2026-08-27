// The ground plane and its inset grid (observatory spec §5.1). Cells are one
// unit, read as places without looking like a board game. Empty cells stay
// visibly empty: watching a blank world fill is the arc of a run.
//
// This module also carries the agent-map overlay hooks (spec §8.4): each
// cell's tile can be dropped to near-black (unvisited) or dimmed (stale),
// because fog legibility is a per-cell ground treatment, not a scene copy.

import * as THREE from "three";
import { PALETTE, CELL, stoneMaterial } from "../theme.js";

export const cellToWorld = (coord, gridSize) => {
  const [x, y] = coord.split(",").map(Number);
  // 0,0 is the northwest corner; world x east, world z south.
  return { x: (x - (gridSize - 1) / 2) * CELL, z: (y - (gridSize - 1) / 2) * CELL };
};

export function createGround(scene, gridSize) {
  const group = new THREE.Group();
  group.name = "ground";

  // One tile per cell, slightly inset, so the grid reads as thin low-contrast
  // lines of exposed under-plane between tiles.
  const under = new THREE.Mesh(
    new THREE.PlaneGeometry(gridSize * CELL + 0.5, gridSize * CELL + 0.5),
    stoneMaterial(PALETTE.gridLine, { roughness: 0.95 })
  );
  under.rotation.x = -Math.PI / 2;
  under.position.y = -0.012;
  under.receiveShadow = true;
  group.add(under);

  const tileGeometry = new THREE.BoxGeometry(CELL * 0.985, 0.02, CELL * 0.985);
  const tiles = new Map(); // coord -> {mesh, material}
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const coord = `${x},${y}`;
      const material = stoneMaterial(PALETTE.ground, { roughness: 0.95 });
      const mesh = new THREE.Mesh(tileGeometry, material);
      const p = cellToWorld(coord, gridSize);
      mesh.position.set(p.x, 0, p.z);
      mesh.receiveShadow = true;
      mesh.userData.coord = coord;
      group.add(mesh);
      tiles.set(coord, { mesh, material });
    }
  }
  scene.add(group);

  const baseColor = new THREE.Color(PALETTE.ground);

  // Agent-map overlay (spec §8.4): mode is null (true world) or a Map of
  // coord -> "known" | "stale"; anything absent is unvisited, near-black.
  function setOverlay(known) {
    for (const [coord, t] of tiles) {
      if (!known) {
        t.material.color.copy(baseColor);
      } else {
        const k = known.get(coord);
        if (k === "known") t.material.color.copy(baseColor);
        else if (k === "stale") t.material.color.copy(baseColor).multiplyScalar(0.55);
        else t.material.color.copy(baseColor).multiplyScalar(0.12); // never entered
      }
    }
  }

  return { group, tiles, setOverlay };
}
