import { createHash } from "node:crypto";
import { parsePolicy } from "../policy.js";
import type {
  Clarification,
  CompileRequest,
  CompileResult,
  IntentCompiler,
} from "./types.js";

/**
 * A compiler that replays pre-recorded outputs.
 *
 * This is deliberately NOT a fake NLP implementation. Tests that depend on a
 * hand-rolled parser passing for a model would tell us nothing. Instead this
 * replays real compiler output captured in fixtures, which makes the test suite
 * deterministic and offline while still exercising the full validation,
 * coherence-checking and assumption-surfacing path.
 *
 * Record new fixtures with: npm run compile:record -w @waysafe/api
 */
export interface CompilerFixture {
  name: string;
  intent_text: string;
  /** Raw envelope as the model produced it. */
  output: unknown;
}

export class FixtureIntentCompiler implements IntentCompiler {
  readonly name = "fixture";
  private readonly byKey = new Map<string, CompilerFixture>();

  constructor(fixtures: CompilerFixture[]) {
    for (const fixture of fixtures) {
      this.byKey.set(normalizeKey(fixture.intent_text), fixture);
    }
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    const startedAt = Date.now();
    const fixture = this.byKey.get(normalizeKey(request.intent_text));
    const diagnostics = {
      compiler: this.name,
      attempts: 1,
      duration_ms: Date.now() - startedAt,
    };

    if (!fixture) {
      return {
        status: "failed",
        issues: [
          {
            path: "/",
            message: `no compiler fixture recorded for this instruction (key ${hashKey(
              request.intent_text,
            )}); run the recorder or use the anthropic compiler`,
            severity: "error",
          },
        ],
        diagnostics,
      };
    }

    const envelope = fixture.output as Record<string, unknown>;

    if (envelope.status === "needs_clarification") {
      return {
        status: "needs_clarification",
        clarifications: envelope.clarifications as Clarification[],
        draft: envelope.draft,
        diagnostics,
      };
    }

    const parsed = parsePolicy(envelope.policy);
    if (!parsed.ok || !parsed.policy) {
      return { status: "failed", issues: parsed.issues, diagnostics };
    }

    return {
      status: "compiled",
      policy: parsed.policy,
      issues: parsed.issues,
      assumptions: (envelope.assumptions as string[]) ?? [],
      diagnostics,
    };
  }
}

function normalizeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hashKey(text: string): string {
  return createHash("sha256").update(normalizeKey(text)).digest("hex").slice(0, 12);
}
