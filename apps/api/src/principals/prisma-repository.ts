/**
 * Real `PrincipalRepository`, backed by Postgres via Prisma.
 *
 * No row lock here, same reasoning as `agent-keys/prisma-repository.ts`:
 * nothing about creating or reading a principal is cumulative or racy.
 */

import { PrismaClient } from "@prisma/client";
import { ID_PREFIX, PrincipalType, generateId } from "@waysafe/core";
import type { NewPrincipal, PrincipalRecord, PrincipalRepository } from "./types.js";

export class PrismaPrincipalRepository implements PrincipalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPrincipal(input: NewPrincipal, now: Date): Promise<PrincipalRecord> {
    const id = generateId(ID_PREFIX.principal);
    const type = input.type ?? PrincipalType.INDIVIDUAL;

    const row = await this.prisma.principal.create({
      data: {
        id,
        organizationId: input.organizationId,
        displayName: input.displayName,
        email: input.email ?? null,
        type,
        createdAt: now,
      },
    });

    return {
      id: row.id,
      organizationId: row.organizationId,
      displayName: row.displayName,
      email: row.email,
      type: row.type as PrincipalType,
      createdAt: row.createdAt,
    };
  }

  async getPrincipal(principalId: string, organizationId: string): Promise<PrincipalRecord | null> {
    const row = await this.prisma.principal.findUnique({ where: { id: principalId } });
    if (!row || row.organizationId !== organizationId) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      displayName: row.displayName,
      email: row.email,
      type: row.type as PrincipalType,
      createdAt: row.createdAt,
    };
  }
}
