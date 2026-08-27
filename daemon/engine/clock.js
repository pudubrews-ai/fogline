// Sim time. Pure functions; the tick number is the only clock state.

export function parseSimTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new Error(`Invalid sim time "${hhmm}", expected "HH:MM"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatSimTime(totalMinutes) {
  const t = ((totalMinutes % 1440) + 1440) % 1440;
  const h = String(Math.floor(t / 60)).padStart(2, "0");
  const mm = String(t % 60).padStart(2, "0");
  return `${h}:${mm}`;
}

// The clock advances by minutesPerTick at each tick OPEN (daemon spec §6),
// so tick N reads as start + N * minutesPerTick.
export function simTimeAtTick(startSimTime, minutesPerTick, tick) {
  return formatSimTime(parseSimTime(startSimTime) + minutesPerTick * tick);
}
