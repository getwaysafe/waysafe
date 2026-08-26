import { ID_PREFIX, generateId } from "@agentpay/core";
import type { ProviderEventRepository } from "./types.js";

interface StoredEvent {
  id: string;
  provider: string;
  externalId: string;
  type: string;
  payload: Record<string, unknown>;
  processedAt: Date;
}

export class InMemoryProviderEventRepository implements ProviderEventRepository {
  private readonly seen = new Map<string, StoredEvent>();

  async recordIfNew(
    provider: string,
    externalId: string,
    type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    const key = `${provider}:${externalId}`;
    // Synchronous check-then-set, no await between them -- nothing can
    // interleave in a single JS thread, same reasoning as the idempotency-
    // key claim in InMemoryAuthorizationRepository.
    if (this.seen.has(key)) return false;
    this.seen.set(key, {
      id: generateId(ID_PREFIX.evidence),
      provider,
      externalId,
      type,
      payload,
      processedAt: now,
    });
    return true;
  }
}
