/**
 * Compile an instruction from the terminal.
 *
 *   npm run compile -w @agentpay/api -- "You may spend $500 a month on office supplies at Staples."
 *
 * Uses the real Anthropic compiler when ANTHROPIC_API_KEY is set, otherwise
 * falls back to the recorded fixtures.
 */
import {
  AnthropicIntentCompiler,
  buildConfirmation,
  createCompileContext,
  FixtureIntentCompiler,
  hashPolicy,
  loadCompilerFixtures,
} from "@agentpay/core";

const instruction = process.argv.slice(2).join(" ").trim();

if (!instruction) {
  console.error('usage: npm run compile -w @agentpay/api -- "your instruction"');
  process.exit(1);
}

const useLive =
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  process.env.AGENTPAY_COMPILER !== "fixture";

const compiler = useLive
  ? new AnthropicIntentCompiler()
  : new FixtureIntentCompiler(loadCompilerFixtures());

const result = await compiler.compile({
  intent_text: instruction,
  context: createCompileContext({ now: new Date() }),
});

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log();
console.log(dim(`compiler: ${result.diagnostics.compiler}${
  result.diagnostics.model ? ` (${result.diagnostics.model})` : ""
} · ${result.diagnostics.attempts} attempt(s) · ${result.diagnostics.duration_ms}ms`));
console.log();

if (result.status === "failed") {
  console.log(bold("FAILED"));
  for (const issue of result.issues) {
    console.log(`  ${issue.severity}: ${issue.path} ${issue.message}`);
  }
  process.exit(1);
}

if (result.status === "needs_clarification") {
  console.log(bold("NEEDS CLARIFICATION"));
  console.log(
    dim("  The instruction leaves a material control undefined. No mandate is created."),
  );
  console.log();
  for (const c of result.clarifications) {
    console.log(`  ${bold(c.question)}`);
    console.log(dim(`    field: ${c.path}`));
    console.log(dim(`    why:   ${c.rationale}`));
    console.log();
  }
  process.exit(0);
}

const confirmation = buildConfirmation(result);

console.log(bold("COMPILED"));
console.log();
console.log(`  ${confirmation.summary}`);
console.log();
console.log(bold("  What will be enforced"));
for (const term of confirmation.terms) console.log(`    · ${term}`);
console.log();
console.log(bold("  What I assumed (you did not say these)"));
for (const assumption of confirmation.assumptions) {
  console.log(`    · ${assumption}`);
}
if (confirmation.warnings.length > 0) {
  console.log();
  console.log(bold("  Warnings"));
  for (const warning of confirmation.warnings) console.log(`    · ${warning}`);
}
console.log();
console.log(dim(`  policy_hash: ${hashPolicy(result.policy)}`));
console.log();
