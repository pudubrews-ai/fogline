// Inspector (observatory spec §8.2): the selected agent in full — persona
// including private objective (operator realm is omniscient by design), raw
// vitals with bands, inventory, intent, last reason (prominent: it is the
// only window into whether the agent pursues its objective), sponsorship,
// heritage.

const band = (v, hi, lo, names) => (v > hi ? names[0] : v > lo ? names[1] : names[2]);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderInspector(el, state, ctx) {
  const agent = state.agents.get(ctx.selectedId);
  el.innerHTML = "<h3>Inspector</h3>";
  if (!agent) {
    el.insertAdjacentHTML("beforeend", `<div class="dim">Select an agent in the roster or the scene.</div>`);
    return;
  }
  const persona = state.personas.get(agent.agentId);
  const vband = band(agent.vitality, 66, 25, ["hale", "hurt", "failing"]);
  const sband = band(agent.sustenance, 60, 20, ["fed", "hungry", "starving"]);
  const inv = Object.entries(agent.inventory ?? {}).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`).join(", ") || "nothing";

  const rows = [];
  rows.push(`<h3>${esc(agent.name ?? "unnamed")} <span class="dim">${agent.agentId}</span></h3>`);
  rows.push(`<div>vitality <b>${agent.vitality}</b> (${vband}) · sustenance <b>${agent.sustenance}</b> (${sband})</div>`);
  rows.push(`<div>at <b>${agent.coord}</b> · ${agent.lifeStage} · ${agent.connectionState ?? "?"}</div>`);
  rows.push(`<div>carrying: ${esc(inv)}</div>`);

  rows.push(`<h3>Last reason</h3><div class="mono">${esc(agent.lastReason) || "<span class='dim'>none given</span>"}</div>`);
  rows.push(`<h3>Current intent</h3><div class="mono">${esc(agent.currentIntent) || "<span class='dim'>none</span>"}</div>`);

  if (persona) {
    rows.push(`<h3>Disposition</h3><div>${esc(persona.disposition)}</div>`);
    rows.push(`<h3>Identity</h3><div class="mono">${esc(persona.identity)}</div>`);
    rows.push(`<h3>Discoverable</h3><div class="mono">${esc(persona.discoverable)}</div>`);
    if (ctx.config.showPrivateObjectives !== false) {
      rows.push(`<h3>Private objective</h3><div class="mono">${esc(persona.privateObjective)}</div>`);
    }
  } else {
    rows.push(`<div class="dim">No persona on record${agent.lifeStage === "infant" ? " — infants have none" : " (registered before this view connected; personas ride registration events and snapshots)"}.</div>`);
  }

  if (agent.sponsorId) rows.push(`<h3>Sponsor</h3><div>${esc(state.agents.get(agent.sponsorId)?.name ?? agent.sponsorId)}</div>`);
  const dependents = [...state.agents.values()].filter((a) => a.sponsorId === agent.agentId);
  if (dependents.length > 0) {
    rows.push(`<h3>Sponsoring</h3>` + dependents.map((d) => `<div>${esc(d.name ?? d.agentId)} (born tick ${d.bornAtTick})</div>`).join(""));
  }

  if (agent.heritage) {
    const h = agent.heritage;
    rows.push(`<h3>Heritage</h3>
      <div>child of <b>${esc(h.parentName)}</b>, born tick ${h.bornAtTick}</div>
      ${h.divergence ? `<div>divergence: <span class="mono">${esc(h.divergence)}</span></div>` : ""}
      ${h.raisedBy ? `<div>raised by: <span class="mono">${esc(h.raisedBy)}</span></div>` : ""}`);
  }

  el.insertAdjacentHTML("beforeend", rows.join("\n"));
}
