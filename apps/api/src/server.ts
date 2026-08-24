import Fastify from "fastify";
import { z } from "zod";
import {
  buildConfirmation,
  createCompileContext,
  createCompilerFromEnv,
  hashPolicy,
  loadCompilerFixtures,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  REASON_CODE_DESCRIPTIONS,
  type IntentCompiler,
} from "@agentpay/core";

const CompileBodySchema = z.object({
  intent_text: z.string().min(1).max(4000),
  /** Optional overrides; both default from the environment. */
  timezone: z.string().min(1).optional(),
  currency: z.literal("USD").optional(),
  default_ttl_hours: z.number().int().positive().max(8760).optional(),
});

export interface BuildServerOptions {
  compiler?: IntentCompiler;
  logger?: boolean;
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            // Nothing that could carry a credential reaches the logs. The list
            // grows as adapters land; it is never allowed to shrink.
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-api-key"]',
                "req.body.card",
                "req.body.payment_method",
                "res.headers['set-cookie']",
              ],
              censor: "[redacted]",
            },
          },
  });

  const compiler = options.compiler ?? createCompilerFromEnv(loadCompilerFixtures());

  app.get("/health", async () => ({
    status: "ok",
    policy_schema_version: POLICY_SCHEMA_VERSION,
    compiler: compiler.name,
  }));

  /**
   * Week 1 exit criteria:
   * a developer submits a natural-language mandate and receives a validated
   * structured policy object.
   *
   * This endpoint deliberately does NOT create a mandate. Compiling is a
   * proposal; the mandate exists only once the principal has seen the
   * confirmation and authenticated it (Week 3).
   */
  app.post("/v1/mandates/compile", async (request, reply) => {
    const body = CompileBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: body.error.issues.map((i) => ({
          path: `/${i.path.join("/")}`,
          message: i.message,
        })),
      });
    }

    const context = createCompileContext({
      now: new Date(),
      ...(body.data.timezone ? { timezone: body.data.timezone } : {}),
      ...(body.data.currency ? { currency: body.data.currency } : {}),
      ...(body.data.default_ttl_hours
        ? { default_ttl_hours: body.data.default_ttl_hours }
        : {}),
    });

    const result = await compiler.compile({
      intent_text: body.data.intent_text,
      context,
    });

    if (result.status === "failed") {
      return reply.code(422).send({
        status: "failed",
        error: "policy_compilation_failed",
        issues: result.issues,
        diagnostics: result.diagnostics,
      });
    }

    if (result.status === "needs_clarification") {
      // 200, not an error: asking is a valid, expected outcome.
      return reply.code(200).send({
        status: "needs_clarification",
        clarifications: result.clarifications,
        draft: result.draft,
        diagnostics: result.diagnostics,
      });
    }

    return reply.code(200).send({
      status: "compiled",
      policy: result.policy,
      policy_hash: hashPolicy(result.policy),
      confirmation: buildConfirmation(result),
      diagnostics: result.diagnostics,
    });
  });

  /** Validate a hand-authored policy without going through the compiler. */
  app.post("/v1/policies/validate", async (request, reply) => {
    const result = parsePolicy(request.body);
    return reply.code(result.ok ? 200 : 422).send({
      ok: result.ok,
      issues: result.issues,
      ...(result.policy ? { policy_hash: hashPolicy(result.policy) } : {}),
    });
  });

  /** The reason-code dictionary, so SDK and dashboard consumers can render them. */
  app.get("/v1/reason-codes", async () => ({
    reason_codes: Object.entries(REASON_CODE_DESCRIPTIONS).map(
      ([code, description]) => ({ code, description }),
    ),
  }));

  return app;
}
