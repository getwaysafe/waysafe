/**
 * Agent API key persistence boundary.
 *
 * `keys.ts` is pure (generation, hashing, prefix extraction) -- this
 * interface is the I/O it doesn't do. Verification doesn't need a lock
 * (D-16's reasoning doesn't apply here): a key being revoked mid-flight by
 * a concurrent request is an ordinary auth-staleness window, not a
 * double-spend risk -- there's no cumulative limit being raced.
 */

export interface NewAgentApiKey {
  organizationId: string;
  agentId: string;
  /** Display label, e.g. "production bot". Never used for matching. */
  name: string;
}

export interface CreatedAgentApiKey {
  id: string;
  /** Shown once. Caller must display/return it now; it is never retrievable again. */
  fullKey: string;
  prefix: string;
  createdAt: Date;
}

export interface AgentKeyRecord {
  id: string;
  organizationId: string;
  agentId: string;
  prefix: string;
  name: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type AgentKeyVerification =
  | { ok: true; keyId: string; organizationId: string; agentId: string }
  | { ok: false; reason: "not_found" | "revoked" };

export interface AgentKeyRepository {
  createKey(input: NewAgentApiKey, now: Date): Promise<CreatedAgentApiKey>;

  /** Looks up by the presented key's prefix, then compares the full key's
   * hash. Does not throw for an unknown or revoked key -- that's a normal,
   * expected outcome the caller decides how to handle. */
  verifyKey(fullKey: string, now: Date): Promise<AgentKeyVerification>;

  revokeKey(keyId: string, now: Date): Promise<void>;
}
