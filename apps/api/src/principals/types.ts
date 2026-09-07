/**
 * Principal persistence boundary.
 *
 * A Principal is the person (or org) whose money a mandate delegates
 * authority over -- distinct from the Organization that owns the Waysafe
 * account itself (D-1). No lock needed here (contrast authorization/ and
 * evidence/'s row locks): nothing about creating or reading a principal is
 * cumulative or racy, and there is no uniqueness constraint to contend on.
 */

import type { PrincipalType } from "@waysafe/core";

export interface NewPrincipal {
  organizationId: string;
  displayName: string;
  email?: string | null;
  type?: PrincipalType;
}

export interface PrincipalRecord {
  id: string;
  organizationId: string;
  displayName: string;
  email: string | null;
  type: PrincipalType;
  createdAt: Date;
}

export interface PrincipalRepository {
  createPrincipal(input: NewPrincipal, now: Date): Promise<PrincipalRecord>;

  /** Scoped to organizationId (D-1) -- a principal that belongs to a
   * different organization must be indistinguishable from one that doesn't
   * exist at all. `server.ts` maps a `null` here to the same generic 404
   * every other org-scoped lookup in the API uses. */
  getPrincipal(principalId: string, organizationId: string): Promise<PrincipalRecord | null>;
}
