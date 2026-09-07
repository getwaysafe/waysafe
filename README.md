# Waysafe

The system of record for delegated financial authority.

One API to decide whether an AI agent may take an economic action:

```ts
const decision = await waysafe.authorize({ agent, principal, action });
// => ALLOW | DENY | STEP_UP
```

**Status: Week 6 of 6, complete.** ✅ Domain model, policy engine, WebAuthn +
agent keys, payment execution, the TypeScript SDK, and the developer
dashboard are all in place. Week 6 shipped the dashboard's step-up approval
UI, the rename (`DECISIONS.md` D-19/D-25, superseded by D-28), a signed and
independently verifiable evidence chain (D-26/OQ-8), and a scripted
end-to-end demo (`npm run demo`, D-27).

Since the sprint closed: the product was renamed to Waysafe (D-28,
resolving OQ-2), the production WebAuthn RP ID was fixed at
`dashboard.waysafe.ai` (D-29, resolving OQ-5), `POST /v1/principals` and
`GET /v1/principals/:id` were added (D-30, resolving OQ-9), and the runtime
target was set -- dashboard on Vercel, API and worker on Render (D-31,
resolving OQ-6).

Two open questions remain, both needing a human answer rather than code:
**OQ-3** (who the first external developer is -- it decides the SDK's
ergonomics) and **OQ-7** (whether the policy schema needs per-unit limits,
or whether the PRD's contradictory hotel example should just be corrected).

---

## Quick start

```bash
npm install
npx tsx examples/quickstart.ts
```

That's it — no `.env`, no database, no API key. It boots a local Waysafe API
in-memory and walks the full journey through `@waysafe/sdk`: compile a
policy, create and authenticate a mandate, authorize a few purchases (an
ALLOW, a STEP_UP you approve yourself, a DENY), execute one, and read the
evidence chain back. `examples/quickstart.ts` is a runnable program, not
prose — if getting to a first decision takes more than an hour, that's a bug
in the SDK, not these docs.

To point the same script at a real, already-running deployment instead:

```bash
WAYSAFE_BASE_URL=https://your-deployment.example \
WAYSAFE_API_KEY=wsf_live_... \
npx tsx examples/quickstart.ts
```

Run the dashboard (needs the API running separately, `npm run dev:api`):

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local
# set WAYSAFE_DASHBOARD_SESSION_SECRET -- see the file for how
npm run dev -w @waysafe/dashboard
```

Or watch the whole story end to end -- an instruction, a passkey, four
agent attempts (including a merchant-spoofing attempt a human refuses live),
and a signed receipt verified independently:

```bash
npm run demo
```

Also one command with nothing configured; runs against real Postgres
instead of in-memory if `DATABASE_URL` is set, minting a fresh organization
every time so re-running it never collides with a prior run.

---

## The idea in sixty seconds

A person tells an agent something fuzzy:

> "Get me a good hotel in Miami. Nothing ridiculous."

Financial infrastructure cannot enforce that. Waysafe compiles it into a
policy that can be enforced:

```
lodging, Miami
at most $900 per booking, $1,800 total
your approval required at or above $1,250
refundable required
expires in 24 hours
```

A model does the compiling. A model never makes the authorization decision.
The compiled policy is shown to the person, authenticated with a passkey,
frozen, and from then on enforced by deterministic code that a model cannot
reach.

That boundary is the whole product.

---

## Layout

```
packages/core     domain model, policy schema, reason codes, intent compiler
packages/db       Prisma schema (Postgres)
packages/sdk      TypeScript SDK — the developer contract
apps/api          REST API
apps/dashboard    developer dashboard (Next.js, read-mostly)
examples/         runnable quickstart and demo -- clone and run, not prose
fixtures/compiler recorded compiler output, replayed in tests
DECISIONS.md      every default taken, and the open questions
```

`DECISIONS.md` is the first thing to read. It records every decision made
across the sprint and the open questions still outstanding.

---

## What Week 1 delivers

**Exit criteria: a developer can submit a natural-language mandate and receive
a validated structured policy object.** ✅

- `POST /v1/mandates/compile` — instruction in, validated policy out
- `POST /v1/policies/validate` — validate a hand-authored policy
- `GET  /v1/reason-codes` — the dictionary Week 2 emits
- 57 tests covering the schema, merchant identity, and the compiler

Three things worth knowing before reading the code:

**Money is integer minor units.** `$150` is `15000`. The schema rejects
decimals with an explanatory error. (`D-2`)

**A merchant that cannot be verified can never produce ALLOW.** If the agent
just types `"Staples"`, the allowlist does not match — the best available
outcome becomes `STEP_UP`. Allowlists are keyed on domains and PSP account ids,
never names. This is the difference between a policy engine and a policy
theater. (`D-3`)

**The compiler asks rather than inventing a limit.** An instruction with no
ceiling in it returns `needs_clarification` with questions, at HTTP 200.
Everything the compiler *did* decide on its own is returned in `assumptions`,
in plain language, for the principal to check before they authenticate. (`D-6`)

---

## The six-week build

| Week | Delivers | Exit criteria |
|---|---|---|
| 1 ✅ | Domain model, policy schema, intent compiler | NL mandate → validated policy object |
| 2 ✅ | Deterministic policy engine + spend ledger | Arbitrary actions evaluated against an active mandate |
| 3 ✅ | WebAuthn, agent API keys, hash-chained audit log | Every decision tied to an authenticated mandate version |
| 4 ✅ | Payment adapter + Stripe test mode + x402 stub | ALLOW executes, DENY cannot, STEP_UP waits |
| 5 ✅ | TypeScript SDK + developer dashboard | A new developer integrates without raw REST |
| 6 ✅ | Demo, hardening, docs | Full lifecycle, instruction to verifiable receipt |

---

## Security posture

- No card credential ever enters a model prompt, trace, or log.
- A model interprets intent. A model never authorizes a transaction.
- Every mandate and policy change is versioned; nothing is edited in place.
- Every execution cites the exact policy hash that authorized it.
- Passkeys prove authorization without Waysafe storing biometric data.
- The system is designed to stay out of PCI scope, not to manage it.
- Every evidence event is Ed25519-signed and independently verifiable --
  `verifyEvidenceIndependently` in `@waysafe/sdk` checks a receipt without
  trusting this server's own database or its judgment about it. (`D-26`)
