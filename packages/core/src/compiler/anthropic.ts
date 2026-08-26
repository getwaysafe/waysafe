import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parsePolicy, type PolicyIssue } from "../policy.js";
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.js";
import type {
  CompileRequest,
  CompileResult,
  IntentCompiler,
} from "./types.js";

const ClarificationSchema = z.object({
  path: z.string(),
  question: z.string(),
  suggested_default: z.unknown().optional(),
  rationale: z.string().default(""),
});

const EnvelopeSchema = z.union([
  z.object({
    status: z.literal("compiled"),
    policy: z.unknown(),
    assumptions: z.array(z.string()).default([]),
  }),
  z.object({
    status: z.literal("needs_clarification"),
    clarifications: z.array(ClarificationSchema).min(1),
    draft: z.unknown().optional(),
  }),
]);

export interface AnthropicCompilerOptions {
  client?: Anthropic;
  apiKey?: string;
  model?: string;
  /** How many repair attempts after the first try. */
  maxRepairAttempts?: number;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Compiles natural language into policy using an Anthropic model.
 *
 * The model's output is never trusted: it is parsed, schema-validated and
 * coherence-checked. On failure the compiler feeds the validation errors back
 * once and retries. If it still does not validate, compilation FAILS — the
 * compiler never repairs a policy itself, because a silently corrected
 * financial limit is worse than no mandate at all.
 */
export class AnthropicIntentCompiler implements IntentCompiler {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxRepairAttempts: number;
  private readonly maxTokens: number;

  constructor(options: AnthropicCompilerOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
      });
    this.model =
      options.model ?? process.env.BLES_COMPILER_MODEL ?? DEFAULT_MODEL;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    const startedAt = Date.now();
    const system = buildSystemPrompt(request.context);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: buildUserPrompt(request.intent_text) },
    ];

    let attempts = 0;
    let lastIssues: PolicyIssue[] = [];

    while (attempts <= this.maxRepairAttempts) {
      attempts += 1;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages,
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const diagnostics = {
        compiler: this.name,
        model: this.model,
        attempts,
        duration_ms: Date.now() - startedAt,
      };

      const envelope = parseEnvelope(text);
      if (!envelope.ok) {
        lastIssues = envelope.issues;
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: buildRepairPrompt(text, envelope.issues) },
        );
        continue;
      }

      if (envelope.value.status === "needs_clarification") {
        return {
          status: "needs_clarification",
          clarifications: envelope.value.clarifications,
          draft: envelope.value.draft,
          diagnostics,
        };
      }

      const parsed = parsePolicy(envelope.value.policy);
      if (!parsed.ok || !parsed.policy) {
        lastIssues = parsed.issues;
        messages.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content: buildRepairPrompt(
              text,
              parsed.issues.filter((i) => i.severity === "error"),
            ),
          },
        );
        continue;
      }

      return {
        status: "compiled",
        policy: parsed.policy,
        issues: parsed.issues,
        assumptions: envelope.value.assumptions,
        diagnostics,
      };
    }

    return {
      status: "failed",
      issues: lastIssues.length
        ? lastIssues
        : [
            {
              path: "/",
              message: "compiler did not produce a valid policy",
              severity: "error",
            },
          ],
      diagnostics: {
        compiler: this.name,
        model: this.model,
        attempts,
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}

type EnvelopeResult =
  | { ok: true; value: z.infer<typeof EnvelopeSchema> }
  | { ok: false; issues: PolicyIssue[] };

function parseEnvelope(text: string): EnvelopeResult {
  const json = extractJsonObject(text);
  if (json === null) {
    return {
      ok: false,
      issues: [
        {
          path: "/",
          message: "response did not contain a JSON object",
          severity: "error",
        },
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "/",
          message: `response was not valid JSON: ${(error as Error).message}`,
          severity: "error",
        },
      ],
    };
  }

  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: `/${issue.path.join("/")}`,
        message: issue.message,
        severity: "error" as const,
      })),
    };
  }

  return { ok: true, value: parsed.data };
}

/** Pull the outermost JSON object out of a response, tolerating code fences. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  const start = candidate.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }

  return null;
}
