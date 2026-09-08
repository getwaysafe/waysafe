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
examples/         quickstart.ts (no env needed) and demo.ts (the scripted lifecycle, D-27)
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
the new `npm run db:constraints`, since `db push` can't express it). The
live bypass test's account in this environment hasn't completed Stripe's own
Issuing setup, so it currently self-reports SKIPPED rather than a live pass.
`OQ-7` (per-unit limits vs. correcting the PRD's example) is the one open
question left.

Optimize for the smallest credible implementation with a legible authorization
lifecycle — not production-scale payment infrastructure. Keep payment providers
behind adapter interfaces; keep enforcement adapters behind theirs.
