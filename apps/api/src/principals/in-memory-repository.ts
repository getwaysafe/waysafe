/** In-process fake `PrincipalRepository`. */

import { ID_PREFIX, PrincipalType, generateId } from "@waysafe/core";
import type { NewPrincipal, PrincipalRecord, PrincipalRepository } from "./types.js";

export class InMemoryPrincipalRepository implements PrincipalRepository {
  private readonly byId = new Map<string, PrincipalRecord>();

  async createPrincipal(input: NewPrincipal, now: Date): Promise<PrincipalRecord> {
    const id = generateId(ID_PREFIX.principal);
    const record: PrincipalRecord = {
      id,
      organizationId: input.organizationId,
      displayName: input.displayName,
      email: input.email ?? null,
      type: input.type ?? PrincipalType.INDIVIDUAL,
      createdAt: now,
    };

    this.byId.set(id, record);
    return record;
  }

  async getPrincipal(principalId: string, organizationId: string): Promise<PrincipalRecord | null> {
    const record = this.byId.get(principalId);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }
}
