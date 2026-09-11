/**
 * A browser-safe subset of `@waysafe/core`'s surface -- D-43.
 *
 * `./index.ts` (the package's only export before this file) transitively
 * imports `node:crypto` via `evidence.ts`, `evidence-signing.ts`, and
 * `domain.ts` (id generation), and pulls in `@anthropic-ai/sdk` via
 * `compiler/index.ts`. None of that bundles for a browser: this package's
 * `package.json` has no `sideEffects: false`, so a bundler cannot drop an
 * unused module without resolving its own top-level imports first, and a
 * client bundle has no `node:crypto`.
 *
 * `evaluate()` itself is pure and has none of that baggage -- its own import
 * graph (`merchant.ts`, `money.ts`, `policy.ts`, `reason-codes.ts`,
 * `time.ts`, plus `domain.ts` for the `ProposedAction` *type* only, which
 * `import type` strips at compile time) never touches `node:crypto`. This
 * file exists so a browser can call the *real* `evaluate()` -- the same
 * compiled output the server runs, not a reimplementation -- rather than
 * face the same problem D-42 solved differently for evidence verification
 * (a from-scratch WebCrypto reimplementation, because there the thing being
 * verified, signing, is unavoidably `node:crypto`-shaped). Nothing here
 * should ever import `evidence.ts`, `evidence-signing.ts`, or
 * `compiler/index.ts`, even transitively -- if a future addition wants one
 * of those, it belongs in `index.ts`, not here.
 *
 * See `packages/core/package.json`'s `"./browser"` export and
 * DECISIONS.md D-43.
 */

export { evaluate } from "./engine/evaluate.js";
export {
  emptySpendSnapshot,
  windowSpend,
  type EngineInput,
  type EngineResult,
  type LimitWindowValue,
  type SpendSnapshot,
  type WindowSpend,
} from "./engine/types.js";

export {
  resolveMerchant,
  matchesDenylist,
  satisfiesAllowlist,
  merchantRefKey,
  isIdentityScheme,
  createStaticDirectory,
  EMPTY_DIRECTORY,
  MerchantScheme,
  MerchantTrust,
  MerchantAttestationSource,
  type MerchantAssertion,
  type MerchantRef,
  type MerchantDirectory,
  type MerchantDirectoryEntry,
  type ResolvedMerchant,
} from "./merchant.js";

export { formatMoney, type Currency, type MinorUnits } from "./money.js";

export {
  POLICY_SCHEMA_VERSION,
  parsePolicy,
  validatePolicyCoherence,
  canonicalizePolicy,
  UnlistedDisposition,
  LimitWindow,
  type Policy,
  type PolicyIssue,
  type PolicyParseResult,
  type CumulativeLimit,
  type MerchantRules,
  type CategoryRules,
  type StepUpRules,
  type Accounting,
  type Constraint,
  type TimeWindow,
} from "./policy.js";

export { Decision, ReasonCode, decisionForReasonCode, type Reason } from "./reason-codes.js";

// Type-only: `import type` is erased at compile time, so this never pulls
// domain.ts's runtime code (and its `node:crypto` import) into the bundle.
export type { ProposedAction } from "./domain.js";
