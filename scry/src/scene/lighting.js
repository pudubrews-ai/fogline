// Sun driven by simTime (observatory spec §4.3): long raking shadows at
// 06:00, high and neutral at noon, warm and long at 18:00 — and at night a
// MOONLIGHT FLOOR (spec v0.6 §2): cool, dim, blue-shifted ambient, enough
// to read geometry as silhouette. Night stays visually distinct rather
// than merely absent; the agents' eyes remain the only saturated element.
//
// The whole lighting state is computed by the pure `lightingAt(minutes)`
// so tests can assert the floor headlessly; `update` only applies it.

import * as THREE from "three";
import { PALETTE } from "../theme.js";

// "HH:MM" -> minutes since midnight; null tolerated before the first tick.
export const minutesOf = (simTime) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(simTime ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60;
};

// The operator lighting override (spec v0.6 §2): follow sim time, or hold
// at a fixed hour. Not diegetic — the pragmatic answer when the thing you
// want to inspect happens at 2am.
export const effectiveSimTime = (simTime, override) =>
  override == null || override === "follow" ? simTime : override;

// Night never falls below this ambient. The floor is what makes a long
// run's nights watchable; raise it and night stops being night.
export const MOONLIGHT_FLOOR = 0.42;

export function lightingAt(minutes) {
  const dayFrac = minutes / 1440; // 0..1 over the day
  // Sun elevation: below the horizon before 05:30 and after 20:30, peaking
  // at 13:00. Azimuth sweeps east to west.
  const daylight = Math.sin(Math.PI * Math.min(1, Math.max(0, (minutes - 330) / (1230 - 330))));
  const elevation = daylight * (Math.PI / 2.6);
  const azimuth = (dayFrac - 0.25) * Math.PI * 2;
  const night = daylight <= 0.02;

  if (night) {
    // Moon-grade key light plus the ambient floor: cool, dim, blue-shifted.
    return {
      night,
      daylight,
      elevation,
      azimuth,
      sunIntensity: 0.12, // moon-grade key: dim, so the eyes still carry the frame
      sunColor: { hex: 0x9aa8c0 },
      fillIntensity: MOONLIGHT_FLOOR,
      fillSky: 0x38425c,
      fillGround: 0x232838,
      background: 0x262a36,
    };
  }
  const warmth = 1 - daylight; // 1 at sunrise/sunset, 0 at peak
  return {
    night,
    daylight,
    elevation,
    azimuth,
    sunIntensity: 0.5 + daylight * 2.0,
    sunColor: { hsl: [0.09 - 0.02 * daylight, 0.35 * warmth + 0.08, 0.85] },
    fillIntensity: 0.3 + daylight * 0.3,
    fillSky: null, // daytime keeps the hemisphere's seeded colors
    fillGround: null,
    background: null, // derived from the haze below
  };
}

export function createLighting(scene, gridSize) {
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
  sun.castShadow = true;
  const half = gridSize / 2 + 1;
  // Shadow camera tightly fitted to the grid, not the world (spec §9).
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = gridSize * 4 + 10;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const daySky = 0x8a94a4;
  const dayGround = 0x4a453e;
  const fill = new THREE.HemisphereLight(daySky, dayGround, 0.5);
  scene.add(fill);

  scene.fog = new THREE.Fog(PALETTE.haze, gridSize * 1.6, gridSize * 5.5);
  scene.background = new THREE.Color(PALETTE.haze).multiplyScalar(0.75);

  // `override` (spec v0.6 §2): null/"follow" tracks sim time; "HH:MM"
  // holds the lights at that hour regardless of what the world's clock says.
  function update(simTime, override = null) {
    const state = lightingAt(minutesOf(effectiveSimTime(simTime, override)));
    const r = gridSize * 2.2;
    sun.position.set(
      Math.cos(state.azimuth) * Math.cos(state.elevation) * r,
      Math.max(0.2, Math.sin(state.elevation) * r),
      Math.sin(state.azimuth) * Math.cos(state.elevation) * r
    );
    sun.target.position.set(0, 0, 0);
    sun.intensity = state.sunIntensity;
    if (state.sunColor.hex != null) sun.color.setHex(state.sunColor.hex);
    else sun.color.setHSL(...state.sunColor.hsl);
    fill.intensity = state.fillIntensity;
    if (state.night) {
      fill.color.setHex(state.fillSky);
      fill.groundColor.setHex(state.fillGround);
      scene.background.setHex(state.background);
      scene.fog.color.setHex(state.background);
    } else {
      fill.color.setHex(daySky);
      fill.groundColor.setHex(dayGround);
      // Sky held clearly above the ground's value (spec §2.6): the plane
      // must sit ON something, not float in a void of its own value.
      const sky = new THREE.Color(PALETTE.haze).multiplyScalar(0.72 + state.daylight * 0.45);
      scene.background.copy(sky);
      scene.fog.color.copy(sky);
    }
    return { daylight: state.daylight, night: state.night };
  }

  return { sun, fill, update };
}
