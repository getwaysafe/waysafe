/**
 * Real `AgentKeyRepository`, backed by Postgres via Prisma.
 *
 * No row lock here (contrast with authorization/prisma-repository.ts and
 * evidence/prisma-repository.ts): a key being revoked mid-flight of a
 * concurrent verification is an ordinary auth-staleness window every
 * bearer-token system has, not a double-spend risk. There's no cumulative
 * value being raced.
 */

import { PrismaClient } from "@prisma/client";
import { ID_PREFIX, generateId } from "@agentpay/core";
import { extractKeyPrefix, generateAgentApiKey, hashApiKey } from "./keys.js";
import type {
  AgentKeyRecord,
  AgentKeyRepository,
  AgentKeyVerification,
  CreatedAgentApiKey,
  NewAgentApiKey,
} from "./types.js";

export class PrismaAgentKeyRepository implements AgentKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createKey(input: NewAgentApiKey, now: Date): Promise<CreatedAgentApiKey> {
    const generated = generateAgentApiKey();
    const id = generateId(ID_PREFIX.api_key);

    await this.prisma.apiKey.create({
      data: {
        id,
        organizationId: input.organizationId,
        agentId: input.agentId ?? null,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        name: input.name,
        createdAt: now,
      },
    });

    return { id, fullKey: generated.fullKey, prefix: generated.prefix, createdAt: now };
  }

  async verifyKey(fullKey: string, now: Date): Promise<AgentKeyVerification> {
    const prefix = extractKeyPrefix(fullKey);
    if (!prefix) return { ok: false, reason: "not_found" };

    const row = await this.prisma.apiKey.findUnique({ where: { prefix } });
    if (!row || row.secretHash !== hashApiKey(fullKey)) {
      return { ok: false, reason: "not_found" };
    }
    if (row.revokedAt) {
      return { ok: false, reason: "revoked" };
    }

    await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    return { ok: true, keyId: row.id, organizationId: row.organizationId, agentId: row.agentId };
  }

  async revokeKey(keyId: string, organizationId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.apiKey.updateMany({
      where: { id: keyId, organizationId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count > 0;
  }

  async listKeysForOrganization(organizationId: string): Promise<AgentKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      agentId: row.agentId,
      prefix: row.prefix,
      name: row.name,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
  }
}
