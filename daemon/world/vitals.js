// Sustenance, vitality, upkeep, and condition bands (protocol §6, daemon
// spec §4). Pure functions over bodies — no world imports, no model calls.
//
// Bands are DERIVED at observation time, never stored, so they cannot drift
// from the raw values. Nothing in this module writes a band anywhere.

export const VITALS_DEFAULTS = {
  sustenanceMax: 100,
  sustenanceDecayPerTick: 1,
  vitalityMax: 100,
  starvationDamagePerTick: 3,
  regenThreshold: 50,
  regenPerTick: 1,
  attackDamage: 25,
  attackCost: 6,
  sponsorDrainPerTick: 1,
  orphanDamagePerTick: 4,
  // Band thresholds (daemon spec §4): boundaries are config, bands are math.
  vitalityHaleAbove: 66,
  vitalityFailingAtOrBelow: 25,
  sustenanceFedAbove: 60,
  sustenanceStarvingAtOrBelow: 20,
};

export const vitalsConfig = (config) => ({ ...VITALS_DEFAULTS, ...(config.vitals ?? {}) });

export const vitalityBand = (vitality, vc) =>
  vitality > vc.vitalityHaleAbove ? "hale" : vitality > vc.vitalityFailingAtOrBelow ? "hurt" : "failing";

export const sustenanceBand = (sustenance, vc) =>
  sustenance > vc.sustenanceFedAbove ? "fed" : sustenance > vc.sustenanceStarvingAtOrBelow ? "hungry" : "starving";

// Upkeep, resolution step 9 — AFTER all actions, so an agent can eat on the
// tick it would otherwise starve. Order within upkeep is normative (daemon
// spec §4): sustenance decay, sponsor drain, orphan damage, starvation
// damage, regeneration. Vitality is allowed below zero here; deaths are
// evaluated at step 10 so the damage that kills is the damage that landed.
export function runUpkeep(world, vc) {
  const bodies = [...world.agents.values()];

  // vitalityTrend source (v0.7 A2): the per-body delta of THIS upkeep pass,
  // captured from the actual computation — the trend string itself is never
  // stored, it is derived at observation time from this raw delta, exactly
  // as bands are derived from raw values. Self-only; never leaves the body
  // for any other agent's observation.
  const vitalityBefore = new Map(bodies.map((b) => [b.id, b.vitality]));

  for (const body of bodies) {
    body.sustenance = Math.max(0, body.sustenance - vc.sustenanceDecayPerTick);
  }
  for (const body of bodies) {
    if (body.lifeStage === "infant" && body.sponsorId) {
      const sponsor = world.agents.get(body.sponsorId);
      if (sponsor) sponsor.vitality -= vc.sponsorDrainPerTick;
    }
  }
  for (const body of bodies) {
    if (body.lifeStage === "infant" && !body.sponsorId) {
      body.vitality -= vc.orphanDamagePerTick;
    }
  }
  for (const body of bodies) {
    if (body.sustenance <= 0) body.vitality -= vc.starvationDamagePerTick;
  }
  for (const body of bodies) {
    // Unsponsored infants do not regenerate: nobody is caring for them, and
    // the orphan timer (protocol §11.5) must actually be a timer.
    if (body.lifeStage === "infant" && !body.sponsorId) continue;
    if (body.sustenance > vc.regenThreshold && body.vitality > 0 && body.vitality < vc.vitalityMax) {
      body.vitality = Math.min(vc.vitalityMax, body.vitality + vc.regenPerTick);
    }
  }

  for (const body of bodies) {
    body.lastUpkeepVitalityDelta = body.vitality - vitalityBefore.get(body.id);
  }
}
