// Destruction ledger (observatory spec §8.5b): every demolish and raze —
// actor, target structure, its author, tick, whether an inscription was
// destroyed, and who was present. Operator-side only; in-world, destruction
// is anonymous. The interesting column is presence: a raze with witnesses
// and a raze in an empty corner are different social events, and the world
// cannot tell them apart while you can.

import { liveHistoryHint } from "./hint.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderLedger(el, state, ctx) {
  el.innerHTML = "<h3>Destruction ledger</h3>";
  el.insertAdjacentHTML("beforeend", liveHistoryHint(state));
  const acts = state.events.filter((e) => e.type === "raze" || e.type === "demolish_complete");
  if (acts.length === 0) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">Nothing has been destroyed.</div>`);
    return;
  }
  const nameOf = (id) => state.agents.get(id)?.name ?? state.departed.get(id)?.name ?? id;
  const table = document.createElement("table");
  table.innerHTML = `<tr><th>t</th><th>what</th><th>actor</th><th>witnesses</th></tr>`;
  for (const ev of [...acts].reverse()) {
    const witnesses = (ev.present ?? []).map(nameOf);
    const author = authorOf(state, ev);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${ev.tick}</td>
      <td>${ev.type === "raze" ? "razed" : "demolished"} <b>${esc(ev.name)}</b> <span class="dim">(${esc(ev.form)} at ${ev.coord}${author ? `, built by ${esc(author)}` : ""})</span>
        ${ev.inscriptionDestroyed ? `<div class="ambiguous">an inscription was destroyed</div>` : ""}
        ${ev.fragmentLeft ? `<div class="dim">inscription survives as a fragment</div>` : ""}</td>
      <td>${esc(nameOf(ev.agentId))}</td>
      <td>${witnesses.length > 0 ? esc(witnesses.join(", ")) : `<span class="dim">nobody — an empty corner</span>`}</td>`;
    table.appendChild(row);
  }
  el.appendChild(table);
  el.insertAdjacentHTML("beforeend", `<div class="dim" style="margin-top:8px">In-world, none of this is attributed. This table exists only here.</div>`);
}

// The builder, recovered from the build event for that cell before this act.
function authorOf(state, act) {
  let author = null;
  for (const ev of state.events) {
    if (ev.tick > act.tick) break;
    if (ev.type === "build" && ev.coord === act.coord) author = ev.agentId;
  }
  if (!author) return null;
  return state.agents.get(author)?.name ?? state.departed.get(author)?.name ?? author;
}
