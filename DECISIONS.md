# Decisions

Every default taken while building Week 1, and why. Each is cheap to change now
and expensive to change later, which is the point of writing them down.

Format: **D-n** is a decision already implemented. **OQ-n** is an open question
that needs a human answer.

---

## D-1 — Tenancy: Organization is the boundary

The PRD names eight objects and never says who owns them.

```
Organization  (a developer account)
  ├── Agent        many
  ├── Principal    many
  └── Mandate      binds ONE principal to ONE OR MORE agents
```

Every table carries `organizationId` and nothing is queried without it. An Agent
can serve many Principals, but only through a mandate that names it — there is
no ambient authority anywhere in the system.

Implemented in `packages/db/prisma/schema.prisma` and `packages/core/src/domain.ts`.

**Change cost if wrong:** high. This is the one to review first.

---

## D-2 — Money is always integer minor units

`$687.00` is `68700`. `$6.87` is `687`. Never a float, never a decimal string.

The PRD's §5 example (`"amount": 687`) is ambiguous between those two, and that
ambiguity becomes a real bug the first time someone integrates. The schema now
rejects decimals outright with an explanatory error.

MVP is USD-only; `Currency` is an enum so adding one is a one-line change plus a
minor-unit exponent.

Implemented in `packages/core/src/money.ts`.

---

## D-3 — A merchant that cannot be verified can never produce ALLOW

**This is the most important decision in Week 1.**

The PRD's demo turns on "Staples is approved, Best Buy is not." If `merchant` is
a free-text string the agent supplies, the allowlist is decorative: a
compromised or merely sloppy agent types `"Staples"` and gets paid. The policy
engine would be theater.

So merchant references carry an explicit **scheme** and resolution produces an
explicit **trust level**:

| Scheme | Can satisfy an allowlist? | Notes |
|---|---|---|
| `psp_account` | yes, VERIFIED | strongest — the money actually goes there |
| `network_mid` | yes | acquirer-assigned |
| `domain` | yes, VERIFIED if in the merchant directory | primary scheme for MVP |
| `mcc` | no | a category, not an identity |
| `name` | **no** | free text; never sufficient alone |

An agent asserting only a name, or a domain we cannot corroborate, degrades the
best possible outcome to `STEP_UP` — a human confirms who the counterparty is.
Denylists work the other way: a mere *claim* of a blocked merchant is
disqualifying, no verification needed.

Lookalike domains (`staples.com.checkout-secure.io`) do not match; subdomains
(`shop.staples.com`) do. Both are tested.

The MVP ships a small static merchant directory so the demo has verified
merchants without a data pipeline. Week 4 replaces the `psp_account` path with
real Stripe lookups.

Implemented in `packages/core/src/merchant.ts`, tested in `merchant.test.ts`
(see the two tests named "THE ATTACK").

### Amendment (Week 2) — the unverified cap is a ceiling, not a replacement

The first engine implementation applied the unverified-merchant rule by
*short-circuiting* `merchants.unlisted` entirely: if trust wasn't VERIFIED, it
emitted `STEP_UP_MERCHANT_UNVERIFIED` and never consulted `unlisted` at all.
That's wrong the moment `unlisted` is `DENY` — an unverified merchant against
a policy that says "deny anything I haven't named" came back `STEP_UP`, which
is *more* permissive than the principal asked for. Caught in review; every
existing test happened to use `unlisted: "ALLOW"`, so nothing exercised the
DENY/STEP_UP rows.

The rule is now: evaluate `unlisted` unconditionally first, then apply the
unverified state as a ceiling that can only push the outcome *up* toward
DENY, never down past what `unlisted` already decided.

| Merchant trust | `unlisted` | Result |
|---|---|---|
| unverified | `DENY` | `DENY` |
| unverified | `STEP_UP` | `STEP_UP` |
| unverified | `ALLOW` | `STEP_UP` (the D-3 cap — the one row where the cap does something) |
| VERIFIED | any | whatever `unlisted` says |

Implemented in `packages/core/src/engine/evaluate.ts` (`evaluateMerchant`),
tested in `engine/evaluate.test.ts` under "D-3 ceiling: unverified trust vs.
the unlisted disposition" (all four rows, plus the VERIFIED row for each
disposition).

---

## D-4 — Budget accounting is explicit and stamped on every receipt

"$500 per month" does not say against what. The policy now carries an
`accounting` block, and these are the defaults:

| Field | Default | Why |
|---|---|---|
| `basis` | `authorization` | conservative; agents can fire many actions in the seconds before a settlement lands |
| `reserve_on_step_up` | `true` | a pending approval holds budget, so ten pending $90 requests cannot all clear against a $500 cap |
| `refunds_credit_budget` | `true` | matches how people think about a monthly budget |
| `timezone` | `America/New_York` | calendar windows need a timezone; set per policy |

Cumulative spend is the **SUM over an append-only ledger table**, never a
counter column. Authorization takes a row lock on the mandate to serialize limit
checks, so two agents authorizing simultaneously cannot both pass a check the
pair of them would fail. Window keys (`dayKey`, `weekKey`, `monthKey`) are
precomputed at write time in the policy's timezone.

Schema is in place; the ledger is written in Week 2 alongside the engine.

---

## D-5 — Mandates are immutable versions

A `Mandate` is a stable handle; its content lives in `MandateVersion` rows that
are never updated after creation, except to stamp authentication. Editing a
mandate writes a new version and supersedes the old one.

Every `Authorization` cites `mandateVersionId` **and** denormalizes
`policyHash`, so a receipt can prove the exact bytes that authorized a payment
even after the principal changes their mind. In-flight authorizations continue
against the version they started on.

`policyHash` is SHA-256 over a canonical serialization (keys sorted recursively,
`undefined` dropped), so two semantically identical policies hash identically.

---

## D-6 — The compiler asks instead of inventing limits

The PRD's §6 compiler always produces a policy. In practice many instructions do
not contain an enforceable limit at all ("let my agent buy things from Amazon"),
and inventing one is a guess about someone's money that they never see.

The compiler therefore has a third outcome, `needs_clarification`, returned as
**200** — asking is a valid result, not an error. It asks only when a *material*
control is undefined: no ceiling of any kind, named merchants with no stated
disposition for unnamed ones, or an internally contradictory instruction. Expiry
and timezone are safely defaulted.

Everything the compiler chose that the principal did not say goes in
`assumptions`, in plain language, e.g.

> Read 'nothing ridiculous' as at most $900 per booking and $1,800 in total.
> Change these if they are not what you meant.

---

## D-7 — Confirmation before authentication is mandatory

The PRD says the compiled policy is "shown to/authenticated by the principal
where appropriate." For the MVP it is always. `POST /v1/mandates/compile`
deliberately does **not** create a mandate; it returns a proposal plus a
`confirmation` object rendering the policy as a human-readable bullet list.
Week 3 wires the passkey signature over `policy_hash`.

---

## D-8 — Model output is validated, never repaired

The compiler parses the model's JSON, schema-validates it, and coherence-checks
it. On failure it feeds the errors back and retries **once**. If it still does
not validate, compilation fails.

The compiler never patches up a policy itself. A silently corrected financial
limit is worse than no mandate at all.

---

## D-9 — Fulfillment claims are labeled as claims

PRD §9 wants the receipt to prove the agent met the economic obligation
("refundable", "nonstop"). In the MVP there is no data source for that other
than the agent itself.

So obligations compile to `constraints` with
`verification: "agent_attested"`, the confirmation screen says
"agent-reported, not independently verified", and the receipt will record a
claim rather than a fact. When Week 4's Stripe data or a merchant feed can
corroborate something, that constraint upgrades to `provider_verified`.

Scoping this honestly now avoids shipping a receipt that implies verification we
cannot perform.

---

## D-10 — High-risk categories are denied unless explicitly permitted

`gambling`, `cash_advance`, `crypto`, `adult`, `firearms` compile to
`categories.deny` unless the instruction permits them, and the compiler says so
in its assumptions. This is what makes the PRD's demo case — a $50 charge at an
unapproved gambling merchant — a `DENY` rather than a `STEP_UP`.

Precedence is `DENY` > `STEP_UP` > `ALLOW`: any deny rule wins.

---

## D-11 — Reason codes are a public API surface

Defined in Week 1 because Week 2's exit criteria depends on them. Additive-only,
never renamed. SDK consumers and the dashboard branch on the code; the prose
description is for display and can change freely.

Published at `GET /v1/reason-codes`. See
`packages/core/src/reason-codes.ts`.

---

## D-12 — Test fixtures replay recorded compiler output

Compiler tests use `FixtureIntentCompiler`, which replays real model output
recorded in `fixtures/compiler/*.json`. It is deliberately not a hand-rolled
parser — a test that passes because a regex agreed with itself would tell us
nothing. The fixtures still exercise the full validation, coherence-check and
assumption-surfacing path, offline and deterministically.

Re-record with `npm run compile:record -w @agentpay/api -- <name> "<instruction>"`.

---

## D-14 — `deny_mcc` fires on an agent-claimed MCC, same as a denylist claim

`resolveMerchant` sets `resolved.mcc` to `assertion.mcc` first and only falls
back to the merchant directory's MCC when the agent didn't supply one
(`mcc = mcc ?? entry.mcc`). An engine comment once claimed `deny_mcc` was
checked against an MCC that was "directory- or PSP-sourced, never the agent's
claim" — that was simply false: an agent-supplied MCC reaches `deny_mcc`
exactly like a directory-sourced one. Caught in review.

The behavior is kept, not changed: `deny_mcc` treats an agent's MCC claim as
disqualifying on its own, the same way `matchesDenylist` treats a claimed
merchant name as disqualifying without verification (D-3) — a bad actor
claiming a blocked category doesn't get the benefit of the doubt just because
nothing corroborated the claim.

What changes is provenance. `ResolvedMerchant` gains `mcc_source: "psp" |
"directory" | "assertion"`, recorded alongside `mcc` in `resolveMerchant`, and
`evaluateCategory`'s `DENY_CATEGORY_BLOCKED` reason for a `deny_mcc` match
includes it in `detail`. A receipt can now show whether a blocked MCC was
corroborated or just claimed by the agent, even though both deny.

Implemented in `packages/core/src/merchant.ts` (`resolveMerchant`,
`ResolvedMerchant.mcc_source`) and `packages/core/src/engine/evaluate.ts`
(`evaluateCategory`). Tested in `engine/evaluate.test.ts` under "category
rules" (`mcc_source: "directory"` vs. `mcc_source: "assertion"`).

---

## D-15 — The row lock gets a second, real-Postgres proof

D-4 requires that two concurrent authorizations against the same mandate
serialize, so a $450 and a $60 request that each pass alone against a $500
cap can't both commit when together they'd hit $510.
`InMemoryAuthorizationRepository`'s lock is a genuine FIFO async mutex (a
chain of promises, not a flag), and its concurrency tests
(`apps/api/src/authorization/service.test.ts`) prove the *service's* locking
logic — the order it reads the spend snapshot and writes the ledger — is
correct. What it can't prove is that Postgres itself serializes two separate
connections the same way a single Node process serializes two promises.

`PrismaAuthorizationRepository`
(`apps/api/src/authorization/prisma-repository.ts`) closes that gap with a
real `SELECT ... FOR UPDATE` inside a transaction. The subtlety: the caller
of `withMandateLock` (`authorize()` in `service.ts`) runs `getSpendSnapshot`
and `saveAuthorization` as nested calls on `this` *inside* the locked
callback — if those nested calls opened their own connections instead of
reusing the locked transaction, the lock would be held but do nothing, since
the read and write it's meant to serialize would happen outside it. So every
method reads from `this.client`, which resolves to the active transaction
(stashed in an `AsyncLocalStorage` for the duration of the callback) when
called from inside a lock, and to the plain `PrismaClient` otherwise.

`prisma-repository.test.ts` re-runs the same two concurrency scenarios from
`service.test.ts` against `PrismaAuthorizationRepository` and a real
database.

**Negative control, not a one-off manual check.** A race test that passes
proves little on its own — it may just mean the two operations never
overlapped that run, and it would keep passing even if someone later deleted
the `FOR UPDATE` line. `PrismaAuthorizationRepository` therefore takes a
constructor option, `disableLockForTesting`, that skips only the `FOR UPDATE`
line — same transaction, same `AsyncLocalStorage` wiring, one variable
changed. A permanent test in `prisma-repository.test.ts` ("negative control:
WITHOUT the row lock...") constructs the repository with that option and
asserts the race test's failure mode directly: both the $450 and the $60
request land `ALLOW`, $510 against a $500 cap. That test failing would mean
the positive test above isn't proving what it claims to. (This was first
verified by hand — temporarily replacing the lock body with a bare `fn()` and
watching the race test go red — before being made a permanent, committed
test rather than a one-time manual check.)

**Fail loud, don't fail quiet.** `describe.skipIf` skips the whole block —
tests included — when `DATABASE_URL` is unset or unreachable, so `npm test`
stays green with no database configured at all. Left unconditional, that's a
hazard the other direction: a broken `DATABASE_URL` in an environment that's
*supposed* to have a database (CI, staging) makes the single test suite that
exists to catch a money-losing race silently vanish, and everything else
stays green regardless. Setting `AGENTPAY_REQUIRE_DB=1` turns that case into
a hard failure — one test throws with a message naming the flag and the
fix, instead of the block quietly disappearing. Default (unset) behavior is
unchanged: skip and stay green.

Implemented in `apps/api/src/authorization/prisma-repository.ts`
(`PrismaAuthorizationRepositoryOptions.disableLockForTesting`). Tested in
`apps/api/src/authorization/prisma-repository.test.ts`.

---

## D-16 — The evidence chain gets its own lock, independent of D-4's

The hash chain (`EvidenceEvent.sequence`/`previousHash`) is scoped per
*organization*, not per mandate. D-4's row lock is scoped per *mandate*. Two
authorizations against two different mandates in the same organization can
run concurrently under D-4's lock — each has its own mandate row to lock —
but both would still be appending to the *same* evidence chain. Without a
lock of its own, two such appends can race on "what's the next sequence
number / what's the current tip hash" exactly the way two authorizations
would race on cumulative spend without D-4's lock.

So `EvidenceRepository` gets its own `withOrganizationLock`, a real
`SELECT ... FOR UPDATE` on the `organizations` row in the Prisma
implementation, structurally identical to `withMandateLock` (same
`AsyncLocalStorage`-routing trick so nested reads/writes inside the callback
share the locked transaction, same `disableLockForTesting` negative control,
same `AGENTPAY_REQUIRE_DB` fail-loud gate). Where a call site needs both
locks in one transaction (an authorization decision writing its own
evidence event), the convention is: acquire the organization lock before the
mandate lock, consistently, so two call sites can never deadlock by taking
them in opposite orders.

`Mutex` (the in-memory lock's building block) was previously private to
`InMemoryAuthorizationRepository`; it's now `apps/api/src/util/mutex.ts`,
shared with `InMemoryEvidenceRepository`, since there are now two real
callers instead of one.

Implemented in `apps/api/src/evidence/prisma-repository.ts`
(`withOrganizationLock`) and `apps/api/src/evidence/in-memory-repository.ts`.
Tested in `apps/api/src/evidence/prisma-repository.test.ts`, including the
negative control (race passes with the lock disabled) and the
`AGENTPAY_REQUIRE_DB` hard-failure test, both following the D-15 pattern
exactly. The reachability probe and the `AGENTPAY_REQUIRE_DB` gate itself
were pulled out to `apps/api/src/test-support/db-gate.ts` and both
`prisma-repository.test.ts` files now share it, rather than let two copies
of a security-relevant test mechanism drift apart.

---

## D-17 — Evidence is "tamper-evident," never "tamper-proof" or "verifiable," until OQ-8 lands

A hash chain proves a *record was mutated after the fact to someone who
already has an independent copy of it, or who trusts the person recomputing
the chain*. It does not prove anything to a third party who has to trust the
operator's own database to fetch the chain from in the first place —
whoever controls the database can mutate a row and recompute every hash
after it, chain intact. That's the gap OQ-8 exists to close with signing.

Until it's closed, no receipt, API response, SDK type, or demo copy may
describe the evidence log as "verifiable" or "tamper-proof" in a way that
implies a third party can check it without trusting us — that would be the
same class of defect as D-14: a security property claimed in words that the
code does not actually provide. "Tamper-evident" is the accurate word for
what hash-chaining alone gives you, and it's the only word to use for it
until OQ-8 resolves.

Applies to: `packages/core/src/evidence.ts` doc comments,
`verifyEvidenceChain`'s naming and description, any future receipt-rendering
code, and `packages/sdk` types once evidence is exposed there.

---

## D-18 — Agent API keys: the key is the source of truth for agent identity, and rejection is a decision, not a 401

A key is `ap_live_` + an 8-hex-char lookup prefix + a high-entropy secret
tail (`apps/api/src/agent-keys/keys.ts`), matching the example already in
`schema.prisma`'s `ApiKey.prefix` comment. Only the prefix and a SHA-256
hash of the full key are stored; the full key is generated once, returned to
the caller, and never persisted or logged. Verification treats "right
prefix, wrong secret" and "prefix not found" identically (`not_found`) --
the prefix isn't a secret, but nothing about *why* a key failed should be
observable beyond that distinction and `revoked`.

**The key, not `request.agent_id`, is what proves which agent is acting.**
An agent asserting its own `agent_id` in a request body is exactly the kind
of unverified claim D-3 already teaches us not to trust for merchants --
the same logic applies to the agent identity itself. So `authorize()`
verifies the presented key independently, and requires the key's own
`agentId`/`organizationId` to *agree* with what the request claims; a
mismatch is rejected even though both pieces individually "exist." The
request's `agent_id` still has a job -- it's the lookup hint
`resolveMandateGate` uses to find a candidate mandate to attach a DENY to --
but it grants no authority on its own.

**The refusal is a recorded authorization decision, not an HTTP-layer
401.** A missing, forged, or revoked key is checked inside `authorize()`
itself, before `resolveMandateGate`'s other checks are trusted and before
`evaluate()` is reachable at all, and it persists an ordinary `DENY` with a
reason code like any other outcome (once a mandate exists to attach it to;
with no mandate at all there's nothing to persist, same as any other
`no_mandate` case). This matters for D-18 as much as it does for I-10
(modular developer experience): when the HTTP endpoint for this eventually
gets built, it must forward the caller's presented credential into
`authorize()`'s `apiKey` parameter rather than authenticating it itself and
short-circuiting with a bare 401 -- otherwise a rejected agent gets no
reason code, no EvidenceEvent, and no receipt, and a developer building
their own approval UI on reason codes (I-10) has a blind spot exactly where
they'd need one least.

**Reuses existing reason codes rather than adding new ones.** Every
credential-shaped failure -- missing, forged, revoked, or a key that
doesn't belong to the claimed agent/organization -- maps to
`DENY_AGENT_NOT_BOUND`: the request cannot prove it's from the agent it
claims to be, which is exactly what that code already means.
`DENY_AGENT_SUSPENDED` stays the mandate gate's existing job, checked
afterward and unchanged -- an agent's suspended *status* is orthogonal to
whether the specific key presented is valid.

**No lock.** Unlike the mandate ledger (D-4) and the evidence chain (D-16),
key verification isn't racing anything cumulative -- a key being revoked
mid-flight of a concurrent request is an ordinary auth-staleness window
every bearer-token system has, not a double-spend risk. Deliberately not
given the `disableLockForTesting`/negative-control treatment those two got,
because there's no lock to have a negative control for.

**Every key check writes an EvidenceEvent** (success or failure), under the
organization's chain, regardless of whether a mandate was ultimately found
-- `type: "agent_key.verified"` or `"agent_key.rejected"`, `subject_type:
"agent"`, payload carries the key's prefix (never the secret) and the
specific outcome (`not_found` / `revoked` / `org_mismatch` /
`agent_mismatch`).

**Tested not-bypassable, not just tested-DENY.** Beyond asserting the DENY
outcome for a revoked/forged/mismatched key
(`apps/api/src/authorization/service.test.ts`, "agent API keys (D-18)"),
one test spies on `@agentpay/core`'s `evaluate` and asserts it is never
called when the key check fails on an otherwise-fully-valid request --
paired with a sanity-check test proving the same spy *is* triggered once
when the key is valid, so the negative result isn't just the spy silently
failing to attach.

Implemented in `apps/api/src/agent-keys/` (`keys.ts`, `types.ts`,
`in-memory-repository.ts`, `prisma-repository.ts`) and
`apps/api/src/authorization/service.ts` (`verifyAgentKey`). Tested in
`apps/api/src/agent-keys/*.test.ts` and
`apps/api/src/authorization/service.test.ts`.

---

# Open questions

## OQ-1 — The demo script contradicts the demo instruction

PRD §11 gives the instruction as:

> "**Never** spend more than $150 in a single transaction."

and then shows:

> Staples — $203 → **STEP_UP**

"Never" is a hard ceiling; $203 should be `DENY`. To get `STEP_UP` the
instruction needs to be "**Ask me before** spending more than $150."

Both are shipped as fixtures — `procurement-demo` (asks, matches the demo
script) and `procurement-strict` (never, denies) — so you can see the difference
and pick. **Which one is the demo?** This is a product question about how
literally AgentPay reads the principal's words, and the answer shapes the whole
compiler's posture.

## OQ-2 — Name collision with Mastercard Agent Pay

Mastercard Agent Pay is a real product, cited in your own §2. "AgentPay Router"
is going to be a problem the moment this is public — trademark, SEO, and the
awkwardness of pitching partners a name they already use. Worth resolving before
the SDK package name and domain are locked, since both are hard to change after
a single external developer integrates.

## OQ-3 — Who is the first external developer?

§18 defines success as "an external developer can…". Having one named changes
what the SDK looks like — whether `authorize()` is called from a LangGraph node,
an MCP server, or a cron job is a different ergonomics problem each time.

## OQ-4 — Dashboard authentication

The PRD specifies WebAuthn for *principals* authenticating mandates, but says
nothing about how a developer logs into the dashboard. Options: build it,
Clerk, WorkOS, or Auth.js. Needs an answer before Week 5.

## OQ-5 — WebAuthn RP ID

Passkeys are bound to a domain. Registering against `localhost` and later moving
to a real domain invalidates every credential. Picking the production domain
early — even before it is live — avoids a re-registration migration in Week 3.

## OQ-6 — Runtime target

Vercel is in the PRD's stack. The policy engine wants row locks, a long-lived
Postgres pool, and a background worker for step-up expiry, none of which suit
serverless well. The dashboard on Vercel plus the API on a container host
(Railway, Render, Fly) is the lower-friction split. Not blocking until Week 4.

## OQ-7 — The §6 example policy is internally contradictory

The Intent Compiler example in PRD §6 outputs:

```
max_transaction = $900
step_up_above   = $1,250
```

A step-up threshold above the per-transaction ceiling can never fire — anything
at $1,250 is already denied at $900. The coherence checker flags this
automatically, and you can see it by running:

```bash
npm run compile -w @agentpay/api -- "Get me a good hotel in Miami. Nothing ridiculous."
```

The `shopping` fixture deliberately keeps the PRD's numbers so the warning is
visible. Presumably `max_transaction` was meant as a per-*night* cap and
`max_total` as the booking ceiling, in which case the policy needs a per-night
dimension it currently does not have — lodging is priced per night but charged
as one transaction. **Does the policy schema need per-unit limits, or should the
example's numbers just be corrected?**

## OQ-8 — The evidence chain is tamper-evident, not tamper-proof, until it's signed

Hash-chaining (D-16) makes the evidence log tamper-*evident*: mutate a
historical row and recomputing the chain shows exactly where it breaks. It
does not make the log tamper-*proof* or independently *verifiable* — both of
those require someone who does not have to trust AgentPay's own database to
be able to check the record, and hash-chaining alone can't give them that.
Whoever controls the database can mutate a row and recompute every hash
after it; the chain stays internally consistent throughout. Tamper-evident
protects against an outside attacker or a bug; it does not protect against
the operator, and it does not let a principal, a regulator, or a counterparty
verify a receipt without trusting AgentPay to have run the check honestly.

Signing each event (or periodically signing the chain's tip) with the
Ed25519 key already wired into `.env.example` as
`AGENTPAY_EVIDENCE_SIGNING_KEY` is what closes that gap — a signature a third
party can check against a published public key, independent of whether they
trust the database it came from. That is load-bearing for how AgentPay
positions itself (an authorization record a principal or auditor can trust
without trusting AgentPay's operators), not a nice-to-have hardening pass.

Deliberately not built in Week 3: hash-chaining alone already satisfies
Week 3's stated scope (append-only, tamper-evident, a verification function
that detects mutation), and signing is additive on top of it rather than a
rework — the chain structure doesn't change when signing is added, only a
signature gets attached to each tip. Until it lands, see D-17: nothing may
describe the evidence log as "verifiable" or "tamper-proof" in the
third-party sense. **Targeted for Week 6 hardening — does the signing scheme
sign every event, or just periodically sign the chain's tip, and who holds
the verification public key?**
