// The analyst panel (observatory spec v0.8 §2): ask-anything first, watch
// mode after. All daemon access goes through the read-only client — the
// wiring that cannot express a write — and the model call goes to the
// analyst sidecar, which holds the fifth surface's credential. The panel
// never touches /control, /spark, or a config path; it has no code that
// could.
//
// Private objectives ride a toggle DEFAULTING TO OFF (settled with the
// operator, §2.7): by default the analyst describes behaviour and the
// interpretation stays with the operator; flip it on and it explains motive.

import { buildContext } from "../analyst/retrieve.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function renderAnalyst(el, state, ctx) {
  const a = ctx.analyst; // {log, includeObjectives, watchOn, busy, callsTotal, sidecar, readonly}
  el.innerHTML = `
    <h3>Analyst</h3>
    <div class="dim">Fifth surface: <b>analyst:claude-cli</b> · ${a.callsTotal ?? 0} calls this session · read-only, structurally</div>
    <label class="row" style="cursor:pointer"><input type="checkbox" id="an-objectives" ${a.includeObjectives ? "checked" : ""}/>
      use private objectives &amp; reasons (off: behaviour only, the inference stays yours)</label>
    <label class="row" style="cursor:pointer"><input type="checkbox" id="an-watch" ${a.watchOn ? "checked" : ""}/>
      watch mode: surface notable moments unprompted (rides situationChanged)</label>
    <div style="display:flex;gap:6px;margin:8px 0">
      <input type="search" id="an-q" placeholder="ask about this run or the archive…" value="${esc(a.draft ?? "")}" style="flex:1"/>
      <button id="an-ask" ${a.busy ? "disabled" : ""}>${a.busy ? "…" : "ask"}</button>
    </div>
    <div id="an-log"></div>`;

  const log = el.querySelector("#an-log");
  for (const entry of [...a.log].reverse()) {
    log.insertAdjacentHTML(
      "beforeend",
      entry.kind === "watch"
        ? `<div class="memory reflection"><span class="dim">watch · t${entry.tick}</span><div class="mono">${esc(entry.text)}</div></div>`
        : `<div class="memory"><div><b>${esc(entry.question)}</b></div><div class="mono">${esc(entry.text)}</div></div>`
    );
  }

  el.querySelector("#an-objectives").onchange = (e) => {
    a.includeObjectives = e.target.checked;
  };
  el.querySelector("#an-watch").onchange = (e) => {
    a.watchOn = e.target.checked;
  };
  const input = el.querySelector("#an-q");
  input.oninput = () => (a.draft = input.value);

  const ask = async () => {
    const question = input.value.trim();
    if (!question || a.busy) return;
    a.busy = true;
    ctx.refresh();
    try {
      // Archive summaries ride along when the daemon serves them; a dead
      // daemon (pure replay) still answers from the current folded state.
      let index = null;
      try {
        index = await a.readonly.archiveIndex();
      } catch {
        index = null;
      }
      const context = buildContext(question, { state, index, includeObjectives: a.includeObjectives });
      const res = await fetch(`${a.sidecar}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context }),
      });
      const body = await res.json();
      if (body.callsTotal != null) a.callsTotal = body.callsTotal;
      a.log.push({ kind: "ask", question, text: body.answer ?? `analyst error: ${body.error}` });
      a.draft = "";
    } catch (e) {
      a.log.push({ kind: "ask", question, text: `analyst sidecar unreachable (${e.message}). Start it with: npm run analyst` });
    } finally {
      a.busy = false;
      ctx.refresh();
    }
  };
  el.querySelector("#an-ask").onclick = ask;
  input.onkeydown = (e) => {
    if (e.key === "Enter") ask();
  };
}
