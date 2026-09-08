/**
 * D-35: exactly one of agentId/instrumentId, matching actorKind -- never
 * both, never neither. Shared by both `AuthorizationRepository`
 * implementations (the same reasoning `util/mutex.ts` was extracted for,
 * D-16: one real check, two real callers). This is application-level
 * defense in depth; the actual guarantee against bad data reaching Postgres
 * is the DB CHECK constraint (`packages/db/prisma/manual-constraints.sql`),
 * which the in-memory fake has no equivalent for -- this function is what
 * makes a violation of the invariant visible to every test using either
 * repository, not just ones running against real Postgres.
 */

import type { SaveAuthorizationInput } from "./types.js";

export function assertValidActor(input: SaveAuthorizationInput): void {
  const validAgent =
    input.actorKind === "agent" && input.agentId !== null && input.instrumentId === null;
  const validInstrument =
    input.actorKind === "instrument" && input.instrumentId !== null && input.agentId === null;
  if (!validAgent && !validInstrument) {
    throw new Error(
      `invalid actor: actorKind=${input.actorKind}, agentId=${input.agentId}, ` +
        `instrumentId=${input.instrumentId} -- exactly one of agentId/instrumentId must be set, ` +
        `matching actorKind`,
    );
  }
}
