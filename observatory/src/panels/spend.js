// Spend panel (observatory spec §3.4): client-reported inference call
// counts aggregated per billing surface, from the operator stream. The
// daemon holds no credentials and prices nothing — this counts calls and
// attributes them, which is enough to see concentration, and to see a
// crisis stretch spike toward the 85–90% inference rate scarce worlds
// produce.

import { surfaceTint } from "./roster.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderSpend(el, state) {
  el.innerHTML = "<h3>Spend</h3>";
  if (!state.spend || state.spend.length === 0) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="dim">No call reports yet. Clients report per-tick inference counts alongside their actions; totals per surface land here.</div>`
    );
    return;
  }
  const total = state.spend.reduce((s, r) => s + r.callsTotal, 0);
  const table = document.createElement("table");
  table.innerHTML = `<tr><th>surface</th><th>calls this tick</th><th>total</th><th>share</th></tr>`;
  for (const row of [...state.spend].sort((a, b) => b.callsTotal - a.callsTotal)) {
    const tr = document.createElement("tr");
    const share = total > 0 ? Math.round((row.callsTotal / total) * 100) : 0;
    tr.innerHTML = `
      <td><span style="border-left:3px solid ${surfaceTint(row.surface)};padding-left:6px">${esc(row.surface)}</span></td>
      <td>${row.calls ?? 0}</td>
      <td>${row.callsTotal}</td>
      <td class="${share > 60 ? "ambiguous" : "dim"}">${share}%</td>`;
    table.appendChild(tr);
  }
  el.appendChild(table);
  el.insertAdjacentHTML(
    "beforeend",
    `<div class="dim" style="margin-top:8px">Counts, not prices: the daemon cannot price what it never holds credentials for. Concentration shows here, not on an invoice.</div>`
  );
}
