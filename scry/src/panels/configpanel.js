// Pre-boot config panel UI (observatory spec v0.8 §3): tune, preview,
// commit. The preview is the point — the ported viability arithmetic runs
// as you type: subsistence ratio, carrying capacity, DEATHS STRUCTURALLY
// REQUIRED, and construction slack, live. Run 10 booted with two deaths
// designed in and nobody noticed until the postmortem; this panel is where
// that becomes a choice the operator watches themselves make.
//
// Commit writes a config FILE (a browser download) — the config stays the
// artifact, never live daemon state. Frozen once tick 1 opens (§3.3).

import { EXPOSED_FIELDS, getPath, setPath, diffConfigs, canCommit, commitPayload } from "../config/panel.js";
import { previewConfig } from "../config/viability.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 2) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "?");

// Fallback draft when no archive record exists yet: the daemon's shipped
// shape, all of it exposed knobs or pass-through. Never recipe data.
const TEMPLATE = {
  port: 3100,
  gridSize: 8,
  slots: 13,
  minAgents: 2,
  expectedAgents: 13,
  maxTicks: 250,
  actionDeadlineMs: 45000,
  reapAfterTicks: 40,
  startPaused: true,
  viability: { targetRatio: 1.35, viabilityFloor: 1.0, minSpringsPerResource: 2 },
  resources: { seedDensity: 0.12, quantityRange: [10, 20], regenPerTick: 0.15, distribution: "clustered" },
  vitals: {
    sustenanceMax: 100, sustenanceDecayPerTick: 3, sivetRestores: 25, vitalityMax: 100,
    starvationDamagePerTick: 3, regenThreshold: 50, regenPerTick: 1, attackDamage: 25,
    attackCost: 6, sponsorDrainPerTick: 1, orphanDamagePerTick: 8,
  },
  destruction: { demolishTicks: 3, razeCost: 12, rubbleYieldDemolish: 6, rubbleYieldRaze: 2, rubbleRatio: 3 },
};

async function loadBase(cp) {
  if (cp.loaded) return;
  cp.loaded = true;
  try {
    const index = await cp.readonly.archiveIndex();
    const runs = index.runs ?? [];
    const last = runs[runs.length - 1];
    if (last) {
      const record = await cp.readonly.archiveRecord(last.runId);
      cp.base = record.config ?? null;
      cp.baseRunId = last.runId;
      cp.typicalCost = record.boot?.constructionSlack?.typicalStructureCost ?? cp.typicalCost;
    }
  } catch {
    // no daemon or no archive — the template stands in
  }
  if (!cp.base) cp.base = TEMPLATE;
  cp.draft = structuredClone(cp.base);
  cp.refresh();
}

export function renderConfigPanel(el, state, ctx) {
  const cp = ctx.configPanel; // {readonly, base, baseRunId, draft, name, typicalCost, loaded, refresh}
  cp.refresh = () => ctx.refresh();
  // typicalStructureCost arrives at runtime from daemon records — it is
  // never bundled (it is the one recipe-derived aggregate the slack ratio
  // needs, and the daemon already prints it in operator logs).
  if (state?.constructionSlack?.typicalStructureCost != null) {
    cp.typicalCost = state.constructionSlack.typicalStructureCost;
  }

  if (!cp.draft) {
    el.innerHTML = `<h3>Configure next run</h3><div class="dim">loading the previous run's config…</div>`;
    loadBase(cp);
    return;
  }

  const freeze = canCommit(state);
  const preview = previewConfig(cp.draft, { typicalStructureCost: cp.typicalCost ?? null });
  const v = preview.viability;
  const lethal = v.deathsRequired > 0;
  const diff = diffConfigs(cp.base, cp.draft).filter((d) => d.path !== "configName");

  el.innerHTML = `
    <h3>Configure next run</h3>
    <div class="dim">The panel writes a config file; the file is the artifact. ${
      cp.baseRunId ? `Base: run ${esc(cp.baseRunId)}'s config.` : "Base: built-in template (no archived runs yet)."
    }</div>

    <div style="margin:10px 0;padding:8px;border:1px solid var(--panel-line);border-radius:4px">
      <div>subsistence ratio <b>${fmt(v.ratio)}</b> · carrying capacity <b>${fmt(v.capacity)}</b></div>
      <div class="${lethal ? "ambiguous" : "dim"}" style="font-size:1.05em">
        ${
          lethal
            ? `THIS WORLD CANNOT SUSTAIN ITS POPULATION: ${v.deathsRequired} death${v.deathsRequired === 1 ? "" : "s"} structurally required (capacity ${fmt(v.capacity)} against ${v.expectedAgents} expected)`
            : `the expected ${v.expectedAgents} agents are sustainable indefinitely (margin ${fmt(v.capacityMargin)})`
        }
      </div>
      ${
        preview.slack
          ? `<div>construction slack <b>${fmt(preview.slack.median)}</b> <span class="dim">(typical seed; range ${fmt(preview.slack.min)}–${fmt(preview.slack.max)} — placement is a draw at boot too)</span></div>
             ${preview.slack.median < 1 ? `<div class="ambiguous">building is not affordable for the expected population on a typical seed</div>` : ""}`
          : `<div class="dim">construction slack needs typicalStructureCost from a live snapshot or an archived run — connect the daemon once</div>`
      }
      ${v.ratio < (cp.draft.viability?.viabilityFloor ?? 1.0) ? `<div class="ambiguous">below the viability floor — the daemon will refuse to boot this</div>` : ""}
    </div>

    <div id="cfg-fields"></div>

    <h3>Diff against ${cp.baseRunId ? `run ${esc(cp.baseRunId)}` : "the template"}</h3>
    ${
      diff.length === 0
        ? `<div class="dim">no changes yet</div>`
        : `<table>${diff.map((d) => `<tr><td>${esc(d.path)}</td><td class="dim">${esc(JSON.stringify(d.from))}</td><td>→ ${esc(JSON.stringify(d.to))}</td></tr>`).join("")}</table>`
    }

    <div style="display:flex;gap:6px;margin:10px 0">
      <input type="search" id="cfg-name" placeholder="config name (lands in run_started and the archive)" value="${esc(cp.name ?? "")}" style="flex:1"/>
      <button id="cfg-commit" ${freeze.ok ? "" : "disabled"}>commit</button>
    </div>
    ${freeze.ok ? "" : `<div class="ambiguous">${esc(freeze.why)}</div>`}
    <div class="dim">Commit downloads the named config file. Point the daemon at it (or replace config.json) and boot — the config is frozen the moment tick 1 opens.</div>`;

  const fields = el.querySelector("#cfg-fields");
  for (const f of EXPOSED_FIELDS) {
    const value = getPath(cp.draft, f.path);
    if (value === undefined) continue; // absent in this config shape: not invented
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span style="flex:1">${esc(f.label)}</span>
      <input type="number" data-path="${esc(f.path)}" value="${value}" min="${f.min ?? 0}" step="${f.step ?? 1}"
             style="width:90px;background:#131211;border:1px solid var(--panel-line);border-radius:3px;color:var(--panel-fg);font:inherit;padding:2px 6px"/>`;
    fields.appendChild(row);
  }
  fields.oninput = (e) => {
    const path = e.target.dataset?.path;
    if (!path) return;
    const n = Number(e.target.value);
    if (!Number.isFinite(n)) return;
    cp.draft = setPath(cp.draft, path, n);
    const focused = { path, pos: e.target.selectionStart };
    ctx.refresh();
    const again = el.querySelector(`input[data-path="${focused.path}"]`);
    again?.focus();
  };
  el.querySelector("#cfg-name").oninput = (e) => (cp.name = e.target.value);
  el.querySelector("#cfg-commit").onclick = () => {
    const gate = canCommit(state);
    if (!gate.ok) return; // frozen at tick 1 — refuse, structurally, again
    const payload = commitPayload(cp.draft, cp.name);
    const a = document.createElement("a");
    a.download = payload.filename;
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(payload.text)}`;
    a.click();
  };
}
