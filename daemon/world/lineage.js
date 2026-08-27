// Heritage briefs, sponsorship, fostering, maturation (protocol §11, daemon
// spec §9). The brief is snapshotted AT BIRTH: the child inherits who the
// parent was then, not who they became, and the parent is frequently dead
// before anyone attaches.

import { createInfant, snapshotCurrentCell } from "./world.js";
import { composeGenotype } from "./genotype.js";

// The accessor takes ONLY what the brief may carry. The parent's
// privateObjective is not readable from this module: nothing here accepts or
// returns it, so no future call site can leak it by accident.
export function makeHeritageBrief(parentBody, tick, divergence) {
  const { name, discoverable } = parentBody.persona;
  return {
    parentName: name,
    parentAppearance: structuredClone(parentBody.appearance),
    parentDiscoverable: discoverable,
    bornAtTick: tick,
    divergence,
    raisedBy: null,
  };
}

// Costs and slot availability are the RESOLVER's checks; this composes the
// genotype, snapshots the brief, and places the infant in the parent's cell.
export function beget(world, parent, tick, rng = Math.random) {
  const { appearance, divergence } = composeGenotype(parent.appearance, world.genotype, rng);
  const heritage = makeHeritageBrief(parent, tick, divergence);
  return createInfant(world, { appearance, heritage, sponsorId: parent.id, coord: parent.coord }, tick);
}

// Fostering transfers sponsorship to the actor and appends the fosterer's
// discoverable as nurture. NEVER called by the daemon on its own: if nobody
// fosters, the child dies. That outcome is the measurement.
export function foster(world, actor, infant, tick) {
  infant.sponsorId = actor.id;
  infant.unsponsoredAtTick = null;
  infant.heritage.raisedBy = actor.persona.discoverable;
}

// Maturation (resolution step 11): the body becomes an attachable adult. Its
// map begins where it grew up.
export function matureInfants(world, tick) {
  const matured = [];
  for (const body of world.agents.values()) {
    if (body.lifeStage === "infant" && tick - body.bornAtTick >= world.lineage.maturityTicks) {
      body.lifeStage = "adult";
      snapshotCurrentCell(world, body, tick);
      matured.push(body);
    }
  }
  return matured;
}

// What /scenario lists as attachable: matured, in-world-born, never claimed.
export function attachableBodies(world) {
  const out = [];
  for (const body of world.agents.values()) {
    if (body.lifeStage === "adult" && body.heritage !== null && body.persona === null) {
      out.push({
        agentId: body.id,
        appearance: structuredClone(body.appearance),
        heritage: structuredClone(body.heritage),
      });
    }
  }
  return out;
}
