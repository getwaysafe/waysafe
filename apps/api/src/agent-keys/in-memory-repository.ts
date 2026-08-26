/** In-process fake `AgentKeyRepository`. */

import { ID_PREFIX, generateId } from "@agentpay/core";
import { extractKeyPrefix, generateAgentApiKey, hashApiKey } from "./keys.js";
import type {
  AgentKeyRecord,
  AgentKeyRepository,
  AgentKeyVerification,
  CreatedAgentApiKey,
  NewAgentApiKey,
} from "./types.js";

interface KeyRow extends AgentKeyRecord {
  secretHash: string;
}

export class InMemoryAgentKeyRepository implements AgentKeyRepository {
  private readonly byId = new Map<string, KeyRow>();
  private readonly byPrefix = new Map<string, KeyRow>();

  async createKey(input: NewAgentApiKey, now: Date): Promise<CreatedAgentApiKey> {
    const generated = generateAgentApiKey();
    const id = generateId(ID_PREFIX.api_key);

    const row: KeyRow = {
      id,
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      name: input.name,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    };

    this.byId.set(id, row);
    this.byPrefix.set(generated.prefix, row);

    return { id, fullKey: generated.fullKey, prefix: generated.prefix, createdAt: now };
  }

  async verifyKey(fullKey: string, now: Date): Promise<AgentKeyVerification> {
    const prefix = extractKeyPrefix(fullKey);
    const row = prefix ? this.byPrefix.get(prefix) : undefined;

    // Wrong prefix and right-prefix-wrong-secret are indistinguishable to
    // the caller on purpose: the prefix isn't a secret (it's what's stored
    // for lookup), but nothing about *why* a key failed to verify should be
    // observable beyond "not found" vs "found but revoked".
    if (!row || row.secretHash !== hashApiKey(fullKey)) {
      return { ok: false, reason: "not_found" };
    }
    if (row.revokedAt) {
      return { ok: false, reason: "revoked" };
    }

    row.lastUsedAt = now;
    return { ok: true, keyId: row.id, organizationId: row.organizationId, agentId: row.agentId };
  }

  async revokeKey(keyId: string, organizationId: string, now: Date): Promise<boolean> {
    const row = this.byId.get(keyId);
    if (!row || row.organizationId !== organizationId || row.revokedAt) return false;
    row.revokedAt = now;
    return true;
  }

  async listKeysForOrganization(organizationId: string): Promise<AgentKeyRecord[]> {
    return [...this.byId.values()]
      .filter((row) => row.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ secretHash: _secretHash, ...record }) => record);
  }

  /** Test/debug only -- not part of AgentKeyRepository. */
  async getById(keyId: string): Promise<AgentKeyRecord | undefined> {
    return this.byId.get(keyId);
  }
}
