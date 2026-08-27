// The live-has-no-history hint (observatory spec §3.6, ratified from v0.4):
// a live snapshot deliberately carries no event history — live is for
// watching forward, replay owns the past. A viewer who connects mid-run
// sees short feeds and must be told why, not left to think the world was
// quiet. Shown on the feed, ledger, and norm panels when connected live
// after events have occurred.

export function liveHistoryHint(state) {
  if (state.liveSince == null || state.liveSince === 0) return "";
  return `<div class="dim" style="margin-bottom:8px;border-left:3px solid var(--panel-line);padding-left:6px">Connected live at tick ${state.liveSince} — live carries no history. Everything before that tick is in replay (open ticks.log).</div>`;
}
