// form -> geometry, weathering, demolish disassembly (observatory spec §5.2,
// §5.2b, §5.3). Everything rendered here exists in world state: a structure
// mesh is created from a cell record and removed when the cell record loses
// it. Nothing decorative, ever.

import * as THREE from "three";
import { PALETTE, CELL, stoneMaterial } from "../theme.js";
import { cellToWorld } from "./ground.js";

// Shared geometries per form (spec §9: instanced per form — at this scale,
// shared BufferGeometry with per-mesh materials carries the same win, and
// weathering needs per-structure material state).
const geometries = {};
function geo(name, make) {
  if (!geometries[name]) geometries[name] = make();
  return geometries[name];
}

// Each builder returns a Group of parts; every part flagged for shadows.
// Part.userData.dustBias marks parts that sit low (they dust up first).
const FORM_BUILDERS = {
  marker() {
    const g = new THREE.Group();
    g.add(part(geo("marker-base", () => new THREE.BoxGeometry(0.3, 0.06, 0.3)), 0, 0.03, 0));
    g.add(part(geo("marker-slab", () => new THREE.BoxGeometry(0.14, 0.72, 0.08)), 0, 0.42, 0));
    return g;
  },
  wall() {
    const g = new THREE.Group();
    // Long low box, offset toward one cell edge.
    g.add(part(geo("wall-run", () => new THREE.BoxGeometry(0.9, 0.34, 0.16)), 0, 0.17, -0.3));
    g.add(part(geo("wall-cap", () => new THREE.BoxGeometry(0.94, 0.05, 0.2)), 0, 0.365, -0.3));
    return g;
  },
  platform() {
    const g = new THREE.Group();
    g.add(part(geo("platform-slab", () => new THREE.BoxGeometry(0.82, 0.12, 0.82)), 0, 0.14, 0));
    g.add(part(geo("platform-step", () => new THREE.BoxGeometry(0.3, 0.07, 0.2)), 0, 0.035, 0.5));
    return g;
  },
  pit() {
    const g = new THREE.Group();
    // Recessed box cut into the ground plane: a dark floor below grade and a
    // low rim, so the void reads from every angle.
    const floor = part(geo("pit-floor", () => new THREE.BoxGeometry(0.6, 0.02, 0.6)), 0, -0.14, 0);
    floor.userData.pitFloor = true;
    g.add(floor);
    g.add(part(geo("pit-rim-n", () => new THREE.BoxGeometry(0.74, 0.06, 0.07)), 0, 0.03, -0.335));
    g.add(part(geo("pit-rim-s", () => new THREE.BoxGeometry(0.74, 0.06, 0.07)), 0, 0.03, 0.335));
    g.add(part(geo("pit-rim-e", () => new THREE.BoxGeometry(0.07, 0.06, 0.6)), 0.335, 0.03, 0));
    g.add(part(geo("pit-rim-w", () => new THREE.BoxGeometry(0.07, 0.06, 0.6)), -0.335, 0.03, 0));
    return g;
  },
  hut() {
    const g = new THREE.Group();
    g.add(part(geo("hut-body", () => new THREE.BoxGeometry(0.62, 0.4, 0.56)), 0, 0.2, 0));
    g.add(part(geo("hut-roof", () => new THREE.BoxGeometry(0.74, 0.06, 0.68)), 0, 0.43, 0));
    // Doorway void: a near-black inset, not a hole — reads as an opening.
    const door = part(geo("hut-door", () => new THREE.BoxGeometry(0.16, 0.26, 0.02)), 0, 0.13, 0.284);
    door.userData.void = true;
    g.add(door);
    return g;
  },
  tower() {
    const g = new THREE.Group();
    g.add(part(geo("tower-base", () => new THREE.BoxGeometry(0.5, 0.12, 0.5)), 0, 0.06, 0));
    g.add(part(geo("tower-mid", () => new THREE.BoxGeometry(0.4, 0.12, 0.4)), 0, 0.18, 0));
    g.add(part(geo("tower-shaft", () => new THREE.BoxGeometry(0.3, 1.1, 0.3)), 0, 0.79, 0));
    const aperture = part(geo("tower-aperture", () => new THREE.BoxGeometry(0.08, 0.14, 0.02)), 0, 1.12, 0.152);
    aperture.userData.void = true;
    g.add(aperture);
    return g;
  },
};

function part(geometry, x, y, z) {
  const mesh = new THREE.Mesh(geometry, null); // material assigned per structure
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (y < 0.15) mesh.userData.dustBias = true;
  return mesh;
}

// Demolition debris: a few low broken masses at the base, count scaled by
// progress. State-driven (demolishProgress), not decoration.
function debrisCluster(progressFrac, material) {
  const g = new THREE.Group();
  const count = Math.round(progressFrac * 5);
  for (let i = 0; i < count; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.7;
    const m = new THREE.Mesh(geo(`debris-${i % 3}`, () => new THREE.BoxGeometry(0.1 + (i % 3) * 0.03, 0.06, 0.08)), material);
    m.position.set(Math.cos(angle) * 0.34, 0.03, Math.sin(angle) * 0.34);
    m.rotation.y = angle * 1.7;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export function createStructures(scene, gridSize, { weathering = true } = {}) {
  const group = new THREE.Group();
  group.name = "structures";
  scene.add(group);

  const byCoord = new Map(); // coord -> {root, record, materials, inscribedPanel, debris}

  function build(coord, structure, tick) {
    const builder = FORM_BUILDERS[structure.form] ?? FORM_BUILDERS.marker;
    const root = new THREE.Group();
    const stone = stoneMaterial(PALETTE.structure);
    const stoneAlt = stoneMaterial(PALETTE.structureAlt);
    const voidMat = stoneMaterial(0x191713, { roughness: 0.98 });

    const body = builder();
    body.children.forEach((mesh, i) => {
      mesh.material = mesh.userData.void || mesh.userData.pitFloor ? voidMat : i % 2 === 0 ? stone : stoneAlt;
    });
    root.add(body);

    // Inscribed structures get a faint recessed panel on one face (spec
    // §5.2): not readable in 3D, but visibly marked.
    const panel = new THREE.Mesh(
      geo("inscribed-panel", () => new THREE.PlaneGeometry(0.16, 0.1)),
      stoneMaterial(0xb3ab9c, { roughness: 0.98 })
    );
    panel.position.set(0, 0.24, structure.form === "wall" ? -0.218 : 0.29);
    if (structure.form === "wall") panel.rotation.y = Math.PI;
    panel.visible = false;
    root.add(panel);

    const p = cellToWorld(coord, gridSize);
    root.position.set(p.x, 0, p.z);
    // Deterministic slight rotation from the coordinate, so a street of
    // structures does not read as stamped copies. Data-derived, not random.
    const [cx, cy] = coord.split(",").map(Number);
    root.rotation.y = ((cx * 7 + cy * 13) % 10) * 0.02 - 0.09;
    group.add(root);

    const entry = { root, body, record: structure, materials: [stone, stoneAlt], panel, debris: null, builtAtTick: structure.builtAtTick ?? tick };
    byCoord.set(coord, entry);
    return entry;
  }

  function applyWeathering(entry, tick) {
    if (!weathering) return;
    // Age from tick - builtAtTick: roughness rises, dust builds toward the
    // base, edge contrast softens (color drifts toward the ground's dust).
    const age = Math.max(0, tick - (entry.builtAtTick ?? tick));
    const aged = Math.min(1, age / 300);
    const dust = new THREE.Color(PALETTE.haze);
    entry.materials.forEach((m, i) => {
      const base = new THREE.Color(i === 0 ? PALETTE.structure : PALETTE.structureAlt);
      m.roughness = Math.min(1, 0.88 + aged * 0.12);
      m.color.copy(base).lerp(dust, aged * 0.35);
    });
    // Low parts dust up harder.
    entry.body.children.forEach((mesh) => {
      if (mesh.userData.dustBias && mesh.material !== entry.materials[0] && mesh.material !== entry.materials[1]) return;
      if (mesh.userData.dustBias) {
        mesh.material = mesh.material.clone();
        const c = mesh.material.color.clone();
        mesh.material.color.copy(c).lerp(dust, aged * 0.25);
      }
    });
  }

  function applyDemolition(entry, structure) {
    const progress = structure.demolishProgress;
    const frac = progress ? progress.ticks / progress.required : 0;
    // Visible disassembly proportional to progress (spec §5.2b): mass
    // reduces, edges open, debris gathers at the base. No spectacle.
    entry.body.scale.y = 1 - frac * 0.45;
    entry.body.rotation.z = frac * 0.06;
    entry.body.children.forEach((mesh, i) => {
      const spread = frac * 0.06 * ((i % 3) - 1);
      mesh.position.x += spread - (mesh.userData.lastSpread ?? 0);
      mesh.userData.lastSpread = spread;
    });
    if (entry.debris) entry.root.remove(entry.debris);
    entry.debris = frac > 0 ? debrisCluster(frac, stoneMaterial(PALETTE.rubble)) : null;
    if (entry.debris) entry.root.add(entry.debris);
  }

  // Called once per new state. Creates, updates, and removes structure
  // meshes strictly from cell records.
  function sync(state) {
    const seen = new Set();
    for (const cell of state.cells.values()) {
      if (!cell.structure) continue;
      seen.add(cell.coord);
      let entry = byCoord.get(cell.coord);
      const rebuilt = entry && entry.record.form !== cell.structure.form;
      if (rebuilt) {
        group.remove(entry.root);
        byCoord.delete(cell.coord);
        entry = null;
      }
      if (!entry) entry = build(cell.coord, cell.structure, state.tick);
      entry.record = cell.structure;
      entry.builtAtTick = cell.structure.builtAtTick ?? entry.builtAtTick;
      entry.panel.visible = (cell.structure.inscription?.entries?.length ?? 0) > 0;
      applyDemolition(entry, cell.structure);
      applyWeathering(entry, state.tick);
    }
    for (const [coord, entry] of byCoord) {
      if (!seen.has(coord)) {
        // Removed from world state — demolished, razed. No effects: a
        // structure that was there and now is not carries the weight.
        group.remove(entry.root);
        byCoord.delete(coord);
      }
    }
  }

  // For hover labels: the structure entry under a raycast hit, if any.
  function entryAt(coord) {
    return byCoord.get(coord) ?? null;
  }

  return { group, sync, entryAt, byCoord };
}
