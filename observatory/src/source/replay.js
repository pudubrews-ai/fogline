// ticks.log loader + seek. No daemon required: the file is JSON lines,
// segmented into runs at every run_started boundary (daemon spec §4.4), each
// run folded through the SHARED reducer with a keyframe every KEYFRAME_EVERY
// ticks so scrubbing a thousand-tick log never re-folds from zero.

import { applyRunStarted, applyTick, cloneState } from "./reducer.js";

export const KEYFRAME_EVERY = 50;

// Raw text -> [{runId, started, records: [tickRecord...]}]. Lines that fail
// to parse are counted, not fatal — a truncated tail from a killed daemon is
// normal. Records from different runs are NEVER folded together.
export function parseLog(text) {
  const runs = [];
  let current = null;
  let badLines = 0;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (parsed.event === "run_started") {
      current = { runId: parsed.runId ?? `run-${runs.length + 1}`, started: parsed, records: [] };
      runs.push(current);
    } else if (parsed.tick != null) {
      if (!current) {
        // A pre-v0.4 log with no boundary line: synthesize a headless run so
        // old material still replays, flagged as such.
        current = { runId: `unbounded-${runs.length + 1}`, started: null, records: [] };
        runs.push(current);
      }
      current.records.push(parsed);
    }
  }
  return { runs, badLines };
}

// One loaded run: fold once, keyframing as we go; seek from the nearest
// keyframe at or below the target, replaying forward.
export class ReplayRun {
  constructor(run) {
    this.runId = run.runId;
    this.started = run.started;
    this.records = run.records;
    this.keyframes = new Map(); // tickIndex -> cloned state AFTER records[i]
    this._initial = run.started
      ? applyRunStarted(null, run.started)
      : this._bootstrapFromFirstRecord();
    this.lastTick = this.records.length > 0 ? this.records[this.records.length - 1].tick : 0;
    // Fold the whole run once so every keyframe exists before first scrub.
    let state = cloneState(this._initial);
    this.records.forEach((rec, i) => {
      state = applyTick(state, rec);
      if ((i + 1) % KEYFRAME_EVERY === 0) this.keyframes.set(i, cloneState(state));
    });
    this.finalState = state;
  }

  // Headless (pre-boundary) logs: infer the grid from body coords so the
  // reducer has a canvas. Everything else stays absent — never invented.
  _bootstrapFromFirstRecord() {
    let gridSize = 1;
    for (const rec of this.records.slice(0, 5)) {
      for (const b of rec.bodies ?? []) {
        const [x, y] = b.coord.split(",").map(Number);
        gridSize = Math.max(gridSize, x + 1, y + 1);
      }
      for (const c of rec.cells ?? []) {
        const [x, y] = c.coord.split(",").map(Number);
        gridSize = Math.max(gridSize, x + 1, y + 1);
      }
    }
    return applyRunStarted(null, { runId: this.runId, gridSize });
  }

  // State AFTER the record whose tick is the largest tick <= target.
  // Keyframe + forward fold; worst case KEYFRAME_EVERY folds.
  stateAtTick(targetTick) {
    let index = -1;
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].tick <= targetTick) index = i;
      else break;
    }
    if (index === -1) return cloneState(this._initial);

    let startIndex = -1;
    let state = null;
    for (const [ki] of this.keyframes) {
      if (ki <= index && ki > startIndex) startIndex = ki;
    }
    state = startIndex >= 0 ? cloneState(this.keyframes.get(startIndex)) : cloneState(this._initial);
    for (let i = startIndex + 1; i <= index; i++) {
      state = applyTick(state, this.records[i]);
    }
    return state;
  }

  // Event markers for the scrubber track: deaths, births, attacks, first
  // inscriptions, destruction (observatory spec §7).
  markers() {
    const seenInscribed = new Set();
    const out = [];
    for (const rec of this.records) {
      for (const ev of rec.events ?? []) {
        if (ev.type === "death") out.push({ tick: rec.tick, kind: "death" });
        else if (ev.type === "beget") out.push({ tick: rec.tick, kind: "birth" });
        else if (ev.type === "attack") out.push({ tick: rec.tick, kind: "attack" });
        else if (ev.type === "raze" || ev.type === "demolish_complete") out.push({ tick: rec.tick, kind: "destruction" });
        else if (ev.type === "inscribe" && !seenInscribed.has(ev.coord)) {
          seenInscribed.add(ev.coord);
          out.push({ tick: rec.tick, kind: "inscription" });
        }
      }
    }
    return out;
  }
}

// Browser-side convenience: fetch a log by URL (same-origin file or a served
// path) and return parsed runs. File-input loading passes text directly.
export async function loadLogText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  return res.text();
}
