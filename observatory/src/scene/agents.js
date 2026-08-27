// Sphere robots (observatory spec §5.4, §5.5): a sphere, an emissive eye
// panel, two side discs. Hovering, bobbing, gliding between cells. Every
// expression cue lives in the eyes, because they are the only saturated
// thing in the frame. All of it is driven by state and signals — nothing
// here invents behavior.

import * as THREE from "three";
import { AGENT_SCALE, eyeMaterial, stoneMaterial } from "../theme.js";
import { cellToWorld } from "./ground.js";

const sphereGeo = new THREE.SphereGeometry(1, 28, 20);
// Eyes anchor the frame as the only emissive, saturated element and must be
// readable at default zoom (spec §2.5) — sized as features, not slivers.
const eyeGeo = new THREE.CircleGeometry(0.26, 20);
const discGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.05, 18);

const EYE_LAYOUT = {
  pair: [
    [-0.28, 0.15],
    [0.28, 0.15],
  ],
  single: [[0, 0.18]],
  wide: [
    [-0.52, 0.12],
    [0.52, 0.12],
  ],
};

function shellDetail(shell, bodyMat) {
  const g = new THREE.Group();
  if (shell === "panelled") {
    // Inset seam lines: two thin rings.
    for (const y of [-0.25, 0.3]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.sqrt(1 - y * y) * 0.995, 0.012, 6, 40), bodyMat.clone());
      ring.material.color.multiplyScalar(0.85);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      g.add(ring);
    }
  } else if (shell === "ridged") {
    for (const y of [-0.4, -0.1, 0.2, 0.5]) {
      const r = Math.sqrt(Math.max(0.05, 1 - y * y));
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.05, 24, 1, true), bodyMat.clone());
      band.material.color.multiplyScalar(0.92);
      band.position.y = y;
      g.add(band);
    }
  }
  return g;
}

function makeBubble() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.visible = false;
  return { sprite, canvas, texture };
}

function drawBubble({ canvas, texture }, text) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(24,23,21,0.88)";
  ctx.beginPath();
  ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 18);
  ctx.fill();
  ctx.fillStyle = "#d8d2c6";
  ctx.font = "26px ui-monospace, monospace";
  const words = String(text).split(/\s+/);
  let line = "";
  let y = 44;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > canvas.width - 40) {
      ctx.fillText(line, 20, y);
      y += 32;
      line = word;
      if (y > canvas.height - 16) {
        line += "…";
        break;
      }
    } else line = next;
  }
  ctx.fillText(line, 20, y);
  texture.needsUpdate = true;
}

// Eye-cast light selection (observatory spec v0.6 §2): the nearest few lit
// agents get a small warm point light, so the night world is lit by its
// inhabitants. Pure, so the cap is testable headless: candidates are
// {id, x, z, lit}; returns at most `cap` ids, nearest to `focus` first.
export function pickEyeLights(candidates, focus, cap) {
  const lit = candidates.filter((c) => c.lit);
  if (focus) {
    lit.sort(
      (a, b) =>
        (a.x - focus.x) ** 2 + (a.z - focus.z) ** 2 - ((b.x - focus.x) ** 2 + (b.z - focus.z) ** 2)
    );
  }
  return lit.slice(0, Math.max(0, cap)).map((c) => c.id);
}

export function createAgents(scene, gridSize, { eyeLightCap = 6 } = {}) {
  const group = new THREE.Group();
  group.name = "agents";
  scene.add(group);

  // The point-light pool: capped for performance, recycled every frame. A
  // crowded cell is visibly brighter than an empty one because more of its
  // occupants hold a light.
  const eyeLights = [];
  for (let i = 0; i < eyeLightCap; i++) {
    const light = new THREE.PointLight(0xffb066, 0.0, 2.6, 2);
    light.name = "eye-light";
    light.visible = false;
    group.add(light);
    eyeLights.push(light);
  }

  const byId = new Map(); // agentId -> visual

  function build(agent) {
    const root = new THREE.Group();
    const scale = (AGENT_SCALE[agent.appearance?.scale] ?? AGENT_SCALE.medium) * (agent.lifeStage === "infant" ? 0.5 : 1);

    // The daemon clamps saturation, not lightness — but a very dark body
    // collapses into the ground value under the filmic curve (spec §2.4).
    // Display-side lightness floor: hue and saturation kept, value lifted
    // just enough that five different bodies read as five colors.
    const bodyColor = new THREE.Color(agent.appearance?.bodyColor ?? "#7f7f7f");
    const hsl = {};
    bodyColor.getHSL(hsl);
    if (hsl.l < 0.34) bodyColor.setHSL(hsl.h, hsl.s, 0.34);
    const bodyMat = stoneMaterial(bodyColor, { roughness: 0.88 });
    const body = new THREE.Mesh(sphereGeo, bodyMat);
    body.castShadow = true;
    body.scale.setScalar(scale);
    root.add(body);

    const detail = shellDetail(agent.appearance?.shell, bodyMat);
    detail.scale.setScalar(scale);
    root.add(detail);

    // Eyes: the only bloom source in the frame.
    const eyeMat = eyeMaterial(agent.appearance?.eyeColor ?? "#22ccee", agent.lifeStage === "infant" ? 0.9 : 2.0);
    const head = new THREE.Group();
    for (const [ex, ey] of EYE_LAYOUT[agent.appearance?.eyes] ?? EYE_LAYOUT.pair) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(ex * scale, ey * scale, scale * 0.99);
      eye.scale.setScalar(scale);
      head.add(eye);
    }
    root.add(head);

    // Two side discs.
    for (const side of [-1, 1]) {
      const disc = new THREE.Mesh(discGeo, bodyMat.clone());
      disc.material.color.multiplyScalar(0.9);
      disc.rotation.z = Math.PI / 2;
      disc.position.set(side * scale * 1.02, 0, 0);
      disc.scale.setScalar(scale);
      disc.castShadow = true;
      root.add(disc);
    }

    // No contact-shadow disc (spec §2.3): that shortcut bypassed the
    // material factory and read as a dark ellipse. Grounding comes from the
    // sun's real cast shadows — every body part casts.

    const bubble = makeBubble();
    bubble.sprite.position.y = scale + 0.55;
    root.add(bubble.sprite);

    group.add(root);
    return {
      root,
      body,
      eyeMat,
      bubble,
      scale,
      agent,
      // animation state
      from: null,
      to: null,
      moveStart: 0,
      bobPhase: Math.random() * Math.PI * 2,
      thinkingUntil: 0,
      speakingUntil: 0,
      faceTarget: null,
    };
  }

  const hoverBase = (v) => v.scale + 0.12;

  function placeAt(v, coord) {
    const p = cellToWorld(coord, gridSize);
    v.root.position.set(p.x, hoverBase(v), p.z);
  }

  // Sync from a new reducer state: create arrivals, remove the departed,
  // start glides where coords changed, surface speaking/attack cues from the
  // tick's events.
  function sync(state, now = performance.now()) {
    const seen = new Set();
    for (const agent of state.agents.values()) {
      if (agent.lifeStage === "infant" && !byId.has(agent.agentId)) {
        // Infants render at half scale (built below like anyone else).
      }
      seen.add(agent.agentId);
      let v = byId.get(agent.agentId);
      if (!v) {
        v = build(agent);
        byId.set(agent.agentId, v);
        placeAt(v, agent.coord);
      }
      v.agent = agent;
      if (agent.prevCoord !== agent.coord) {
        v.from = cellToWorld(agent.prevCoord, gridSize);
        v.to = cellToWorld(agent.coord, gridSize);
        v.moveStart = now;
      } else if (!v.to) {
        placeAt(v, agent.coord);
      }
    }
    for (const [id, v] of byId) {
      if (!seen.has(id)) {
        group.remove(v.root);
        byId.delete(id);
      }
    }

    // Speech cues from this tick's events; the bubble holds a few seconds.
    for (const ev of state.events.slice(-40)) {
      if (ev.tick !== state.tick) continue;
      if (ev.type === "speech") {
        const v = byId.get(ev.speaker);
        if (v) {
          drawBubble(v.bubble, ev.text);
          v.bubble.sprite.visible = true;
          v.speakingUntil = now + 4000;
          // Listeners turn toward the speaker.
          for (const other of byId.values()) {
            if (other !== v && other.agent.coord === v.agent.coord) other.faceTarget = v;
          }
          const nearest = [...byId.values()].find((o) => o !== v && o.agent.coord === v.agent.coord);
          if (nearest) v.faceTarget = nearest;
        }
      }
    }
  }

  // Live latency signals: observation_emitted starts thinking; the matching
  // action_received ends it. Replay calls thinkFor with the recorded latency.
  function onSignal(event, data, now = performance.now()) {
    if (event === "barrier" && data.event === "observation_emitted") {
      const v = byId.get(data.agentId);
      if (v) v.thinkingUntil = Infinity;
    }
    if (event === "barrier" && data.event === "action_received") {
      const v = byId.get(data.agentId);
      if (v) v.thinkingUntil = now;
    }
  }

  function thinkFor(agentId, ms, now = performance.now()) {
    const v = byId.get(agentId);
    if (v && ms > 0) v.thinkingUntil = now + ms;
  }

  const band = (value, high, low) => (value > high ? "hale" : value > low ? "hurt" : "failing");

  // Per-frame animation. States per spec §5.5. `focus` (a world-space
  // position, usually the camera's) chooses which agents hold the capped
  // eye lights; without one, any lit agents fill the pool in roster order.
  function update(now, dt, focus = null) {
    const candidates = [...byId.values()].map((v) => ({
      id: v.agent.agentId,
      x: v.root.position.x,
      z: v.root.position.z,
      // Unmanned bodies have dark eyes and cast nothing.
      lit: v.agent.connectionState !== "unmanned",
    }));
    const chosen = pickEyeLights(candidates, focus, eyeLightCap);
    eyeLights.forEach((light, i) => {
      const v = byId.get(chosen[i]);
      if (v) {
        light.visible = true;
        light.position.set(v.root.position.x, v.root.position.y + v.scale * 0.3, v.root.position.z + v.scale * 0.6);
        // Brightness follows the eye material, so thinking/stalled dimming
        // reads on the ground too.
        light.intensity = 0.45 * (v.eyeMat.emissiveIntensity ?? 1);
      } else {
        light.visible = false;
        light.intensity = 0;
      }
    });
    for (const v of byId.values()) {
      const a = v.agent;
      const thinking = now < v.thinkingUntil;
      const speaking = now < v.speakingUntil;
      if (!speaking) v.bubble.sprite.visible = false;

      // Glide between cells: eased, about one second.
      if (v.to) {
        const t = Math.min(1, (now - v.moveStart) / 1000);
        const e = t * t * (3 - 2 * t);
        v.root.position.x = v.from.x + (v.to.x - v.from.x) * e;
        v.root.position.z = v.from.z + (v.to.z - v.from.z) * e;
        if (t >= 1) v.to = null;
      }

      const unmanned = a.connectionState === "unmanned";
      const stalled = a.connectionState === "stalled";
      const infant = a.lifeStage === "infant";
      const vband = band(a.vitality, 66, 25);
      const failing = vband === "failing";
      const hurt = vband === "hurt";

      // Bob: none for infants and the unmanned; slowed when thinking;
      // irregular when hurt; a slight downward drift when failing.
      let bobSpeed = thinking ? 0.9 : 1.8;
      let bobAmp = 0.045;
      if (hurt || failing) {
        bobSpeed = 2.6;
        bobAmp = 0.03 + 0.02 * Math.sin(now / 230 + v.bobPhase * 3); // irregular
      }
      v.bobPhase += dt * bobSpeed;
      let y = hoverBase(v) + (infant || unmanned ? 0 : Math.sin(v.bobPhase) * bobAmp);
      if (unmanned) y = v.scale + 0.03; // resting lower, static
      if (failing) y -= 0.05;
      v.root.position.y = y;

      // Eyes: the whole expression channel.
      let intensity = infant ? 0.9 : 2.0;
      if (thinking) intensity = 0.8; // ~40%
      if (stalled) intensity = 0.3; // ~15%
      if (unmanned) intensity = 0.0; // off
      if ((hurt || failing) && !unmanned) {
        intensity *= 0.75 + 0.25 * Math.sin(now / 90 + v.bobPhase); // flicker
      }
      v.eyeMat.emissiveIntensity += (intensity - v.eyeMat.emissiveIntensity) * Math.min(1, dt * 8);

      // Facing: toward a speaker or listener; slow gaze drift when idle.
      if (v.faceTarget && byId.has(v.faceTarget.agent?.agentId)) {
        const target = v.faceTarget.root.position;
        const desired = Math.atan2(target.x - v.root.position.x, target.z - v.root.position.z);
        v.root.rotation.y += (desired - v.root.rotation.y) * Math.min(1, dt * 4);
      } else if (!unmanned && !infant) {
        v.root.rotation.y += Math.sin(now / 5200 + v.bobPhase) * 0.0006;
      }
      if (thinking) v.root.rotation.z += (0.06 - v.root.rotation.z) * Math.min(1, dt * 3);
      else v.root.rotation.z += (0 - v.root.rotation.z) * Math.min(1, dt * 3);
    }
  }

  return { group, byId, sync, update, onSignal, thinkFor };
}
