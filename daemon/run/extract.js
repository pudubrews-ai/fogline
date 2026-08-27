// The crosscheck extract (daemon spec v0.8 §3.3): the real work. Run 11 fed
// crosscheck a 450KB world log and a 171KB client log and a vendor timed out
// at 900s. The diagnosis (all ten reports, 2026-08-23..26): latency tracks
// INPUT SIZE, not invocation shape — 436 bytes answered single-shot in 34s,
// every input ≥417KB timed out at least one vendor, and the 622KB retry
// eventually succeeded at 1,395s. So the extract is scoped, and an extract
// that cannot fit under maxExtractBytes REFUSES with its size — it never
// truncates. Crosscheck's own spec errors on overflow rather than trimming;
// fishbowl must not hand it inputs that reach that path.
//
// Scoping (settled with the operator at build time): the windowed composite —
//   1. world events excluding reflections (run 11 filtered these by hand and
//      it was the right call),
//   2. bounded windows around deaths, first-of-kind events, and the final
//      ticks, drawn from the most-eventful client log when one is configured,
//   3. the death-specifics appendix generated from the outcome summary
//      (ticks, cells, foodAtDeath) — what produced run 11's best analysis.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export const DEFAULT_QUESTION =
  "Do these logs tell a consistent story about the same run? Flag anything present in one " +
  "but contradicted by or impossible in the other, and say whether any inconsistency looks " +
  "like a daemon or client bug rather than in-world agent behaviour.";

const WINDOW_TICKS = 3; // ± around each notable tick
const FINAL_TICKS = 10;

// First-of-kind: the first occurrence of each of these in the world stream.
const FIRST_OF_KIND = ["build", "inscribe", "attack", "give", "beget", "raze", "demolish_complete", "death"];

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ raw: line }); // client logs may carry non-JSON lines; kept as-is for windowing by proximity only
    }
  }
  return out;
}

// Which ticks matter: every death, the first of each kind, the final stretch.
export function notableTickWindows(worldEvents, finalTick) {
  const centers = new Set();
  const seenKinds = new Set();
  for (const ev of worldEvents) {
    if (ev.tick == null) continue;
    if (ev.event === "death") centers.add(ev.tick);
    if (FIRST_OF_KIND.includes(ev.event) && !seenKinds.has(ev.event)) {
      seenKinds.add(ev.event);
      centers.add(ev.tick);
    }
  }
  const inWindow = new Set();
  for (const c of centers) {
    for (let t = c - WINDOW_TICKS; t <= c + WINDOW_TICKS; t++) inWindow.add(t);
  }
  for (let t = Math.max(1, finalTick - FINAL_TICKS + 1); t <= finalTick; t++) inWindow.add(t);
  return inWindow;
}

// The death-specifics appendix (spec §3.4): generated from the outcome
// summary rather than requiring the operator to write it.
export function deathAppendix(outcome) {
  if (!outcome || outcome.deaths.length === 0) return "No deaths this run.";
  const lines = outcome.deaths.map(
    (d) =>
      `- tick ${d.tick}: ${d.name ?? d.agentId} died at ${d.cell ?? "?"} (${d.cause}` +
      `${d.causeAgentId ? ` by ${d.causeAgentId}` : ""}), foodAtDeath=${d.foodAtDeath}, ` +
      `foodReachable=${d.foodReachable}`
  );
  return `Deaths, from the run's outcome summary:\n${lines.join("\n")}`;
}

// Pick the client log with the most lines mentioning this run's notable
// ticks — "which agent had the most eventful run" measured mechanically.
function pickClientLog(clientLogPaths, windows) {
  let best = null;
  for (const path of clientLogPaths) {
    if (!existsSync(path)) continue;
    const lines = parseLines(readFileSync(path, "utf8"));
    const hits = lines.filter((l) => l.tick != null && windows.has(l.tick)).length;
    if (!best || hits > best.hits) best = { path, lines, hits };
  }
  return best;
}

const isRunHeader = (l) => l.event === "viability" || l.event === "run_started";

// Build the extract text. Returns {ok: true, text, bytes, sections} or, when
// the composite exceeds the ceiling, {ok: false, bytes, maxExtractBytes} —
// refusal, never truncation (spec test 6).
export function buildExtract({ runId, worldLogPath, outcome, clientLogPaths = [], maxExtractBytes }) {
  const worldLines =
    worldLogPath && existsSync(worldLogPath) ? parseLines(readFileSync(worldLogPath, "utf8")) : [];
  // Only this run's slice of the shared world.log: from this run's viability
  // header (stamped with runId) to the next run's, or end of file. A log
  // that never mentions this run contributes NOTHING — handing a vendor
  // some other run's events would be worse than handing it none.
  let slice = [];
  const startIdx = worldLines.findIndex((l) => l.runId === runId);
  if (startIdx >= 0) {
    let endIdx = worldLines.length;
    for (let i = startIdx + 1; i < worldLines.length; i++) {
      if (isRunHeader(worldLines[i]) && worldLines[i].runId !== runId) {
        endIdx = i;
        break;
      }
    }
    slice = worldLines.slice(startIdx, endIdx);
  }

  const finalTick = outcome?.finalTick ?? slice.reduce((m, l) => Math.max(m, l.tick ?? 0), 0);
  const windows = notableTickWindows(slice, finalTick);

  const worldSection = slice
    .filter((l) => l.event !== "reflection")
    .map((l) => JSON.stringify(l))
    .join("\n");

  const client = pickClientLog(clientLogPaths, windows);
  const clientSection = client
    ? client.lines
        .filter((l) => l.tick != null && windows.has(l.tick))
        .map((l) => (l.raw !== undefined ? l.raw : JSON.stringify(l)))
        .join("\n")
    : null;

  const parts = [
    `FISHBOWL RUN EXTRACT — run ${runId}`,
    ``,
    `== WORLD EVENTS (reflections excluded) ==`,
    worldSection,
  ];
  if (clientSection !== null) {
    parts.push(
      ``,
      `== CLIENT LOG WINDOWS (${basename(client.path)}; ±${WINDOW_TICKS} ticks around deaths and ` +
        `first-of-kind events, plus the final ${FINAL_TICKS} ticks) ==`,
      clientSection
    );
  }
  parts.push(``, `== DEATH SPECIFICS ==`, deathAppendix(outcome), ``);

  const text = parts.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (maxExtractBytes != null && bytes > maxExtractBytes) {
    return { ok: false, bytes, maxExtractBytes };
  }
  return {
    ok: true,
    text,
    bytes,
    sections: {
      worldEvents: worldSection.length,
      clientLog: client ? basename(client.path) : null,
      windowTicks: [...windows].sort((a, b) => a - b),
    },
  };
}
