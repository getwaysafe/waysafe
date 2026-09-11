# Waysafe — working agreement

The system of record for delegated financial authority.
One API decides whether an AI agent may take an economic action: `ALLOW` / `DENY` / `STEP_UP`.

**Read `DECISIONS.md` before changing anything.** It records the decisions
(`D-1`…`D-32`) already implemented and the open questions (`OQ-n`) awaiting a
human answer. Those IDs are referenced in code comments and commit messages.
If a change contradicts a `D-n`, say so and ask — do not quietly diverge. If
you find a new contradiction or make a new judgment call, add it to
`DECISIONS.md` in the same commit.

## Non-negotiables

These are the invariants the product is built on. Violating one is a bug even if
tests pass.

1. **A model never authorizes a transaction.** An LLM appears in exactly one
   place — the intent compiler, turning natural language into a proposed policy.
   Everything downstream of a frozen policy is deterministic TypeScript. Never
   add a model call to the authorization path.

2. **Money is integer minor units.** `$150` is `15000`. No floats, no decimal
   strings, no `parseFloat` on an amount, ever. See `packages/core/src/money.ts`.

3. **An unverified merchant can never produce ALLOW.** Trust comes from who
   attested an identifier, never merely which field it's in (`D-34`): a PSP
   account id or card-network merchant id is verified only when a payment
   rail's own callback supplied it, never when the agent asserted it on
   `POST /v1/authorizations` — an agent typing `psp_account` or `network_mid`
   is exactly as untrustworthy as it typing a `name`, and caps out at
   `STEP_UP` right alongside it. Directory-corroborated domains verify either
   way, since that corroboration is Waysafe's own lookup, not a claim about
   who supplied the string. This is `D-3`, amended by `D-34`, and it is the
   difference between a policy engine and policy theater. Any change here
   needs a test proving the attack still fails — for both the agent path and
   the rail path.

4. **No credential ever reaches a model prompt, a log, or a trace.** Logger
   redaction lives in `apps/api/src/server.ts` and the path list only grows.

5. **Mandates are immutable versions.** Never mutate a `MandateVersion` after
   creation except to stamp authentication. Edits write a new version and
   supersede the old one. Every `Authorization` cites the `mandateVersionId` and
   `policyHash` it was decided against.

6. **Cumulative spend is a SUM over the ledger, never a counter column.**
   Concurrent authorizations serialize on a row lock on the mandate. A counter
   column here is a lost update waiting to happen.

7. **Reason codes are a public API.** Additive only, never renamed. Every
   decision branch returns one from `packages/core/src/reason-codes.ts`.

8. **The compiler asks rather than inventing a limit.** `needs_clarification` is
   a valid outcome returned at HTTP 200. Never default a spending ceiling the
   principal did not state.

9. **An agent's cooperation is never a control.** Enforcement is
   rail-initiated: the rail asks Waysafe before funds move, and the agent never
   has to. Anything that depends on the agent calling `authorize()` first — the
   SDK, an MCP tool, a framework guard node — is a *preflight*, never the thing
   that stops money moving. Waysafe is the required signer on every rail it
   enforces, and holds no funds. This is `D-32`; the incidents behind it are
   recorded there. Never describe a preflight-only integration as enforced.

## Layout

```
packages/core     domain model, policy schema v1, reason codes, merchant identity, intent compiler, payment-adapter interface
packages/db       Prisma schema (Postgres)
packages/sdk      TypeScript SDK — the developer contract (a preflight client, see #9)
apps/api          Fastify REST API, expiry worker, payment adapters (Stripe test mode, x402 stub), evidence chain
apps/dashboard    Next.js developer dashboard
examples/         quickstart.ts (no env needed), demo.ts (the scripted lifecycle, D-27),
                  and demo-merchant.ts (a tiny real x402 merchant for the /demo page, D-42)
fixtures/compiler recorded compiler output, replayed deterministically in tests
```

## Commands

```bash
npm install
npm run db:generate                    # prisma generate
npm run db:push                        # prisma db push (needs DATABASE_URL)
npm run db:constraints                 # applies packages/db/prisma/manual-constraints.sql
                                        # (CHECK constraints db push can't express -- D-35;
                                        # run once after every db:push)
npm test                               # vitest, all workspaces
npm run typecheck                      # tsc -b, plus the test tsconfig
npm run dev:api                        # api on :3001
npm run dev:worker                     # step-up expiry worker (D-31; needs DATABASE_URL)
npm run quickstart                     # examples/quickstart.ts, no env required
npm run demo                           # examples/demo.ts, the full lifecycle
npm run compile -w @waysafe/api -- "your instruction"     # compile from the terminal
npm run compile:record -w @waysafe/api -- <name> "..."    # record a new fixture

# /demo (D-42) -- three processes, in order:
npm run demo:seed -w @waysafe/api      # once: seeds org_demo, writes the dashboard's API key
npm run dev:api                        # needs WAYSAFE_ENABLE_DEMO_ROUTES=1
npm run demo:merchant                  # examples/demo-merchant.ts, on :4402
npm run dev:dashboard                  # then open /demo
```

Without `ANTHROPIC_API_KEY` the compiler replays fixtures, so tests and the CLI
work offline. Without `STRIPE_SECRET_KEY` (a `sk_test_`/`rk_test_` key) the
Stripe adapter is not registered and `execute()` on that rail is unavailable.

## Testing posture

- Tests are written before the implementation for anything in the authorization
  path. That path decides whether money moves.
- Compiler tests replay recorded model output (`FixtureIntentCompiler`). Never
  replace this with a hand-rolled parser — a test that passes because a regex
  agreed with itself proves nothing.
- Every policy rule needs both a passing and a failing case, plus the adversarial
  case where an agent supplies hostile input.
- Every enforcement adapter (`D-32`) needs the bypass test: the raw credential,
  used with no Waysafe SDK in the process, is still declined at the rail.
- Fixtures record a model's guesses about someone's money. Read them before
  committing.

## Status

The six-week sprint is complete (`D-1`…`D-27`). Since then: the rename to
Waysafe (`D-28`), production RP ID (`D-29`), principal routes (`D-30`), runtime
target (`D-31`), the enforcement model (`D-32`), the `D-32` spike itself
(`D-33`: `EnforcementAdapter` in core plus the Stripe Issuing real-time-
authorization adapter, judged by the bypass test D-32 named), and a fix to
non-negotiable #3 that D-33 exposed (`D-34`: merchant trust now depends on
who attested an identifier, not merely which field it's in — an agent could
previously assert an allowlisted `psp_account`/`network_mid` on
`POST /v1/authorizations` and get ALLOW, exactly the attack D-3 exists to
stop, just on a different field), and the fix to D-33 point 6 (`D-35`: the
actor on a rail-initiated authorization is a new `Instrument` entity, never
an Agent and never null — card-rail spend now writes a real `RESERVATION`
and counts against D-4's cumulative limits; `Authorization` gained
`actorKind`/`instrumentId`, enforced by a DB CHECK constraint applied via
the new `npm run db:constraints`, since `db push` can't express it), and a
real-Stripe-behavior fix (`D-36`: Stripe now attaches a charge's
`balance_transaction` asynchronously, a few seconds after the PaymentIntent
confirms, not synchronously as `StripeAdapter.execute()` assumed --
`execute()` now polls briefly for the real fee instead of reporting a false
`0`), and the provisioning-contract fix that followed from actually wiring
a financial account in (`D-37`: Stripe Issuing on this account has no
legacy balance — card creation requires a v2 Money Management financial
account via `financial_account_v2`, not the `financial_account` field
stripe-node's shipped types still name, read from the new
`STRIPE_ISSUING_FINANCIAL_ACCOUNT` env var and required at provisioning
time; the bypass test's SKIP now distinguishes a missing financial-account
id, a financial account whose status isn't `"active"`, and Stripe never
invoking the webhook, as three separately-labeled reasons instead of one
generic message), and the consent-provenance fix D-37 surfaced next
(`D-38`: Stripe Issuing also requires
`individual.card_issuing.user_terms_acceptance` — the cardholder's own
legal acceptance of Stripe's terms — and Waysafe never synthesizes it;
`provisionCardForMandate` now sources it only from the principal's real
WebAuthn mandate-authentication ceremony (D-20), which now captures and
persists the request IP on the `MandateVersion` alongside
`authenticatedAt` via a new required `ip` param on `activateMandate`, and
refuses to provision — before ever calling Stripe — when a mandate was
never authenticated; a successful provisioning records the acceptance as
its own evidence event, `mandate.card_issuing_terms_accepted`, distinct
from `mandate.authenticated`), and the dashboard fix D-35 always implied but
never shipped (`D-39`: authorization receipts now show who acted — the
detail page renders `actor_kind`, and for an instrument actor, its rail
and a masked `external_ref` via a new org-scoped `GET /v1/instruments/:id`
and `Waysafe.getInstrument`; the list page shows `actor_kind` and a
truncated reference without the per-row lookup that showing rail there
would cost), and the x402 enforcement adapter (`D-40`: `EnforcementAdapter`
for x402, Waysafe as payer-side signer — merchant identity gained
`MerchantScheme.ONCHAIN_ADDRESS` (the `payTo` address, D-3/D-34 rules
applied unchanged: rail-attested VERIFIED, agent-attested caps at
ASSERTED), and `handleX402PaymentRequest` never accepts payment
requirements from a caller, only a `resourceUrl` to independently fetch,
closing the same laundering attack D-34 closed for `psp_account`/
`network_mid`. D-40 also surfaces, rather than resolves, a real custody
tension: x402's standard signing flow is single-key by construction, so
there is no way to make Waysafe a required co-signer without either
holding the payer's key (forbidden by non-negotiable #9) or leaving the
agent advisory (the OQ-10 hole); `toResponse` therefore produces a
co-signature that is cryptographically necessary but not sufficient to
move funds, and the 2-of-2 smart account that would close the gap is
deliberately not built here — see D-40 and its update to OQ-10), and the
deployment of that account (`D-41`: a real Safe, threshold 2, per mandate,
owners the agent's session key and a new secp256k1
`WAYSAFE_SAFE_COSIGNER_KEY` — genuinely distinct from D-40's Ed25519
`WAYSAFE_X402_COSIGNER_KEY`, since Safe owners are secp256k1 EVM addresses
and Ed25519 has none — deployed and verified live on Polygon Amoy via
`@safe-global/protocol-kit`; checked on-chain rather than assumed that
Amoy's real test USDC has no EIP-1271 path for `transferWithAuthorization`
(its implementation contract never references the EIP-1271 selector), so
settlement falls back to the Safe's own `execTransaction` calling
`transfer` directly, and the standard x402 facilitator flow stays
deferred; D-40's self-skipping bypass test part 3 is now a real, passing
proof against the deployed Safe — a genuine 2-of-2 transfer succeeds,
and the session key alone, a forged envelope, and a session-key-only
signature are each rejected on-chain). The full suite was green as of
`D-41`. Since then, `D-42` (the recordable `/demo` page) wired the two
routes D-40/D-41 built but never gave HTTP endpoints
(`POST /v1/enforcement/x402`, `POST /v1/instruments/x402`) and closed the
settlement gap for x402's `erc20_transfer_fallback` mode specifically — a
session-key relay where the agent's runtime signs with a key that never
reaches Waysafe, and Waysafe combines and broadcasts only on a genuine
ALLOW. Verified live in that session: a real ALLOW settled on-chain for
real, and all three bypass rejections reverted for real.
`x402.bypass.test.ts`'s one broadcast case (the genuine 2-of-2 transfer)
spends real gas from `WAYSAFE_SAFE_COSIGNER_KEY`'s EOA, so it will
eventually fail with `InsufficientFundsError` as that balance depletes —
this is never a code regression, just fund that address with Amoy POL
(gas only, never USDC) and re-run. This environment's financial account
(`fa_test_65VMX2oxvcxmPn0ZXck16VMWviUVSQkN5vtTn9OT1oOH56`) is still
`status: "pending"`, so the Stripe Issuing live bypass test self-reports
SKIPPED with that status rather than a live pass — that is expected, not a
failure, and nothing in this codebase funds or activates it automatically;
`D-42`'s own demo page says so too, rather than faking a Stripe scene.
`OQ-7` (per-unit limits vs. correcting the PRD's example) is the one open
question with no partial answer on record; `OQ-10`'s x402 half is now
closed for the "exact" fallback settlement path D-41 built and the
settlement bridge D-42 added — see D-41's own note on what remains
genuinely open (the standard facilitator flow, deferred on the EIP-1271
finding). `D-43` added `/story`, a separate cinematic-simulation page for
a 60-second video (linked from, and linking back to, `/demo`) — a fleet
of simulated agents under simulated compromise, but the RIGHT side's
decisions are the genuine `evaluate()`, called in the browser against a
real policy, never scripted. That needed a new browser-safe entry point,
`@waysafe/core/browser` (`packages/core/src/browser.ts`), since the
package's only prior export transitively pulled in `node:crypto` and
`@anthropic-ai/sdk` — verified mechanically that nothing reachable from
the new subpath does. `npm test` was clean apart from the pre-existing
D-42 funding-gap failure, which `/story` cannot touch (no x402, no
Stripe, no on-chain rail). `D-44` added `/film`, a three-act human-scale
companion to `/story` (one person, one phone, two instruments) built
entirely on `/demo`'s real plumbing rather than a new decision path:
Act 2's card lane replays hand-authored `issuing_authorization.request`
payloads through the real `StripeIssuingAdapter` (a new demo-only route,
`POST /v1/demo/enforcement/stripe-issuing`), its stablecoin lane is a
genuine x402/Safe ALLOW plus the three real on-chain bypass rejections,
and Act 3 is `/demo`'s real signed evidence chain, verified in the
browser. Building it surfaced a real schema constraint
(`Instrument.mandateId` is `@unique`, D-32 item 3) that a naive second
instrument on the same mandate violates — fixed with an additive
`provision_x402: false` option on `/api/demo/mandate`, never a schema
change.

Optimize for the smallest credible implementation with a legible authorization
lifecycle — not production-scale payment infrastructure. Keep payment providers
behind adapter interfaces; keep enforcement adapters behind theirs.
