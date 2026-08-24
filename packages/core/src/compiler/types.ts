import type { Policy, PolicyIssue } from "../policy.js";

/**
 * Context the compiler needs but must never guess.
 */
export interface CompileContext {
  /** Currency the resulting policy is denominated in. */
  currency: "USD";
  /** IANA timezone that defines calendar window boundaries. */
  timezone: string;
  /** Evaluation "now" — makes relative phrases like "this month" resolvable and tests deterministic. */
  now: Date;
  /** Default lifetime when the instruction states no expiry. */
  default_ttl_hours: number;
}

export interface CompileRequest {
  /** The principal's natural-language instruction, verbatim. */
  intent_text: string;
  context: CompileContext;
}

/**
 * A question the compiler needs answered before it can produce an enforceable
 * policy. This is the path the PRD did not have: rather than inventing a limit
 * the principal never stated, the compiler asks.
 */
export interface Clarification {
  /** Policy field the answer would populate, as a JSON pointer. */
  path: string;
  question: string;
  /** What the compiler would use if the principal just says "whatever you think". */
  suggested_default?: unknown;
  /** Why this cannot be silently defaulted. */
  rationale: string;
}

export type CompileResult =
  | {
      status: "compiled";
      policy: Policy;
      /** Non-blocking coherence warnings to show at confirmation time. */
      issues: PolicyIssue[];
      /** Things the compiler chose that the principal did not say. Must be shown before authentication. */
      assumptions: string[];
      diagnostics: CompileDiagnostics;
    }
  | {
      status: "needs_clarification";
      clarifications: Clarification[];
      /** Best-effort partial policy, for showing the principal what was understood. */
      draft?: unknown;
      diagnostics: CompileDiagnostics;
    }
  | {
      status: "failed";
      issues: PolicyIssue[];
      diagnostics: CompileDiagnostics;
    };

export interface CompileDiagnostics {
  compiler: string;
  model?: string;
  attempts: number;
  duration_ms: number;
}

export interface IntentCompiler {
  readonly name: string;
  compile(request: CompileRequest): Promise<CompileResult>;
}
