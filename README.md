# Waysafe

Waysafe is the authorization and evidence layer for AI agent spending, across
every payment rail. One API decides whether an agent may take an economic
action:

```ts
const decision = await waysafe.authorize({ agent_id, principal_id, action });
// => ALLOW | DENY | STEP_UP
```

## Status: pre-production

This runs against Stripe **test mode** and the **Polygon Amoy testnet**.
There is no production deployment. No real money has moved through this
system. Everything described below — including "real" and "genuine" — means
real against a test-mode or testnet backend, not real production traffic.
See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) before relying on any of
this for anything that matters.

## Quickstart

There's no hosted API yet. Clone this repo and run the real engine locally —
not a mock:

```bash
git clone https://github.com/getwaysafe/waysafe.git
cd waysafe
npm install
npm run build -w @waysafe/core -w @waysafe/sdk
npm run quickstart
```

The build step is real, not optional — `dist/` is gitignored, so a clean
clone has no `@waysafe/sdk` to import until it's built. This is in-memory,
not a database — `packages/db`'s schema uses native Postgres enums,
`String[]` columns, and real `SELECT ... FOR UPDATE` row locking that the
cumulative-spend guarantee below depends on, none of which SQLite can
express, so the in-memory adapter already used by `npm test` is the honest
zero-setup path, not a shortcut around a real Postgres deployment.

Real, unedited output from an actual run, sections 1–4 (connect, compile,
create and authenticate a mandate, and the first decision — a real
**ALLOW** from the real `evaluate()` engine):

```
1. Connect
  started a local Waysafe API on 127.0.0.1:54400 (in-memory, no database)
  connected to http://127.0.0.1:54400

2. Compile a natural-language instruction into a policy
  summary: Spend up to $500 per calendar month on office supplies at Amazon and Staples, never more than $150 at once, with your approval required at any other merchant.
  assumption: Read 'never more than $150' as a hard limit: transactions above it are denied, not sent to you for approval. Say 'ask me before spending more than $150' if you would rather approve them.
  assumption: Mapped 'Amazon' to amazon.com and 'Staples' to staples.com.
  assumption: Blocked gambling, cash advance, crypto, adult, and firearms outright.
  assumption: Set this authority to expire in 30 days.

3. Register an agent, and create + authenticate a mandate for it
  mandate: mdt_01m2rnka6g0c8acmtq2ka9e3wv (PENDING_AUTHENTICATION)
  authenticated -- the mandate is now ACTIVE
  agent key minted: wsf_live_a463ba08...  (shown once -- store it now)

4. Ask permission for a purchase that's clearly within the mandate
  decision: ALLOW  status: AUTHORIZED
    - ALLOW_WITHIN_MANDATE: The action is within the delegated authority.
```

Same run, same mandate, a purchase over the hard cap:

```
7. A purchase over the hard cap -- DENY. This is a normal return value, not a thrown error
  decision: DENY  status: DENIED
    - DENY_TRANSACTION_LIMIT_EXCEEDED: The amount exceeds the per-transaction maximum of $150.00.
  asExecutable() on a DENY: null
```

Sections 5–6 and 8–10 of the same run (execution, a step-up resolved by a
real approver mandate after a rejected self-approval attempt (D-62), a typed
SDK error, and independently verifying the signed evidence chain) are elided
here for length — run `npm run quickstart` yourself, or read
`examples/quickstart.ts` directly. Same commands and output as
[waysafe.ai/docs](https://waysafe.ai/docs).

## The nine non-negotiables

The clearest statement of what this actually is. Full text and the reasoning
behind each is in [`CLAUDE.md`](CLAUDE.md); condensed:

1. **A model never authorizes a transaction.** An LLM appears in exactly one
   place — the intent compiler, turning natural language into a *proposed*
   policy. Everything downstream of a frozen policy is deterministic code.
2. **Money is integer minor units.** `$150` is `15000`. No floats, no
   decimal strings, ever.
3. **An unverified merchant can never produce ALLOW.** Trust comes from *who*
   attested an identifier — a rail's own callback, or Waysafe's own directory
   lookup — never merely which field it's in. An agent's own assertion caps
   at `STEP_UP`, whatever field it's typed into.
4. **No credential ever reaches a model prompt, a log, or a trace.**
5. **Mandates are immutable versions.** Edits write a new version and
   supersede the old one; every decision cites the exact `mandateVersionId`
   and `policyHash` it was decided against.
6. **Cumulative spend is a SUM over the ledger, never a counter column.**
   Concurrent authorizations serialize on a real row lock.
7. **Reason codes are a public API.** Additive only, never renamed.
8. **The compiler asks rather than inventing a limit.** `needs_clarification`
   is a valid outcome at HTTP 200. A spending ceiling the principal didn't
   state is never defaulted.
9. **An agent's cooperation is never a control.** Enforcement is
   rail-initiated — the rail asks Waysafe before funds move, and the agent
   never has to. Anything that depends on the agent calling `authorize()`
   first is a *preflight*, never the thing that actually stops money moving.

## What's built and what isn't

**Real, and exercised against live test-mode/testnet infrastructure, not
just unit-tested:**

- The policy engine (`packages/core/src/engine/evaluate.ts`) — amount,
  merchant identity, category, time window, velocity, and step-up rules, all
  enforced against a proposed action. See
  [waysafe.ai/docs](https://waysafe.ai/docs)'s Policy Schema Reference for
  exactly which fields the engine enforces today versus which are
  specified-but-unbuilt or absent entirely.
- The evidence chain — append-only, hash-chained, Ed25519-signed, with a
  published key directory so a rotation doesn't invalidate historical
  signatures (D-53), and independently verifiable with nothing but
  `node:crypto` and a pinned public key.
- Stripe Issuing enforcement — a card's real-time authorization webhook asks
  Waysafe before the network approves a charge, in test mode.
- The x402 / Safe co-signer — a genuine on-chain 2-of-2 multisig on Polygon
  Amoy. The three bypass cases (a stolen session key alone, a forged
  co-signature, a genuine signature redirected to a different payment) are
  broadcast to the real network and reverted on-chain, not simulated — see
  [waysafe.ai/proof](https://waysafe.ai/proof) for the actual transaction
  hashes.
- Approver mandates (D-62) — resolving a step-up runs the real `evaluate()`
  engine a second time, against a *different*, named approver mandate's own
  policy. Closes a real, previously-open gap (D-59): an agent credential
  could resolve its own step-up before this shipped. See
  [waysafe.ai/docs](https://waysafe.ai/docs)'s Policy Schema Reference for
  the full mechanics.

**Not built — specified or discussed, never shipped:**

- **A KMS- or HSM-backed signer.** Every private key in this codebase today
  is loaded from an environment variable into plain process memory
  ("EnvSigner") — no hardware or service boundary between a process
  compromise and a key compromise. See `docs/THREAT-MODEL.md` §5.
- **External anchoring on the evidence chain.** Verifying a chain proves
  Waysafe signed the record and nothing was altered after the fact. It does
  not prove completeness — that nothing happened outside what you were
  shown. Closing that gap needs an anchor outside Waysafe's own database (a
  public ledger, a certificate-transparency-style log); none exists. See
  `docs/THREAT-MODEL.md` §3.
- **A `Signer` interface.** Nothing in this codebase defines or calls
  through an abstraction over "produce a signature" — every signing call
  takes a raw key object directly. A prerequisite for the KMS item above,
  also unbuilt.

## Links

- [waysafe.ai](https://waysafe.ai) — the public site
- [waysafe.ai/docs](https://waysafe.ai/docs) — SDK reference, a real
  60-second quickstart, and the full Policy Schema Reference
- [waysafe.ai/proof](https://waysafe.ai/proof) — one real captured run:
  signed evidence chain, Stripe Issuing decisions, and three real on-chain
  bypass rejections, with transaction hashes a third party can check
  independently
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — key inventory and blast
  radius, what five compromise scenarios actually yield, what the evidence
  chain does and doesn't prove, and known open gaps, written for a security
  reviewer
- [`DECISIONS.md`](DECISIONS.md) — every decision made building this and
  every open question still outstanding, with the reasoning behind each —
  including the ones that turned out wrong and were corrected in a later
  entry rather than silently edited away. This is the first thing to read
  before changing anything.

## Layout

```
packages/core     domain model, policy schema, reason codes, merchant identity, intent compiler
packages/db       Prisma schema (Postgres)
packages/sdk      TypeScript SDK — the developer contract
apps/api          Fastify REST API, payment adapters, evidence chain
apps/dashboard    developer dashboard (Next.js)
apps/site         the public marketing site (waysafe.ai)
examples/         runnable quickstart and demo scripts — clone and run, not prose
docs/             THREAT-MODEL.md and other reference docs checked into the repo
```

## Security

See [`SECURITY.md`](SECURITY.md) for the disclosure policy and known open
issues.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
