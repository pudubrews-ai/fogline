// Camera modes (observatory spec §6): orbit (default, never below ground),
// follow (trailing three-quarter, eased), free (WASD + mouse look), director
// (auto-cuts to activity, minimum shot hold so cuts do not strobe).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { cellToWorld } from "./ground.js";

export function createCameraRig({ camera, dom, gridSize, minShotTicks = 3 }) {
  let mode = "orbit";

  const orbit = new OrbitControls(camera, dom);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI / 2 - 0.06; // no going below ground
  orbit.minDistance = 2;
  orbit.maxDistance = gridSize * 4;
  camera.position.set(gridSize * 0.9, gridSize * 0.85, gridSize * 1.15);
  orbit.target.set(0, 0.2, 0);

  // Follow state.
  let followId = null;
  let getAgentPosition = () => null;

  // Free-cam state.
  const keys = new Set();
  let yaw = 0;
  let pitch = -0.3;
  dom.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  dom.addEventListener("mousemove", (e) => {
    if (mode === "free" && e.buttons === 2) {
      yaw -= e.movementX * 0.003;
      pitch = Math.max(-1.4, Math.min(1.2, pitch - e.movementY * 0.003));
    }
  });
  dom.addEventListener("contextmenu", (e) => {
    if (mode === "free") e.preventDefault();
  });

  // Director state: cut to activity, hold at least minShotTicks ticks.
  let directorShot = null; // {coord, sinceTick}
  let lastEventIndex = 0;

  const DIRECTOR_KINDS = new Set(["speech", "attack", "beget", "death", "build", "raze", "demolish_complete", "matured"]);

  function setMode(next) {
    mode = next;
    orbit.enabled = next === "orbit";
    if (next === "free") {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      yaw = Math.atan2(-dir.x, -dir.z) + Math.PI;
      pitch = Math.asin(dir.y);
    }
  }

  function follow(agentId) {
    followId = agentId;
    if (agentId) setMode("follow");
  }

  function bindAgentLookup(fn) {
    getAgentPosition = fn;
  }

  // The director scans new events each state; a cut moves the shot target.
  function onState(state) {
    if (mode !== "director") {
      lastEventIndex = state.events.length;
      return;
    }
    for (; lastEventIndex < state.events.length; lastEventIndex++) {
      const ev = state.events[lastEventIndex];
      if (!DIRECTOR_KINDS.has(ev.type)) continue;
      const coord = ev.coord ?? ev.to ?? null;
      if (!coord) continue;
      if (directorShot && state.tick - directorShot.sinceTick < minShotTicks) continue; // hold the shot
      directorShot = { coord, sinceTick: state.tick };
    }
  }

  function update(dt) {
    if (mode === "orbit") {
      orbit.update();
    } else if (mode === "follow" && followId) {
      const p = getAgentPosition(followId);
      if (p) {
        // Trailing three-quarter view, eased.
        const desired = new THREE.Vector3(p.x + 2.2, p.y + 1.7, p.z + 2.6);
        camera.position.lerp(desired, Math.min(1, dt * 2.2));
        camera.lookAt(p.x, p.y + 0.2, p.z);
      }
    } else if (mode === "free") {
      const speed = (keys.has("ShiftLeft") ? 9 : 4) * dt;
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      if (keys.has("KeyW")) camera.position.addScaledVector(forward, speed);
      if (keys.has("KeyS")) camera.position.addScaledVector(forward, -speed);
      if (keys.has("KeyA")) camera.position.addScaledVector(right, -speed);
      if (keys.has("KeyD")) camera.position.addScaledVector(right, speed);
      if (keys.has("KeyQ")) camera.position.y -= speed;
      if (keys.has("KeyE")) camera.position.y += speed;
      camera.position.y = Math.max(0.2, camera.position.y);
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
    } else if (mode === "director") {
      const target = directorShot ? cellToWorld(directorShot.coord, gridSize) : { x: 0, z: 0 };
      const desired = new THREE.Vector3(target.x + 2.4, 2.1, target.z + 3.0);
      camera.position.lerp(desired, Math.min(1, dt * 1.4));
      const look = new THREE.Vector3(target.x, 0.35, target.z);
      const current = new THREE.Vector3();
      camera.getWorldDirection(current).multiplyScalar(5).add(camera.position);
      current.lerp(look, Math.min(1, dt * 2));
      camera.lookAt(current);
    }
  }

  return { setMode, follow, bindAgentLookup, onState, update, get mode() { return mode; }, get followId() { return followId; } };
}
