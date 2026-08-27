// The v0.3 appearance schema (protocol §13.2) and the color math shared by
// registration validation and genotype composition. This module imports
// nothing from world/ — it sits below both world.js and genotype.js.
//
// The saturation ceiling is a rendering contract, not taste: bodies stay
// muted so that eyes are the only saturated element in the frame.

export const APPEARANCE_ENUMS = {
  scale: ["small", "medium", "large"],
  shell: ["smooth", "panelled", "ridged"],
  eyes: ["pair", "single", "wide"],
};

export const DEFAULT_SATURATION_CEILING = 0.35;

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const isHexColor = (value) => typeof value === "string" && COLOR_RE.test(value);

// ---------- hex <-> HSL ----------

export function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
}

export function hslToHex({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const toByte = (v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export const saturationOf = (hex) => hexToHsl(hex).s;
