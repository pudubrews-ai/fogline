// Crosscheck report page (observatory spec v0.8 §4): a PURE function of the
// report JSON. No reducer, no live daemon, no run state — a finished run's
// crosscheck renders from its file alone, which is also what makes the
// optional standalone export cheap.
//
// Ordering is deliberate and inverted from the obvious (§4.1): DISAGREEMENTS
// first — four models agreeing is weak evidence (shared training data,
// shared failure modes); four models disagreeing about whether something is
// a daemon bug or in-world behaviour is the highest-signal thing the tool
// produces, and it is what makes the agreements trustworthy at all.
//
// Faults render as faults (§4.2): a vendor that timed out shows as a
// labelled fault WITH its latency, never as a missing slot. Run 11 had GLM
// time out at 900s; a reader who cannot see that reads a three-way
// agreement as a four-way one.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtLatency = (ms) => (ms == null ? "?" : `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`);

function vendorSlot(name, v) {
  const faulted = v.fault != null;
  const head = faulted
    ? `<span class="cc-fault-label">FAULT</span> ${esc(v.fault)} · ${fmtLatency(v.latencyMs)}`
    : `${esc(v.evaluation?.confidence ?? "?")} confidence · ${fmtLatency(v.latencyMs)}`;
  const body = faulted
    ? `<div class="dim">No evaluation was produced. This slot is a fault, not an absence — the vendor was asked and did not answer.</div>`
    : `<div>${esc(v.evaluation?.summary ?? "")}</div>
       <ul>${(v.evaluation?.findings ?? []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
      ((v.evaluation?.concerns ?? []).length > 0
        ? `<div class="dim">concerns: ${v.evaluation.concerns.map(esc).join(" · ")}</div>`
        : "");
  return `
    <details class="cc-vendor${faulted ? " cc-faulted" : ""}" data-vendor="${esc(name)}">
      <summary><b>${esc(name)}</b> — ${head}</summary>
      ${body}
      ${v.raw != null ? `<details class="cc-raw"><summary>raw response</summary><pre>${esc(v.raw)}</pre></details>` : ""}
    </details>`;
}

export function renderCrosscheckReport(report) {
  const inv = report.invocation ?? {};
  const vendors = report.vendors ?? {};
  const vendorNames = Object.keys(vendors);
  const corr = report.correlation?.result ?? { agreements: [], disagreements: [], unique: [] };
  const faults = vendorNames.filter((n) => vendors[n].fault != null);

  const disagreements = (corr.disagreements ?? [])
    .map(
      (d) => `
      <div class="cc-item">
        <b>${esc(d.topic)}</b>
        ${(d.positions ?? [])
          .map((p) => `<div class="cc-position"><span class="cc-vendor-tag">${esc(p.vendor)}</span> ${esc(p.said)}</div>`)
          .join("")}
      </div>`
    )
    .join("");

  const agreements = (corr.agreements ?? [])
    .map(
      (a) => `
      <div class="cc-item">${esc(a.claim)}
        <div class="dim">${(a.vendors ?? []).map(esc).join(", ")}</div>
      </div>`
    )
    .join("");

  const unique = (corr.unique ?? [])
    .map(
      (u) => `
      <div class="cc-item"><span class="cc-vendor-tag">${esc(u.vendor)}</span> ${esc(u.finding)}
        ${u.note ? `<div class="dim">${esc(u.note)}</div>` : ""}
      </div>`
    )
    .join("");

  return `
  <div class="cc-report">
    <h3>Crosscheck · ${esc(report.timestamp ?? "")}</h3>

    <div class="cc-invocation">
      <div><b>question</b> ${esc(inv.question ?? "")}</div>
      ${inv.context ? `<div><b>context</b> ${esc(inv.context)}</div>` : ""}
      <div><b>files</b> ${(inv.files ?? [])
        .map((f) => `${esc(f.name)} (${((f.bytes ?? 0) / 1024).toFixed(0)}KB)`)
        .join(", ")}</div>
      <div class="dim">judge ${esc(report.correlation?.judge ?? inv.judge ?? "?")}${
        report.correlation?.judgeIsParticipant ? " (a participant — bias risk named, not hidden)" : ""
      } · ${vendorNames.length} vendors${faults.length > 0 ? ` · ${faults.length} faulted` : ""}</div>
    </div>

    <h3>Disagreements</h3>
    ${disagreements || `<div class="dim">None recorded — which is itself worth suspicion with ${vendorNames.length - faults.length} vendors answering.</div>`}

    <h3>Agreements</h3>
    ${agreements || `<div class="dim">None recorded.</div>`}

    <h3>Unique findings</h3>
    ${unique || `<div class="dim">None recorded.</div>`}

    <h3>Vendors</h3>
    ${vendorNames.map((n) => vendorSlot(n, vendors[n])).join("")}
  </div>`;
}

// The cross-run listing row (§4.3), derived from an archive index entry.
export function crosscheckListingRow(entry) {
  const cc = entry.crosscheck;
  if (!cc) return null;
  return {
    runId: entry.runId,
    date: entry.endedAt ?? entry.startedAt ?? null,
    question: cc.question ?? null,
    status: cc.status,
    vendorCount: cc.vendorCount ?? null,
    anyFault: cc.anyFault ?? null,
    reportPath: cc.reportPath ?? null,
  };
}
