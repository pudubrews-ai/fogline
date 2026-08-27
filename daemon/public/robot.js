// Figure construction and state rendering, v0.3 appearance schema: agents
// are SPHERES. bodyColor fills the body (muted by the saturation ceiling),
// eyeColor is the one emissive element in frame, scale sets the radius,
// shell picks the surface treatment, eyes the arrangement. Nothing is drawn
// by hand per agent. Named sub-groups remain the transform targets:
//   #<id>-head, #<id>-pupil-left, #<id>-pupil-right, #<id>-arm-right, #<id>-body

const STATES = ["idle", "listening", "thinking", "speaking", "stalled", "unmanned"];

const SCALES = {
  small: { r: 30 },
  medium: { r: 38 },
  large: { r: 46 },
};

// Surface treatment per shell type, drawn inside the sphere.
function shellMarkup(shell, cx, cy, r) {
  if (shell === "panelled") {
    return `
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy}" class="shell-line" fill="none"/>
      <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" class="shell-line"/>`;
  }
  if (shell === "ridged") {
    const arcs = [];
    for (const k of [-0.55, 0, 0.55]) {
      const y = cy + k * r;
      const half = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy))) * 0.92;
      arcs.push(`<path d="M ${cx - half} ${y} Q ${cx} ${y + r * 0.18} ${cx + half} ${y}" class="shell-line" fill="none"/>`);
    }
    return arcs.join("");
  }
  return ""; // smooth
}

// Eye arrangement. Eyes are the only saturated element: eyeColor fills them.
function eyesMarkup(eyes, id, cx, cy, r, eyeColor) {
  const ey = cy - r * 0.18;
  if (eyes === "single") {
    return `
      <circle cx="${cx}" cy="${ey}" r="${r * 0.3}" class="eye" fill="${eyeColor}"/>
      <circle id="${id}-pupil-left" cx="${cx}" cy="${ey}" r="${r * 0.12}" class="pupil"/>
      <circle id="${id}-pupil-right" cx="${cx}" cy="${ey}" r="0.01" class="pupil"/>`;
  }
  if (eyes === "wide") {
    return `
      <circle cx="${cx - r * 0.55}" cy="${ey}" r="${r * 0.2}" class="eye" fill="${eyeColor}"/>
      <circle cx="${cx + r * 0.55}" cy="${ey}" r="${r * 0.2}" class="eye" fill="${eyeColor}"/>
      <circle id="${id}-pupil-left" cx="${cx - r * 0.55}" cy="${ey}" r="${r * 0.09}" class="pupil"/>
      <circle id="${id}-pupil-right" cx="${cx + r * 0.55}" cy="${ey}" r="${r * 0.09}" class="pupil"/>`;
  }
  // pair
  return `
    <circle cx="${cx - r * 0.32}" cy="${ey}" r="${r * 0.22}" class="eye" fill="${eyeColor}"/>
    <circle cx="${cx + r * 0.32}" cy="${ey}" r="${r * 0.22}" class="eye" fill="${eyeColor}"/>
    <circle id="${id}-pupil-left" cx="${cx - r * 0.32}" cy="${ey}" r="${r * 0.1}" class="pupil"/>
    <circle id="${id}-pupil-right" cx="${cx + r * 0.32}" cy="${ey}" r="${r * 0.1}" class="pupil"/>`;
}

// agent: { id, name, appearance: {bodyColor, eyeColor, scale, shell, eyes}, lifeStage? }
export function buildFigure(agent) {
  const p = agent.id;
  const a = agent.appearance ?? {};
  const color = a.bodyColor ?? "#8b90a1";
  const eyeColor = a.eyeColor ?? "#ffd000";
  let { r } = SCALES[a.scale] ?? SCALES.medium;
  if (agent.lifeStage === "infant") r = Math.round(r * 0.55);

  const cx = 60;
  const cy = 150 - r - 4; // sit on the ground line
  const name = agent.name ?? "unnamed";

  const wrap = document.createElement("div");
  wrap.className = "figure state-idle";
  wrap.dataset.agentId = p;
  wrap.style.setProperty("--gaze", "0");
  wrap.innerHTML = `
    <div class="bubble" hidden></div>
    <svg class="robot" viewBox="0 0 120 150" aria-label="${name}">
      <g id="${p}-body" class="robot-body">
        <g id="${p}-arm-right" class="arm-right"></g>
        <g id="${p}-head" class="head">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="torso"/>
          ${shellMarkup(a.shell, cx, cy, r)}
          ${eyesMarkup(a.eyes, p, cx, cy, r, eyeColor)}
        </g>
      </g>
    </svg>
    <div class="nameplate" style="color:${color}">${name}</div>`;
  return wrap;
}

export function setFigureState(figure, state) {
  if (!STATES.includes(state)) state = "idle";
  for (const s of STATES) figure.classList.toggle(`state-${s}`, s === state);
}

// gaze: -1 target is to the left, 1 to the right, 0 nobody to look at.
export function setGaze(figure, gaze) {
  figure.style.setProperty("--gaze", String(gaze));
}

export function showBubble(figure, text, ms = 4200) {
  const bubble = figure.querySelector(".bubble");
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(bubble._timer);
  bubble._timer = setTimeout(() => {
    bubble.hidden = true;
  }, ms);
}
