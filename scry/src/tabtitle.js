// Browser tab identity (observatory spec v0.8 §6): document.title carries
// run id, tick, and population — `run11 · t247 · 5/13` — and must reflect
// paused, waiting-for-agents, and stopped. A world that quietly stopped
// ticking is precisely what is worth noticing from another window.

export function tabTitle(state, runState = {}) {
  if (!state || !state.runId) return "Fogline Scry";
  const population = state.agents?.size ?? 0;
  const slots = state.slots?.total ?? null;
  const parts = [state.runId, `t${state.tick ?? 0}`, slots != null ? `${population}/${slots}` : `${population}`];
  if (runState.stopped) parts.push("stopped");
  else if (runState.waitingForAgents) parts.push("waiting");
  else if (runState.paused) parts.push("paused");
  return parts.join(" · ");
}
