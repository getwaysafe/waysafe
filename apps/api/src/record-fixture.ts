/**
 * Record a compiler fixture from a live model call.
 *
 *   npm run compile:record -w @agentpay/api -- <name> "<instruction>"
 *
 * Writes fixtures/compiler/<name>.json. Fixtures are compiled against
 * FIXTURE_NOW so expiries stay stable; review the output before committing.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnthropicIntentCompiler,
  createCompileContext,
  FIXTURE_NOW,
} from "@agentpay/core";

const [name, ...rest] = process.argv.slice(2);
const instruction = rest.join(" ").trim();

if (!name || !instruction) {
  console.error(
    'usage: npm run compile:record -w @agentpay/api -- <name> "<instruction>"',
  );
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required to record a fixture");
  process.exit(1);
}

const compiler = new AnthropicIntentCompiler();
const result = await compiler.compile({
  intent_text: instruction,
  context: createCompileContext({ now: FIXTURE_NOW }),
});

if (result.status === "failed") {
  console.error("compilation failed; nothing recorded");
  console.error(JSON.stringify(result.issues, null, 2));
  process.exit(1);
}

const output =
  result.status === "compiled"
    ? {
        status: "compiled",
        policy: result.policy,
        assumptions: result.assumptions,
      }
    : {
        status: "needs_clarification",
        clarifications: result.clarifications,
        draft: result.draft,
      };

const path = join(process.cwd(), "fixtures", "compiler", `${name}.json`);
writeFileSync(
  path,
  `${JSON.stringify({ name, intent_text: instruction, output }, null, 2)}\n`,
);

console.log(`recorded ${path} (${result.status})`);
console.log("review it before committing — this is a model's guess about money");
