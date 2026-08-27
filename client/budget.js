// Deadline budgeting (client spec §5). The single most important behavior in
// the client: never spend the full window on the model call, and turn a
// timeout into an explicit wait instead of a silent missed tick.

// Recomputed from the absolute deadline in every observation — the daemon
// owns the window and may change it. Never a fixed timeout constant.
export function computeBudgetMs(deadlineIso, factor, now = Date.now()) {
  const remaining = Date.parse(deadlineIso) - now;
  return Math.max(0, Math.floor(remaining * factor));
}

// Runs fn(signal) with an abort fired at budgetMs. Returns
// {timedOut: false, result} or {timedOut: true}. Non-abort errors propagate.
export async function withBudget(budgetMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const result = await fn(controller.signal);
    return { timedOut: false, result };
  } catch (err) {
    if (controller.signal.aborted) return { timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
