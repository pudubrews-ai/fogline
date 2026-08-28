// Norm tracker (observatory spec §8.6): the read-only observer. Not an
// enforcer, not in the world, not visible to agents. For each violent act
// and each destruction: who did it, to whom or what, who witnessed it, and
// how far the account propagated — which agents later hold a memory
// referencing it, via which speech, at which remove from the original.
//
// Propagation is traced by matching witness memories to speech events to
// derived memories, hop by hop. Where the chain is ambiguous, the ambiguity
// is SHOWN rather than guessed at: a tracker that invents a clean chain is
// worse than one that admits a gap.

import { liveHistoryHint } from "./hint.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------- pure tracing logic (tested headless) ----------

export function collectActs(state) {
  const acts = [];
  for (const ev of state.events) {
    if (ev.type === "attack") {
      acts.push({ kind: "attack", tick: ev.tick, actor: ev.actor, target: ev.target, coord: ev.coord, ev });
    } else if (ev.type === "take") {
      // A take is not destruction (scry spec v0.9 §4): it belongs here, in
      // the panel that would show whether theft produces retaliation.
      acts.push({ kind: "take", tick: ev.tick, actor: ev.actor, target: ev.target, resource: ev.resource, coord: ev.coord, ev });
    } else if (ev.type === "raze" || ev.type === "demolish_complete") {
      acts.push({ kind: "destruction", tick: ev.tick, actor: ev.agentId, structureName: ev.name, coord: ev.coord, ev });
    }
  }
  return acts;
}

const nameOf = (state, id) => state.agents.get(id)?.name ?? state.departed.get(id)?.name ?? id;

// Does a text plausibly reference the act? Names are the only handle
// testimony has. Full reference: both parties (attack) or the structure
// name (destruction). Partial reference: some but not all — an ambiguous
// mention, reported as such.
function referenceLevel(text, act, state) {
  const t = String(text ?? "").toLowerCase();
  if (act.kind === "attack" || act.kind === "take") {
    const actor = (nameOf(state, act.actor) ?? "").toLowerCase();
    const target = (nameOf(state, act.target) ?? "").toLowerCase();
    const hasActor = actor && t.includes(actor);
    const hasTarget = target && t.includes(target);
    const marker = act.kind === "attack" ? /attack|struck|hit|hurt|violen|kill/ : /took|take|stole|steal/;
    if (hasActor && hasTarget && marker.test(t)) return "full";
    if ((hasActor || hasTarget) && marker.test(t)) return "partial";
    return null;
  }
  const name = (act.structureName ?? "").toLowerCase();
  const destructive = /destroy|torn|tore|demolish|raze|rubble|gone|wreck/.test(t);
  if (name && t.includes(name) && destructive) return "full";
  if (name && t.includes(name)) return "partial";
  return null;
}

// Trace one act through the record: first-hand witnesses (their daemon-
// written witness memories), then speech that references it, then the
// hearers of that speech who were not already holders.
export function traceAct(state, act) {
  const firstHand = new Set();
  // The daemon's own witness memories are the ground truth for who saw it.
  for (const agent of [...state.agents.values()]) {
    const saw = agent.memories.some(
      (m) => m.tick === act.tick && m.type === "observation" && referenceLevel(m.text, act, state) !== null
    );
    if (saw) firstHand.add(agent.agentId);
  }
  // Destruction events also record presence explicitly.
  for (const id of act.ev.present ?? []) firstHand.add(id);
  for (const id of act.ev.witnesses ?? []) firstHand.add(id);
  if (act.kind === "attack" || act.kind === "take") {
    firstHand.add(act.actor);
    firstHand.add(act.target);
  } else {
    firstHand.add(act.actor);
  }

  // Speech after the act that references it, and who holds a memory of that
  // speech: those are the derived holders, hop by hop.
  const holders = new Map(); // agentId -> {remove, via: [{speaker, tick, level}]}
  for (const id of firstHand) holders.set(id, { remove: 0, via: [] });

  let frontier = new Set(firstHand);
  let remove = 0;
  while (frontier.size > 0 && remove < 6) {
    remove += 1;
    const next = new Set();
    for (const ev of state.events) {
      if (ev.type !== "speech" || ev.tick <= act.tick) continue;
      if (!frontier.has(ev.speaker)) continue;
      const level = referenceLevel(ev.text, act, state);
      if (!level) continue;
      // Who heard it: every agent holding a speech memory with this text
      // from this speaker at this tick, minus the speaker.
      for (const agent of state.agents.values()) {
        if (agent.agentId === ev.speaker) continue;
        const heard = agent.memories.some((m) => m.type === "speech" && m.tick === ev.tick && m.speaker === ev.speaker && m.text === ev.text);
        if (!heard) continue;
        const hop = { speaker: ev.speaker, tick: ev.tick, level };
        if (!holders.has(agent.agentId)) {
          holders.set(agent.agentId, { remove, via: [hop] });
          next.add(agent.agentId);
        } else if (holders.get(agent.agentId).remove === remove) {
          holders.get(agent.agentId).via.push(hop);
        }
      }
    }
    frontier = next;
  }

  // Behavioral shift after acquiring the account: conduct toward the actor.
  const shifts = [];
  for (const [holderId, info] of holders) {
    if (holderId === act.actor || info.remove === 0 && (act.kind === "attack" || act.kind === "take") && holderId === act.target) continue;
    const acquiredAt = info.remove === 0 ? act.tick : Math.min(...info.via.map((v) => v.tick));
    const givesBefore = state.events.filter((e) => e.type === "give" && e.from === holderId && e.to === act.actor && e.tick < acquiredAt).length;
    const givesAfter = state.events.filter((e) => e.type === "give" && e.from === holderId && e.to === act.actor && e.tick >= acquiredAt).length;
    const attacksAfter = state.events.filter((e) => e.type === "attack" && e.actor === holderId && e.target === act.actor && e.tick >= acquiredAt).length;
    if (givesBefore > 0 || givesAfter > 0 || attacksAfter > 0) {
      shifts.push({ holderId, acquiredAt, givesBefore, givesAfter, attacksAfter });
    }
  }

  return { act, firstHand, holders, shifts };
}

// ---------- panel ----------

// The actor's backing model and billing surface (spec §3.5): with a
// mixed-vendor cast, "which model razed the marker" is a fact read off
// this panel rather than reconstructed from logs. Known only while the
// operator record carries it; a long-departed actor may read unknown.
export function actorModel(state, agentId) {
  const agent = state.agents.get(agentId);
  if (!agent) return null;
  return { model: agent.modelHint ?? null, surface: agent.surface ?? null };
}

export function renderNorms(el, state) {
  el.innerHTML = "<h3>Norm tracker</h3>";
  el.insertAdjacentHTML("beforeend", liveHistoryHint(state));
  const acts = collectActs(state);
  if (acts.length === 0) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="dim">No violence and no destruction yet. This panel answers whether the world produces enforcement without anyone being told to enforce.</div>`
    );
    return;
  }
  for (const act of acts) {
    const { firstHand, holders, shifts } = traceAct(state, act);
    const title =
      act.kind === "attack"
        ? `${esc(nameOf(state, act.actor))} attacked ${esc(nameOf(state, act.target))}`
        : act.kind === "take"
          ? `${esc(nameOf(state, act.actor))} took 1 ${esc(act.resource)} from ${esc(nameOf(state, act.target))}`
          : `${esc(nameOf(state, act.actor))} ${act.ev.type === "raze" ? "razed" : "demolished"} "${esc(act.structureName)}"`;
    const witnesses = [...firstHand].filter((id) => id !== act.actor).map((id) => esc(nameOf(state, id)));
    const derived = [...holders.entries()].filter(([, i]) => i.remove > 0);
    const chains = derived
      .map(([id, info]) => {
        const hops = info.via
          .map((v) => `${esc(nameOf(state, v.speaker))} said it at t${v.tick}${v.level === "partial" ? ` <span class="ambiguous">(ambiguous reference — the chain may not be this act)</span>` : ""}`)
          .join("; ");
        return `<div class="chain">${esc(nameOf(state, id))} <span class="dim">holds it at remove ${info.remove}</span> — via ${hops}</div>`;
      })
      .join("");
    const shiftRows = shifts
      .map(
        (s) =>
          `<div class="dim">${esc(nameOf(state, s.holderId))} toward the actor after learning: gives ${s.givesBefore} → ${s.givesAfter}${s.attacksAfter > 0 ? `, attacked them ${s.attacksAfter}×` : ""}</div>`
      )
      .join("");
    const backing = actorModel(state, act.actor);
    const backingLine = backing && (backing.model || backing.surface)
      ? `<div class="dim">actor's backing: ${esc(backing.model ?? "model unknown")}${backing.surface ? ` · ${esc(backing.surface)}` : ""}</div>`
      : "";
    el.insertAdjacentHTML(
      "beforeend",
      `<div style="margin-bottom:12px">
        <div><b>t${act.tick}</b> ${title}</div>
        ${backingLine}
        <div class="dim">witnessed by: ${witnesses.length > 0 ? witnesses.join(", ") : "nobody"}</div>
        ${chains || `<div class="dim chain">no account has propagated beyond the cell</div>`}
        ${shiftRows}
      </div>`
    );
  }
}
