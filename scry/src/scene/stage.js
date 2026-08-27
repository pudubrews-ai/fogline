// Renderer, composer, post chain (observatory spec §4.4): subtle SSAO,
// UnrealBloom with a high threshold so only eyes bloom, ACES filmic tone
// mapping, a slight vignette. No motion blur, no depth of field, no
// chromatic aberration.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - strength * smoothstep(0.35, 0.85, d);
      gl_FragColor = color;
    }`,
};

export function createStage(container, { post = {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  let ssaoPass = null;
  if (post.ssao !== false) {
    ssaoPass = new SSAOPass(scene, camera, container.clientWidth, container.clientHeight);
    ssaoPass.kernelRadius = 0.4;
    ssaoPass.minDistance = 0.001;
    ssaoPass.maxDistance = 0.08;
    composer.addPass(ssaoPass);
  }

  let bloomPass = null;
  if (post.bloom !== false) {
    // Threshold high: agent bodies and stone sit far below it; only the
    // emissive eyes cross it (observatory spec §4.4, acceptance 7).
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.6, // strength
      0.25, // radius
      0.9 // threshold
    );
    composer.addPass(bloomPass);
  }

  if (post.vignette !== false) {
    composer.addPass(new ShaderPass(VignetteShader));
  }
  composer.addPass(new OutputPass());

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    ssaoPass?.setSize(w, h);
  }
  window.addEventListener("resize", resize);

  return {
    renderer,
    scene,
    camera,
    composer,
    render: () => composer.render(),
    resize,
  };
}
