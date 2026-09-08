/**
 * Instrument persistence boundary (D-32 item 3, D-35).
 *
 * An Instrument is a rail-specific spend instrument (a Stripe Issuing
 * virtual card, for now) whose authority *is* a mandate's, made portable
 * onto that rail -- one per mandate for now. This is the actor a
 * rail-initiated Authorization is attributed to (`ActorKind.INSTRUMENT`,
 * `apps/api/src/enforcement/stripe-issuing.ts`'s `handleIssuingAuthorizationRequest`).
 *
 * No lock needed here, same reasoning as `principals/`: nothing about
 * creating or reading an instrument is cumulative or racy. The lock that
 * matters for card-rail spend is D-4's mandate lock, taken by the caller
 * around `AuthorizationRepository.saveAuthorization`, not anything here.
 */

import type { Instrument, InstrumentStatus } from "@waysafe/core";

export interface NewInstrument {
  organizationId: string;
  mandateId: string;
  /** Adapter name, matching EnforcementAdapter.name -- "stripe_issuing" for now. */
  rail: string;
  /** The rail's own reference for this instrument, e.g. a Stripe card id. */
  externalRef: string;
}

export interface InstrumentRepository {
  createInstrument(input: NewInstrument, now: Date): Promise<Instrument>;

  /** Global lookup by the Instrument's own id -- this is the join key a
   * rail's callback carries back (stamped into the card's metadata at
   * provisioning time), not something org-scoped at the point of use: the
   * enforcement handler doesn't yet know which organization a webhook
   * belongs to until it resolves the instrument, the same reason
   * `AuthorizationRepository.getAuthorization`/`getMandateDetail` are global
   * lookups too. */
  getInstrument(id: string): Promise<Instrument | null>;
}

export type { Instrument, InstrumentStatus };
