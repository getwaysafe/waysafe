/**
 * AgentPay TypeScript SDK.
 *
 * The full surface ships in Week 5. It is declared here in Week 1 because the
 * SDK signature is the product's actual contract — every later week is judged
 * against whether it can implement these four calls cleanly.
 *
 *   const mandate  = await agentpay.compileMandate({ principal, instruction });
 *   const decision = await agentpay.authorize({ agent, principal, action });
 *   if (decision.decision === "ALLOW") await agentpay.execute(decision);
 *   const receipt  = await agentpay.verify(transactionId);
 *
 * Methods not yet implemented throw NotImplementedError naming the week that
 * lands them, rather than silently returning something wrong.
 */

import type {
  AuthorizationRequest,
  Decision,
  Policy,
  ReasonCode,
} from "@agentpay/core";

export class AgentPayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AgentPayError";
  }
}

export class NotImplementedError extends AgentPayError {
  constructor(method: string, week: number) {
    super(`agentpay.${method}() lands in Week ${week} of the build sprint`);
    this.name = "NotImplementedError";
  }
}

export interface AgentPayOptions {
  /** Base URL of the AgentPay API, e.g. https://api.agentpay.dev */
  baseUrl: string;
  /** Agent service credential. Never a card credential, never a model prompt. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CompileMandateRequest {
  /** Natural-language instruction from the principal. */
  instruction: string;
  timezone?: string;
  default_ttl_hours?: number;
}

export interface Clarification {
  path: string;
  question: string;
  suggested_default?: unknown;
  rationale: string;
}

export interface MandateConfirmation {
  summary: string;
  policy_hash: string;
  terms: string[];
  assumptions: string[];
  warnings: string[];
  expires_at: string;
}

export type CompileMandateResponse =
  | {
      status: "compiled";
      policy: Policy;
      policy_hash: string;
      confirmation: MandateConfirmation;
    }
  | {
      status: "needs_clarification";
      clarifications: Clarification[];
      draft?: unknown;
    };

export interface AuthorizationDecision {
  authorization_id: string;
  decision: Decision;
  reason_codes: ReasonCode[];
  reasons: { code: ReasonCode; message: string }[];
  mandate_id: string;
  mandate_version_id: string;
  policy_hash: string;
  step_up?: {
    /** Where to send the principal to approve. */
    url: string;
    expires_at: string;
  };
}

export class AgentPay {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AgentPayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Compile a natural-language instruction into a policy.
   *
   * This does NOT create a mandate. A `compiled` result must be shown to the
   * principal and authenticated before it can authorize anything — the returned
   * `confirmation.assumptions` are exactly the things the compiler decided that
   * the principal never said, and skipping that step is how an agent ends up
   * spending against a limit nobody agreed to.
   */
  async compileMandate(
    request: CompileMandateRequest,
  ): Promise<CompileMandateResponse> {
    return this.post<CompileMandateResponse>("/v1/mandates/compile", {
      intent_text: request.instruction,
      timezone: request.timezone,
      default_ttl_hours: request.default_ttl_hours,
    });
  }

  /** Validate a hand-authored policy document. */
  async validatePolicy(policy: unknown): Promise<{
    ok: boolean;
    issues: { path: string; message: string; severity: string }[];
    policy_hash?: string;
  }> {
    return this.post("/v1/policies/validate", policy);
  }

  /** Week 2. */
  async authorize(_request: AuthorizationRequest): Promise<AuthorizationDecision> {
    throw new NotImplementedError("authorize", 2);
  }

  /** Week 4. */
  async execute(_decision: AuthorizationDecision): Promise<never> {
    throw new NotImplementedError("execute", 4);
  }

  /** Week 6. */
  async verify(_transactionId: string): Promise<never> {
    throw new NotImplementedError("verify", 6);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => undefined);

    // needs_clarification is a 200; only real failures throw.
    if (!response.ok) {
      throw new AgentPayError(
        `agentpay ${path} failed with ${response.status}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }
}

export type { Policy, Decision, ReasonCode };
