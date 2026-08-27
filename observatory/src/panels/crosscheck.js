// Crosscheck panel (observatory spec v0.8 §4): the cross-run listing, the
// live supervision status, and the report page — rendered by the pure
// function in crosscheck/render.js from the report JSON alone. Read-only:
// this panel reads reports; it never invokes crosscheck, re-runs an
// evaluation, or writes anything (§4.5). Invocation belongs to the daemon's
// post-run hook.

import { renderCrosscheckReport, crosscheckListingRow } from "../crosscheck/render.js";

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function loadListing(cc) {
  try {
    const index = await cc.readonly.archiveIndex();
    cc.rows = (index.runs ?? []).map(crosscheckListingRow).filter(Boolean);
    cc.error = null;
  } catch (e) {
    cc.rows = [];
    cc.error = `archive unreachable (${e.message})`;
  }
  cc.refresh();
}

export function renderCrosscheck(el, state, ctx) {
  const cc = ctx.crosscheckPanel; // {readonly, rows, openRunId, report, status, error, refresh}
  cc.refresh = () => ctx.refresh();

  if (cc.report) {
    el.innerHTML = `<button id="cc-back">← all crosschecks</button>${renderCrosscheckReport(cc.report)}`;
    el.querySelector("#cc-back").onclick = () => {
      cc.report = null;
      cc.openRunId = null;
      ctx.refresh();
    };
    return;
  }

  const status = cc.status; // live supervision state, from the operator channel
  el.innerHTML = `
    <h3>Crosscheck</h3>
    ${
      status
        ? `<div class="${status.state === "failed" || status.state === "timed_out" ? "ambiguous" : "dim"}">
             supervisor: <b>${esc(status.state)}</b>${status.runId ? ` · ${esc(status.runId)}` : ""}${
             status.state === "running" && status.elapsedMs != null ? ` · ${Math.round(status.elapsedMs / 1000)}s elapsed` : ""
           }${status.reason ? ` · ${esc(status.reason)}` : ""}${status.reportPath ? ` · report filed` : ""}</div>`
        : `<div class="dim">supervisor: no live daemon</div>`
    }
    <div id="cc-list" style="margin-top:8px"></div>`;

  const list = el.querySelector("#cc-list");
  if (cc.rows == null) {
    list.innerHTML = `<div class="dim">loading the archive…</div>`;
    loadListing(cc);
    return;
  }
  if (cc.error) {
    list.innerHTML = `<div class="dim">${esc(cc.error)}</div>`;
    return;
  }
  if (cc.rows.length === 0) {
    list.innerHTML = `<div class="dim">No crosschecks in the archive yet. One starts automatically when a run stops.</div>`;
    return;
  }
  list.innerHTML = `<table>
    <tr><th>run</th><th>date</th><th>status</th><th>question</th><th></th></tr>
    ${cc.rows
      .map(
        (r) => `<tr>
          <td>${esc(r.runId)}</td>
          <td class="dim">${esc((r.date ?? "").slice(0, 16))}</td>
          <td class="${r.anyFault ? "ambiguous" : ""}">${esc(r.status)}${r.anyFault ? " · vendor fault" : ""}${
          r.vendorCount != null ? ` · ${r.vendorCount} vendors` : ""
        }</td>
          <td class="dim">${esc((r.question ?? "").slice(0, 60))}${(r.question ?? "").length > 60 ? "…" : ""}</td>
          <td>${r.status === "done" ? `<button data-run="${esc(r.runId)}">open</button>` : ""}</td>
        </tr>`
      )
      .join("")}
  </table>`;
  list.onclick = async (e) => {
    const runId = e.target.dataset?.run;
    if (!runId) return;
    try {
      cc.report = await cc.readonly.crosscheckReport(runId);
      cc.openRunId = runId;
    } catch (err) {
      cc.error = `report unreadable (${err.message})`;
    }
    ctx.refresh();
  };
}
