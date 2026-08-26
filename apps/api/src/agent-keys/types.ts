/**
 * API key persistence boundary -- both agent keys and org credentials.
 *
 * Same table, same hashing, same verification: `agentId: null` is an org
 * credential (a developer/principal-side credential for account-management
 * routes -- create a mandate, register an agent, view evidence), `agentId:
 * string` is an agent key (D-18: the source of truth for which agent is
 * acting on POST /v1/authorizations). A route that requires an agent key
 * specifically rejects a `null` agentId itself -- see
 * `authorization/service.ts`'s `verifyAgentKey`, where an org credential
 * presented there simply fails to match any claimed `agent_id` and falls
 * through to the same `DENY_AGENT_NOT_BOUND` path any other mismatched key
 * would.
 *
 * `keys.ts` is pure (generation, hashing, prefix extraction) -- this
 * interface is the I/O it doesn't do. Verification doesn't need a lock
 * (D-16's reasoning doesn't apply here): a key being revoked mid-flight by
 * a concurrent request is an ordinary auth-staleness window, not a
 * double-spend risk -- there's no cumulative limit being raced.
 */

export interface NewAgentApiKey {
  organizationId: string;
  /** Omit (or null) to mint an org credential instead of an agent key. */
  agentId?: string | null;
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
  agentId: string | null;
  prefix: string;
  name: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type AgentKeyVerification =
  | { ok: true; keyId: string; organizationId: string; agentId: string | null }
  | { ok: false; reason: "not_found" | "revoked" };

export interface AgentKeyRepository {
  createKey(input: NewAgentApiKey, now: Date): Promise<CreatedAgentApiKey>;

  /** Looks up by the presented key's prefix, then compares the full key's
   * hash. Does not throw for an unknown or revoked key -- that's a normal,
   * expected outcome the caller decides how to handle. */
  verifyKey(fullKey: string, now: Date): Promise<AgentKeyVerification>;

  /** Scoped to `organizationId` (D-1: nothing is queried without it) --
   * revoking a key by id alone would let any authenticated credential
   * revoke any other organization's key. Returns whether a matching,
   * not-already-revoked key in that organization was found. */
  revokeKey(keyId: string, organizationId: string, now: Date): Promise<boolean>;
}
