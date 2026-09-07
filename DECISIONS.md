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

### Amendment (Week 6) — the cap's own reason is no longer suppressed when `unlisted` also fired

The ceiling table above was always about the *decision*, and that part was
right. The *reasons* implementation was stricter than it needed to be:
`STEP_UP_MERCHANT_UNVERIFIED` only got attached when `unlisted` contributed
nothing (`reasons.length === 0`) -- so the unverified + `unlisted: STEP_UP`
row produced a decision of `STEP_UP` with only
`STEP_UP_MERCHANT_NOT_ALLOWLISTED` on the receipt, silently dropping the
fact that the merchant's identity couldn't be verified at all. Caught
building the Week 6 demo: its merchant-spoofing attempt (a bare `name`
assertion) is exactly this row, and the receipt didn't say the one thing
that actually mattered most for a human deciding whether to approve it.

Both facts are independently true about the same merchant and both now
attach, in evaluation order (`unlisted`'s reason first, the cap's second) --
removing the `reasons.length === 0` gate was the entire fix. This changes
`evaluateMerchant`'s internal output for exactly one row of the ceiling
matrix (unverified + `unlisted: STEP_UP`); every other row is unaffected,
including the DENY row, where `evaluate()`'s own DENY > STEP_UP precedence
already drops every STEP_UP-tier reason from the final result regardless of
how many `evaluateMerchant` produced internally.

Tested in `engine/evaluate.test.ts`: the ceiling matrix's own "unverified +
unlisted STEP_UP" row now asserts both codes, in order, and two "adversarial
merchant assertions" tests (name-only, lookalike domain) were updated the
same way; the other five ceiling-matrix rows pass unchanged.

### Amendment (Week 6) — reason messages format money, `detail` and the wire never do

Separately, every reason message with a minor-unit amount in it (per-
transaction and cumulative limits, both step-up thresholds) was interpolating
the raw integer -- "the per-transaction maximum of 15000" instead of
"$150.00". Also caught building the demo, whose own narration otherwise
formats every dollar amount consistently. `detail` and every value on the
wire are untouched (still raw minor units, per D-2) -- only the
human-readable `message` string now runs through `formatMoney`.
`DENY_VELOCITY_LIMIT_EXCEEDED`'s transaction-count message is deliberately
excluded: a count is not money and was never meant to be formatted as
currency. Tested in `engine/evaluate.test.ts` under "reason messages format
money, never bare minor units," including a sweep asserting the raw
minor-unit integer never appears literally in any money-bearing message.

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

Re-record with `npm run compile:record -w @waysafe/api -- <name> "<instruction>"`.

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

**OQ-8 landed in Week 6 (D-26): the chain is signed, and it is now accurate
to call it "verifiable" -- by a third party, not just tamper-evident to an
operator.** Left in place, unedited below, so the original reasoning
survives; this restriction genuinely held for Weeks 3 through 5.

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

## D-19 — The product is renamed from "AgentPay Router" to "Bles"

**Superseded by D-28: "Bles" did not clear trademark search and was
renamed again, to "Waysafe."** Left in place, unedited below, so the
original reasoning survives.

Resolves OQ-2. Mastercard Agent Pay already owns "Agent Pay" as a category
name, and the collision was only going to get more expensive to unwind the
longer the name stuck around in code, package scopes, and a growing surface
of external-facing strings.

The positioning is deliberately not payments: Bles is the system of record
for delegated financial authority. The category being built around here is
permission issuance -- deciding, recording, and proving what an agent was
allowed to do -- not moving money. Nobody else is building liability
resolution for agentic spend; that is the position Bles occupies, and it is
a different pitch than "another way to route a payment."

**The rename is a mechanical pass, deliberately deferred to Week 6, before
anything is public:**

- Repo name
- Package scope: `@agentpay/*` → the new scope
- Env vars: `AGENTPAY_*`
- The policy schema id: `agentpay.policy/v1`
- `README.md`, SDK naming, any other AgentPay-branded string

Mid-sprint, this is pure churn with no compensating benefit -- every week
between now and Week 6 that isn't spent on it is a week spent on the thing
the name is attached to. After a first external integration, it's expensive
in a different way: someone else's code now depends on the old names. Week 6
is the window between "nothing to break" and "something to break."

**The schema id is the one entry on this list with a real compatibility
cost, not just a search-and-replace.** `POLICY_SCHEMA_VERSION` /
`agentpay.policy/v1` is baked into every policy document, and every
`policy_hash` (D-5) is a SHA-256 over the canonical bytes of that exact
document -- change the string and every previously-computed hash stops
matching a freshly-canonicalized policy with otherwise-identical content.
Week 6 needs to decide: bump to a new versioned id (`bles.policy/v1`) and
carry a translation for hashes computed under the old one, or alias the old
id as a recognized-but-deprecated schema version indefinitely. Not decided
here -- flagging it now so Week 6 doesn't discover it as a surprise.

Not implemented yet -- this decision records the rename and its timing, not
the rename itself.

---

## D-20 — WebAuthn: the challenge is the policy_hash, RP ID is localhost for the sprint

**Resolves OQ-5.** RP ID is `localhost` for the whole sprint. Every
credential registered during development is disposable -- passkeys are
bound to a domain, so moving to the real one at launch invalidates them
regardless of when that move happens. Doing it now, mid-sprint, buys
nothing; the migration is the same size whenever it happens, and OQ-2's
answer (the product is now Bles, D-19) means the real domain wasn't even
known until this decision was already due. Re-register against the real
domain once D-19's rename lands.

**The authentication challenge is `policyHash`'s UTF-8 bytes,
base64url-encoded (`webauthn.ts`'s `policyHashToChallenge`) -- not a random
server nonce.** This is the load-bearing design choice, not a detail: a
random nonce proves the principal completed *a* WebAuthn ceremony recently
(closer to a login). Encoding the policy hash itself as the challenge means
a verified signature proves the principal's authenticator signed *this
exact mandate version* -- the same property a "sign this transaction"
flow gets from putting the transaction hash in the signed payload. A
signature that verifies against the wrong policy_hash (a real signature,
genuinely produced by the registered key, just over a different mandate)
is rejected by `@simplewebauthn/server`'s own challenge check, not by
anything this codebase added -- confirmed in
`webauthn/webauthn.test.ts` and, end to end through challenge
storage and mandate lookup, in `webauthn/service.test.ts`.

**A `MandateVersion` reaches `authenticatedAt` / `Mandate.ACTIVE` through
exactly one path.** `AuthorizationRepository.activateMandate` stamps both;
its only caller is `webauthn/service.ts`'s `completeMandateAuthentication`,
and only after `verifyAuthentication` has returned `ok: true` -- there is no
branch, no default, no fallback that reaches it otherwise. Proven directly:
a test spies on `activateMandate` and asserts it is never called when
verification fails (missing challenge, wrong policy_hash, forged signature)
and is called exactly once when it succeeds -- the same
spy-plus-sanity-check pattern D-18 used for `evaluate()`. A second test
runs the full lifecycle end to end: a `PENDING_AUTHENTICATION` mandate
returns `DENY_MANDATE_NOT_AUTHENTICATED` from `authorize()` (the gate
D-13 already had, now exercised against a mandate nothing has fabricated
`authenticatedAt` for), a real WebAuthn ceremony activates it, and the
identical request now reaches `evaluate()`.

**Challenges are single-use by construction, not by convention.**
`WebauthnChallenge.consumedAt IS NULL AND expiresAt > now` is the `WHERE`
clause of one atomic conditional update (`consumeChallenge`), the same
pattern the idempotency-key claim in `InMemoryAuthorizationRepository`
already used -- there is no read-then-write gap for a race to land in.
5-minute expiry. Proven with a genuine replay (the identical, validly
signed response submitted twice: second attempt rejected because the
challenge row is already consumed, not because the signature stopped being
valid) and, in `webauthn/prisma-repository.test.ts`, ten concurrent
redemption attempts against real Postgres resolving to exactly one success
— no row lock needed here (contrast D-4/D-16): a single row's own
consumed/not-consumed state is already atomic under one conditional
`UPDATE`, with nothing cumulative to serialize.

**Tested against the real verifier, not a fake.** `@simplewebauthn/server`
does the actual signature and CBOR/authenticator-data parsing;
`webauthn/test-support/virtual-authenticator.ts` is a real (if synthetic)
ECDSA P-256 authenticator -- genuine keypair, genuine CBOR attestation
object, genuine DER signature -- built from the library's own
`isoCBOR`/`isoBase64URL`/`isoUint8Array` helpers so encoding is guaranteed
byte-compatible with what it decodes. A stubbed verifier would only prove
this codebase's orchestration; it could never catch a regression in the
verification logic itself, and that's the piece D-3/D-14/D-15's whole
standard exists to hold to a higher bar. Every negative case in this
decision -- wrong challenge, wrong RP ID, wrong signing key, non-advancing
counter, reused challenge, signature over a different mandate's policy_hash
-- runs against the genuine library call, not a double.

**Deliberately not built this pass:** the HTTP endpoints
(`POST /v1/passkeys/register/*`, `POST /v1/mandates/:id/authenticate`) and
`POST /v1/mandates` (persisting a compiled policy as a
`PENDING_AUTHENTICATION` mandate, closing the gap D-7 left open). Everything
here is exercised at the repository/service layer, the same altitude as
every other Week 2/3 feature so far -- wiring the HTTP surface is Phase 4.

Implemented in `apps/api/src/webauthn/` (`webauthn.ts`, `types.ts`,
`in-memory-repository.ts`, `prisma-repository.ts`, `service.ts`) and
`apps/api/src/authorization/{types,in-memory-repository,prisma-repository}.ts`
(`activateMandate`). New Prisma model: `WebauthnChallenge`. Tested in
`apps/api/src/webauthn/*.test.ts`.

---

## D-21 — Phase 4: the HTTP surface, and a generic auth gate that doesn't second-guess D-18

Everything built in Weeks 2-3 was real but unreachable -- `apps/api/src/server.ts`
still only exposed the four Week 1 routes. This closes the loop: eleven new
routes, an auth model, and one end-to-end test that drives the whole PRD
demo over `app.inject()` with no direct calls into `authorize()` or any
repository -- compile, create a mandate, register and authenticate a real
(virtual) passkey, mint an agent key, four authorization attempts, fetch
each receipt, verify the evidence chain.

**One credential table, two shapes, one gate.** `agent-keys` (D-18) already
had everything a generic bearer-credential system needs -- prefix lookup,
hashing, revocation. Broadening `agentId` to nullable turns the same table
into org credentials too (account-management routes: create a mandate,
register an agent, view evidence) without a second implementation to keep
in sync. One `preHandler` hook covers every route except `/health` and
`/v1/reason-codes`: no credential is a 401, full stop, before any handler
runs.

**The gate does not enforce which credential *shape* a route wants.** POST
`/v1/authorizations` is documented as needing an agent key specifically, but
the hook accepts either kind and lets the route find out the hard way: an
org credential presented there has `agentId: null`, which can never equal
`request.agent_id`, so `authorize()`'s own key check (D-18) rejects it as a
mismatch -- an ordinary recorded `DENY_AGENT_NOT_BOUND`, not a special
`403`. This was a deliberate choice over adding a second, route-specific
gate: D-18 exists precisely so that "wrong credential for this agent" is
always a decision with a reason code, never a bare error a caller has to
special-case. Encoding "org credential can't authorize" as a second
enforcement point would have created two different failure shapes for what
is, underneath, the same fact -- the presented credential doesn't prove
you're the agent you're claiming to be.

**`POST /v1/mandates`, closing D-7's gap.** `policy_hash` is recomputed
server-side from the submitted policy (`hashPolicy`), never trusted from the
caller -- the whole point of the hash is that it's the thing a signature
later commits to, so accepting a client-supplied one would let a caller
submit a policy and a hash that don't correspond and never notice.

**`/authenticate/options` picks the ceremony, not the caller.** One
endpoint pair, two modes: if the mandate's principal has never registered a
passkey, `options` returns a registration challenge (random); once they
have, it returns an authentication challenge (`base64url(policy_hash)`,
D-20). `/verify` dispatches on the `mode` the caller echoes back. A
principal's first mandate therefore takes two options/verify round trips
(register, then authenticate) and every mandate after that takes one --
registering doesn't itself activate anything; only a real signature over
that specific `policy_hash` does.

**A real tenancy gap, found and fixed while wiring `DELETE
/v1/agents/:id/keys/:keyId`.** `AgentKeyRepository.revokeKey` took only a
key id -- any authenticated credential from *any* organization could revoke
any key anywhere, since nothing scoped the lookup. D-1 says nothing is
queried without `organizationId`; this one was. Fixed by adding
`organizationId` to `revokeKey`'s signature and scoping the underlying
query/update to it, returning whether a matching row was actually found and
revoked (so the route can 404 instead of silently no-op). Both
implementations and all three existing call sites were updated, and a
negative test (`revoking with the wrong organizationId does nothing -- the
key stays valid`) was added to both the in-memory and Prisma suites --
exactly the kind of gap D-4's standard exists to catch, just found a phase
late instead of at write time.

**Deliberately minimal, stated rather than silently skipped:**
- `POST /v1/agents/:id/keys` doesn't check the named agent exists in the
  caller's organization before minting a key for it. In-memory, this
  creates a key for a phantom agent id; against Prisma, the `agentId`
  foreign key constraint fails and the request 500s rather than 404s. Worth
  a proper existence check before this is public.
- `GET /v1/evidence?subject=` matches exact `subject_id` only, not a
  `subject_type:subject_id` pair or a prefix. Fine for the demo's scale;
  will not stay fine once one organization has many subject types sharing
  id-shaped values.
- No rate limiting, no request size limits beyond Fastify's defaults, no
  pagination on `GET /v1/evidence` for an organization with a long chain.

Implemented in `apps/api/src/server.ts`. New
`AuthorizationRepository` methods: `createMandate`, `getMandateSummary`,
`getAuthorization`, `createAgent` (kept on this interface rather than a
separate one -- a standalone in-memory agent store would desync from the
one `resolveMandateGate` already reads). `apps/api/src/index.ts` now
constructs Prisma-backed repositories when `DATABASE_URL` is set, in-memory
otherwise, so a developer running the server without a database gets a
working (non-persistent) server instead of a crash. Tested in
`apps/api/src/server.test.ts`.

---

## D-22 — Week 4: payment execution, and a type-branded state machine for it

**`PaymentAdapter` (`packages/core/src/payment-adapter.ts`) is the product
surface, per D-13, not an implementation detail.** `ExecutionRequest`,
`ExecutionResult`, and `RailCapability` name no provider, import no
provider SDK, and assume no provider's semantics -- `RailCapability`
(`holdsFundsBeforeCapture`, `reversible`, `settlement`) is how a card
rail's authorize-then-capture model and a stablecoin's atomic,
irreversible settlement are represented as *data* that differs, not as a
branch anywhere in core or in the execution service that treats one rail
specially. `StripeAdapter` (`apps/api/src/payments/`) and `X402Adapter`
fill the same three fields in with genuinely different values -- that
difference, expressible without either adapter knowing the other exists,
is what makes this a router rather than a Stripe wrapper with a second
rail bolted on. `X402Adapter.execute()` deliberately does not move money;
wiring a live x402 settlement is out of scope, and the point this pass
needed to prove was that nothing in the router assumes there is only ever
one kind of rail -- a second, structurally valid adapter with a different
capability profile is that proof.

**It is a compile error to execute a DENIED or PENDING_STEP_UP
authorization -- not a guard clause a later edit could route around.**
`ExecutableAuthorization` (`apps/api/src/execution/executable.ts`) is
branded with a property keyed by a `unique symbol` that the module never
exports; TypeScript's structural typing would otherwise let any code
construct a value shaped like the interface just by matching its fields,
and a symbol nothing outside the file can name closes that hole. The only
function that can produce one, `asExecutable`, returns `null` for every
status except `AUTHORIZED` and `STEP_UP_APPROVED` -- including `EXECUTED`
itself, which is what makes a second execution attempt on the same
authorization impossible by the same mechanism, not a separate check.
`executePayment` (`execution/service.ts`) accepts only this branded type,
so there is no path from a raw `StoredAuthorization` to a rail call that
doesn't go through the one function that decides whether that's allowed.

This was verified, not just asserted: `apps/api/tsconfig.json` (like every
package's tsconfig) excludes `*.test.ts` from its build, so `npm run
typecheck`'s `tsc -b` alone never actually type-checked test files --
meaning a `@ts-expect-error` proof placed in a test would be silently
inert, checked by nothing, forever. Added `tsconfig.typecheck.json` (root)
plus a `typecheck:tests` script so `npm run typecheck` now covers every
`.ts` file in the repo including tests. Confirmed the specific proof in
`executable.test.ts` is load-bearing by temporarily widening
`requiresExecutable`'s parameter type from `ExecutableAuthorization` to
`StoredAuthorization` and watching `tsc` reject the now-unnecessary
`@ts-expect-error` as unused -- the same red/green discipline D-15's
negative control used, applied to a compile-time guarantee instead of a
runtime one. `recordExecution` (the repository method the branded type
guards access to) also throws on a non-executable status directly, as
defense in depth -- the type guard is the primary mechanism, not the only
one standing between a bad call and a second ledger effect.

Turning on real type-checking for every test file surfaced pre-existing
gaps that had never been caught (esbuild, which Vitest uses to run tests,
strips types without checking them): `PolicyParseResult` was declared as
`{ ok: boolean; policy?: Policy; ... }` rather than a real discriminated
union, so `if (!result.ok) throw; return result.policy` -- the pattern
used throughout the test suite -- never actually narrowed `policy` to
non-optional; TypeScript had no way to know `ok: true` implied `policy`
was defined, because nothing in the type said so. Fixed at the type
declaration (`packages/core/src/policy.ts`), not by patching each of the
five call sites with an assertion. A few Node/`@types/node` `Uint8Array<
ArrayBufferLike>` vs. the library's `Uint8Array<ArrayBuffer>` mismatches
(same class as the ones found building `virtual-authenticator.ts` in
Week 3) and a couple of `noUncheckedIndexedAccess` array-index gaps were
fixed the same way already established: explicit generic parameters and
non-null assertions at the point the invariant is actually known.

**Ledger entries record which rail executed and what it took, per D-13.**
`LedgerEntry` gained nullable `provider`/`providerFee` columns, populated
only on `CAPTURE` entries. Executing an `ALLOW` or an approved `STEP_UP`
releases its existing `RESERVATION` and replaces it with a `CAPTURE` for
the same amount -- net zero change to cumulative spend, since the
reservation already counted against it at decision time (D-4) -- tagged
with the rail's name and fee. A receipt that couldn't show which rail
moved the money, and what that rail charged for itself, couldn't prove
the router stayed neutral across rails; now it can.

**Step-up completion is a separate, explicit action from execution, for
both a fresh `ALLOW` and an approved `STEP_UP`.** Approving a step-up
moves it to `STEP_UP_APPROVED` (already existed, Week 2) and stops there;
`POST /v1/authorizations/:id/execute` is the one path to a rail call,
regardless of how the authorization got to an executable status. TTL
expiry is lazy, not a background sweep -- there's no job infrastructure in
this build -- checked on read (`GET /v1/authorizations/:id`) and before
every step-up or execute attempt, so a pending step-up sitting past its
`step_up_expires_at` expires itself, releasing its reservation, the next
time anything looks at it rather than requiring an explicit decline.

**Webhook ingestion is idempotent by construction, not by a
check-then-write.** `ProviderEvent`'s existing `@@unique([provider,
externalId])` constraint (schema present since Week 1, unused until now)
is the actual mechanism: `PrismaProviderEventRepository.recordIfNew`
attempts the insert and treats a `P2002` violation as "already seen,"
so two concurrent deliveries of the same event race on the database
itself, not on application logic that could get the order wrong. Signature
verification happens in `server.ts`, ahead of this: Fastify's default JSON
parser doesn't expose the raw body bytes HMAC verification needs, so a
content-type parser override stashes them (`request.rawBody`) before
parsing, and `POST /v1/webhooks/stripe` is deliberately exempt from the
Bearer-credential gate -- Stripe authenticates with a signature over those
exact bytes, not a bearer token. Verified with `stripe.webhooks.
generateTestHeaderString` (a local HMAC operation, no live webhook
endpoint or network call needed): a genuinely signed `charge.refunded`
event applies a `CREDIT` ledger entry once, an identical redelivery is a
no-op, and a forged signature is rejected outright.

Implemented in `packages/core/src/payment-adapter.ts`,
`apps/api/src/execution/` (`executable.ts`, `service.ts`),
`apps/api/src/payments/` (`stripe-adapter.ts`, `x402-adapter.ts`),
`apps/api/src/webhooks/` (`types.ts`, `in-memory-repository.ts`,
`prisma-repository.ts`, `service.ts`), and new
`AuthorizationRepository` methods `recordExecution`/`recordRefund`. New
Prisma columns: `LedgerEntry.provider`/`providerFee`. Tested in
`execution/*.test.ts`, `payments/*.test.ts` (Stripe's suite gated on a
real `STRIPE_SECRET_KEY`, same `db-gate.ts`-style pattern as D-15/D-16/D-20
-- self-skips until one is configured, `AGENTPAY_REQUIRE_STRIPE=1` fails
loudly instead), `webhooks/service.test.ts`, and
`apps/api/src/server.test.ts`.

---

## D-23 — Week 5: the SDK's error/step-up/idempotency design, the dashboard, and OQ-4

**Typed errors, one class per distinct failure mode the server actually
returns, not a single generic exception.** `packages/sdk/src/index.ts`
maps every `{error: "..."}` shape `server.ts` sends into its own
`AgentPayError` subclass -- `ValidationError` (400), `UnauthorizedError`
(401), `NotFoundError`/`NoActiveMandateError` (404, the latter carrying
`reasons` since it's specifically `authorize()`'s "no mandate resolved at
all" case), `IdempotencyConflictError` (409, carrying the `existing`
decision the reused key is actually bound to),
`AuthorizationStatusConflictError` (409 `not_executable` /
`not_pending_step_up`, carrying the blocking status),
`ExecutionRejectedError` (402, the rail declined), `UnknownRailError`
(400). A `DENY` or `STEP_UP` decision is a normal, successful return
value from `authorize()`, never thrown -- only something that stopped a
decision from being reached at all throws. `reason_codes` on
`AuthorizationDecision` is `ReasonCode[]`, the same branded string-literal
union `@agentpay/core` defines (D-11: additive-only), not `string[]` --
so a caller's `switch` over reason codes is exhaustiveness-checked by
`tsc`, the same guarantee the server side already had.

**Idempotency is generated for the caller, and used for something real: a
safe, automatic retry.** If `authorize()`'s caller doesn't pass
`idempotency_key`, the SDK generates one (`crypto.randomUUID()`) and
reuses that exact key across up to three attempts when the *network*
itself fails (a dropped connection, a timeout) -- never when the server
actually answered, success or error, since retrying a real HTTP response
would either be a no-op or wrong. This is what makes the idempotency key
worth generating automatically rather than just being a parameter a
developer has to remember: without the SDK owning both the key and the
retry, a caller who does remember to retry on their own has to also
remember to reuse the same key, and the two are easy to get out of sync.

**Step-up is driven from the developer's own UI, not a hosted page --
I-10.** The Week 1 stub's `step_up: { url }` implied a hosted approval
page; that's gone. `AuthorizationDecision.step_up` is now
`{ authorization_id, expires_at }` -- the only two things an approval
screen actually needs -- plus `approveStepUp(authorizationId)` /
`declineStepUp(authorizationId)`, thin wrappers over the same `POST
/v1/authorizations/:id/step-up` the API already exposed (Week 4). Nothing
about how the decision gets shown to a human, or where, is the SDK's
business. The same principle extends to mandate authentication, which was
never an SDK concern before this week either:
`getMandateAuthenticationOptions`/`verifyMandateAuthentication` forward a
WebAuthn challenge and response as opaque data -- the SDK depends on no
WebAuthn library, browser or otherwise, and never constructs a ceremony
itself.

**`execute()` mirrors D-22's branded-type trick, client-side.**
`ExecutableDecision` is keyed by a `unique symbol` `index.ts` never
exports, exactly like `ExecutableAuthorization` on the server; the only
constructor, `asExecutable()`, returns non-null only for `AUTHORIZED` or
`STEP_UP_APPROVED`. `execute()` accepts only that branded type, so
passing a `DENY` decision -- or any object merely shaped like a
decision -- is a compile error, not a runtime check a later edit could
route around. Proven the same way D-22's server-side version was: a
`@ts-expect-error`-anchored test (`index.test.ts`) that fails the build
if it ever stops being necessary.

**A real production bug, found only because the SDK's quickstart runs
`server.ts` outside Vitest for the first time in this project's
history.** `apps/api/src/payments/test-support/stripe-gate.ts` imported
`vitest` at module scope and also exported `probeStripeKey`, which
`server.ts` calls in production (to decide whether to register the Stripe
adapter). Every test run happened to work regardless, because tests
already run inside a Vitest worker -- so this had never once actually
executed `server.ts` in a plain Node process, which is exactly what a
deployed server does. `probeStripeKey` moved to a new
`apps/api/src/payments/stripe-key.ts` with no test-framework import, so
`vitest` can never end up in the server's runtime dependency graph again.
Found by writing `examples/quickstart.ts` and actually running it, not by
review -- the same lesson D-15's negative controls exist to generalize:
a test suite that never runs the code path a real deployment takes can't
catch a bug only that path exposes.

**Dashboard (`apps/dashboard`): Next.js App Router, Server Components
only, no client-side data fetching, no API layer of its own.** Every
page is an `async` Server Component that calls `@agentpay/sdk` directly
with the org credential recovered from the session cookie
(`lib/agentpay.ts`) and renders straight from the response -- there is no
`fetch` in the browser, no React Query/SWR, no dashboard-specific REST
endpoints to keep in sync with the API. This is the "don't gold-plate"
call the brief asked for: five read surfaces (mandates + a version's full
policy, the authorization log with reason codes joined against `GET
/v1/reason-codes` for human text, a receipt view, agents + keys with only
prefixes ever shown, and the evidence chain with its verify state), all
read-only, no write UI beyond the login form. Plain CSS, no component
library, no client state management -- legibility over polish, per the
brief.

**OQ-4, resolved: a session cookie wrapping the org credential itself, no
separate identity system, no third-party vendor.** There is no dashboard
user database and nothing to build one against -- the org credential
already *is* the tenant's identity (D-18) -- so the cheapest thing that
isn't wrong is to make the session carry that credential, encrypted, not
reinvent a parallel notion of "who's logged in." `apps/dashboard/src/lib/
session.ts`: AES-256-GCM under a required `AGENTPAY_DASHBOARD_SESSION_SECRET`
(32 bytes, base64), `httpOnly`/`secure`/`sameSite: lax` cookie. Login
posts the submitted key straight to the real API (`listAgents()`, chosen
because it's a harmless, already-existing org-scoped read) and only sets
the cookie if that call actually succeeds -- the dashboard never
re-implements what a valid credential is, D-18's verification is the only
check that matters. `decryptSession` returns `null` (never throws) for
anything that doesn't decrypt cleanly, since it runs on every
authenticated page load and a tampered or stale-secret cookie should look
like "logged out," not crash the request. **A real IdP (Clerk, WorkOS,
Auth.js) is explicitly a Week 6+ decision** -- this is intentionally the
minimum that resolves OQ-4 for a single-tenant-per-browser internal tool,
not a multi-user-per-org, SSO-capable answer. There is also, as of this
week, no self-serve way to mint an *organization's first* credential
through the API itself (every route that mints a key requires already
being authenticated as that organization) -- today that's an operator
action, same as the dashboard's own login assumes. Closing that gap is
part of the same Week 6+ real-auth decision, not something this session
routed around silently.

**Scoping note:** `apps/dashboard` is deliberately excluded from the root
`tsconfig.typecheck.json` flat program (see its `exclude`). Every other
package in this repo shares `tsconfig.base.json`'s `NodeNext` module
resolution (explicit `.js` extensions on relative imports, matching
Node's own ESM rules); Next.js's bundler expects the opposite
(extensionless relative imports, `moduleResolution: "bundler"`). Mixing
the two in one `tsc` program produces resolution noise unrelated to real
bugs. The dashboard's own `next build` (which runs `tsc` under its own,
independent `tsconfig.json`) is its type-checking gate instead -- run
separately, not part of `npm run typecheck`.

Implemented in `packages/sdk/src/index.ts`, `examples/quickstart.ts`
(runnable, not prose -- the actual exit-criteria artifact), and
`apps/dashboard/`. Tested in `packages/sdk/src/index.test.ts` (36 cases
against a fake `fetch`: every typed error, the idempotency-retry
behavior, the `asExecutable` brand, all adversarial) and
`packages/sdk/src/integration.test.ts` (5 cases against `buildServer()`
bound to a real port with real `fetch` -- the full compile → create →
authenticate → authorize → step-up → execute → verify journey, plus a
cross-organization `NoActiveMandateError` attack -- because the mocked
suite can't catch a wire-format mismatch between what the SDK sends and
what the server actually expects). The dashboard is tested lightly, per
the brief: `apps/dashboard/src/lib/session.test.ts` covers the one piece
of real logic it has (the cookie's encryption), including tampering,
wrong-secret, and malformed-input attacks; the pages themselves were
verified by hand against a running server, not with an automated suite.

---

## D-24 — Week 6: the dashboard's step-up approval UI

**The gap D-23 left open.** The SDK could drive a step-up
(`approveStepUp`/`declineStepUp`, Week 5) but the dashboard itself
couldn't -- the one first-party surface in this build had no way to do the
thing the whole product exists to let a human do. Built on
`/authorizations/[id]`, the existing receipt page, rather than a new route:
a pending step-up is a state that page already renders, not a separate
concept.

**Shows the same three things any approval UI needs, no more:** what the
agent asked for (amount, merchant, category, and the free-text
`description` if the agent gave one), which policy term it tripped
(`reason.policy_path` and `reason.detail` -- the exact threshold and the
value that crossed it, e.g. `amount: 8700, threshold: 15000`, not just the
reason code), and Approve/Decline. `reason.detail` was already populated by
`evaluate()` for nearly every reason code (Week 2) and already flowed
through the SDK's `AuthorizationDecision.reasons` (Week 5); nothing needed
to change below the dashboard to surface it -- it just wasn't rendered
anywhere before now. Extended the receipt's own "Reasons" section with the
same `policy_path`/`detail` rendering, not just the approval card, since
knowing *why* applies equally to an already-decided ALLOW or DENY.

**Two Server Actions, not a client-side fetch to some dashboard-specific
endpoint.** `authorizations/[id]/actions.ts` calls
`requireSessionClient()` then `agentpay.approveStepUp(id)` /
`.declineStepUp(id)` -- the exact same two SDK calls a developer's own
approval UI would make (I-10: nothing here is special-cased for being
first-party). `revalidatePath` refreshes the page after either action;
approving or declining moves the receipt out of `PENDING_STEP_UP`, so the
approval card simply stops rendering on the next paint -- there's no
separate "resolved" state to reconcile by hand.

Implemented in `apps/dashboard/src/app/(dashboard)/authorizations/[id]/`
(`page.tsx`, `actions.ts`) and `apps/dashboard/src/lib/reasons.ts`. Tested
in `apps/dashboard/src/lib/reasons.test.ts` (the one new piece of pure
logic, `formatDetail`); the approve and decline flows themselves were
verified by hand against a running server -- a pending step-up approved
end to end (status moves to `STEP_UP_APPROVED`, the card disappears) and a
second one declined the same way -- same "tested lightly" scope D-23 set
for the dashboard, since there's still no page-level automated suite.

---

## D-25 — Week 6: the rename, implemented (D-19)

**Superseded by D-28: the same mechanical pass was run again when "Bles"
was renamed to "Waysafe."** Left in place, unedited below, so the
original reasoning survives.

D-19 named the rename and its timing but explicitly wasn't the rename
itself ("Not implemented yet"). This is that follow-through, done exactly
where D-19 said it should happen -- Week 6, before anything is public.

**What changed, mechanically:**

- Package scope: `@agentpay/*` → `@bles/*` (`packages/core`, `packages/db`,
  `packages/sdk`, `apps/api`, `apps/dashboard`, and every import
  referencing them). Root `package.json` name: `agentpay-router` → `bles`.
- Env vars: every `AGENTPAY_*` → `BLES_*` (`BLES_COMPILER`,
  `BLES_COMPILER_MODEL`, `BLES_RP_ID`, `BLES_RP_ORIGIN`,
  `BLES_EVIDENCE_SIGNING_KEY`, `BLES_DASHBOARD_SESSION_SECRET`,
  `BLES_API_BASE_URL`, plus the test-only `BLES_REQUIRE_DB`/
  `BLES_REQUIRE_STRIPE` gates) -- `.env`, `.env.example`, and
  `apps/dashboard/.env.example` all updated so local dev doesn't silently
  break.
- The SDK's exported names: `AgentPay` → `Bles`, `AgentPayError` →
  `BlesError`, `AgentPayOptions` → `BlesOptions`.
- The agent API key marker: `ap_live_` → `bls_live_` (`apps/api/src/
  agent-keys/keys.ts`) -- a branded, visible string (shown in the
  dashboard's Agents & Keys table, in every `createAgentKey` response),
  not an internal implementation detail, so D-19's "any other
  AgentPay-branded string" catches it too.
- The Stripe metadata key adapters write to correlate a webhook back to an
  authorization: `agentpay_authorization_id` → `bles_authorization_id`
  (`stripe-adapter.ts`, `webhooks/service.ts`, and their tests) -- an
  external-facing string stored on real PaymentIntents, same reasoning.
- `README.md`, `docs/CODE-REVIEW-BRIEF.md`'s title, the dashboard's brand
  text (page title, login page, sidebar), and every doc comment describing
  the product by name in currently-live code.

**What deliberately didn't change:** this file's own historical entries
(D-1 through D-24) and OQ-2's discussion of "Mastercard Agent Pay" --
same reasoning D-19 itself already established ("left in place, unedited
below, so the original reasoning survives"). D-19's own text still says
"AgentPay Router" throughout, on purpose: it's the record of what was
being renamed *from*. Retroactively editing either would misrepresent
what was actually decided, and when. The one place old-name references
were touched despite being technically "historical" is anywhere they'd
otherwise leave the codebase *inaccurate* about its own current
mechanics -- an env var name in a still-live code comment, a package name
in a still-run npm script -- which is a correctness fix, not a rewrite of
the narrative.

**The directory this repo lives in was not renamed.** D-19's "repo name"
item is read here as the version-controlled root `package.json` name
(now `bles`) -- moving the actual folder on disk is a filesystem
operation outside anything a commit can capture, and this repo has no
git remote to rename either. Left for whoever owns the checkout to do by
hand if they want it, whenever is convenient.

**The policy schema id -- the one item D-19 flagged as having a real
compatibility cost, not just a search-and-replace: bumped cleanly to
`bles.policy/v1`, no alias for the old id.** `POLICY_SCHEMA_VERSION`
(`packages/core/src/policy.ts`) is matched by `z.literal`, so this is a
hard break: a document with `schema_version: "agentpay.policy/v1"` no
longer parses, and (per D-5) its `policy_hash` no longer matches anything
computed fresh, because the hash is over canonical bytes that include the
schema id. Chose a clean bump over indefinitely aliasing the old id
because the cost D-19 was warning about -- *someone else's code now
depends on the old value* -- doesn't exist yet: no external developer has
integrated, and the dev database this sprint uses (`.env`'s
`DATABASE_URL`) had zero rows in every table that could hold a policy
document at the time of the bump (checked directly before touching the
schema). D-19's own framing already named the trade a clean bump makes
sense under: "Week 6 is the window between 'nothing to break' and
'something to break.'" Recorded fixtures (`fixtures/compiler/*.json`)
embed a `schema_version` too -- their own field, not derived at replay
time -- so all five were updated in the same pass; otherwise every test
that runs a compiled fixture through `parsePolicy`/`createMandate` would
have started failing the moment `POLICY_SCHEMA_VERSION` changed underneath
them, which is exactly what actually happened first, caught immediately
by `npm run typecheck` and `npm test` both staying green afterward -- the
"tests first where behavior changes" the sprint has run on this whole
time doubling as the check that this particular break was total, not
partial.

**Verification, not just search-and-replace by feel:** after the pass,
grepped the entire tree (excluding `node_modules`/`dist`/`.next`/
`package-lock.json`) case-insensitively for `agentpay` and confirmed zero
matches outside D-1 through D-24's preserved historical text and OQ-2's
preserved discussion of Mastercard's product. `package-lock.json` was not
hand-edited -- regenerated via `npm install` after every `package.json`
name changed, which is also what re-links each workspace package under
its new scope in `node_modules/@bles/*` (the stale `node_modules/
@agentpay/*` symlinks are gone, not just shadowed). `npm run typecheck`,
the full `npm test` (Postgres-backed suites included -- `DATABASE_URL` was
reachable), `npm run build` (all four packages plus the dashboard's `next
build`), and `examples/quickstart.ts` end-to-end were all run clean after
the rename, in that order.

Implemented across the entire tree; see the commit for the full file
list. No behavior changed anywhere except the literal identifiers named
above -- this is D-19's mechanical pass, executed.

---

## D-26 — Week 6: signing the evidence chain, resolves OQ-8 and D-17

**Signs every event, not a periodic tip signature.** OQ-8 posed this as an
open question; resolved in favor of per-event signing because the
alternative has a real gap a demo (and a real principal) would hit
immediately: a receipt shown right after a purchase -- the moment anyone
actually looks at one -- would have no signature at all until the next
periodic sweep ran, since there's no background-job infrastructure in this
build to run one. Ed25519 signing is microseconds; there's no performance
case for batching it, and per-event signing means "verifiable" is true
the instant an event is written, not eventually. The chain's structure is
otherwise unchanged (OQ-8's own framing already anticipated this: "the
chain structure doesn't change... only a signature gets attached") --
`signature` is a new column alongside `hash`, computed over `hash` itself
(SHA-256 already commits to the full event; signing the fixed-size digest
is equivalent to signing the content and cheaper), not a change to
`computeEventHash`'s inputs.

**The private key never touches Postgres; the public key is published,
unauthenticated, at `GET /v1/evidence/public-key`.** That split is the
entire mechanism: reproducing a valid signature for a row an attacker
edited directly in the database requires the private key, which by
construction isn't stored anywhere the database's own compromise could
reach. The public key route is deliberately unauthenticated (added to
`PUBLIC_ROUTES`) -- the third party this whole feature is *for* by
definition has no Bles credential, so gating the key that lets them verify
independently behind one would defeat the point. One signing key per
deployment, not one per organization: operationally simpler (one key to
generate, rotate, and publish) and there's no tenancy reason for it to
differ, since verification is a math check against public data, not a
capability that needs scoping the way D-1's tenancy boundary does.

**Two ways to verify, deliberately, matching I-10.** `GET
/v1/evidence/verify` (existing route, now actually checks signatures) and
the SDK's `verifyEvidenceChain()` are a convenience: ask this server
whether its own database checks out. That's useful, but it still trusts
the server to answer honestly -- which is exactly the trust OQ-8 exists to
not require. `@bles/sdk` also exports `verifyEvidenceIndependently(events,
publicKeyBase64)`, a pure function with no network call: feed it
`listEvidence()`'s events and `getEvidencePublicKey()`'s key and it runs
the identical check -- hash consistency plus every signature -- in the
caller's own process, using nothing this server said about itself. That
second path is the actual "verifiable by a third party" claim; the first
is a convenience that happens to use the same math. Required exposing
`organization_id` on the evidence wire JSON (`toEvidenceJSON`,
`EvidenceRecord`) that wasn't there before -- `computeEventHash`'s content
includes it, so independent verification is impossible without it on the
wire. A small, deliberate widening of what the API returns, not an
oversight caught after the fact.

**Key management: `BLES_EVIDENCE_SIGNING_KEY` (base64 PKCS8) when set;
generated fresh per-process when it isn't, matching D-15/D-16's precedent
for `npm run dev` with no `DATABASE_URL`.** An ephemeral key means
`examples/quickstart.ts` and a bare `npm run dev:api` sign and verify
correctly with zero configuration -- the same "nothing to break" bar the
rest of this build holds itself to -- at the honest cost that signatures
don't survive a restart under an ephemeral key, which is exactly correct:
there is no way to distinguish "the key rotated legitimately" from "an
attacker rebuilt the database" without a public key kept somewhere outside
that database, and an ephemeral key by definition isn't kept anywhere.
`npm run keygen -w @bles/api` (new script, `apps/api/src/keygen.ts`)
generates a real one and prints both halves -- the private key to add to
`.env`, the public key for reference (it's also always available live at
`GET /v1/evidence/public-key`, so nothing needs to copy it around by
hand). `EvidenceEvent.signature` is a required, non-nullable column
(`packages/db/prisma/schema.prisma`) -- confirmed the dev database had
zero rows in every table that could hold one before adding it, same
verification D-25's policy-schema-id bump did, for the same reason: a
required column with no migration story is only safe when there's nothing
yet to migrate.

**Tested at every layer, not just the crypto primitives.** `@bles/core`:
`evidence-signing.test.ts` (sign/verify round-trips, wrong key, wrong hash,
a single flipped signature byte, key export/import) and an extended
`evidence.test.ts` -- including the test that actually justifies this
decision: a *full* chain rewrite (forge one event, then recompute
`hash`/`previous_hash` consistently through every event after it, exactly
what a patient database-only attacker would do) passes hash-only
`verifyEvidenceChain` -- proving D-17's gap is real, not theoretical --
and fails signature verification, because the attacker was never able to
re-sign what they forged. Both `InMemoryEvidenceRepository` and
`PrismaEvidenceRepository` (real Postgres) get equivalent round-trip and
cross-key-rejection tests -- no repository gets a "test mode" that skips
signing, on the same principle `virtual-authenticator.ts` established in
Week 3: a fake would only prove this codebase's orchestration, never that
the signature check does anything. `server.test.ts` proves the HTTP
surface: `GET /v1/evidence/public-key` needs no credential and round-trips
to a real Ed25519 key, and a dedicated attack test corrupts a stored
signature through the same in-memory repository instance the running
server reads from (not a mock) and confirms `GET /v1/evidence/verify`
catches it. `packages/sdk`: unit tests for `getEvidencePublicKey` and
`verifyEvidenceIndependently` (including cross-key and tampered-payload
attacks) against a fake `fetch`, plus two `integration.test.ts` cases
against a real listening server -- one proving the full
`listEvidence()`/`getEvidencePublicKey()`/`verifyEvidenceIndependently()`
path works end to end, one proving it actually catches a tampered event
fetched from the real API.

**D-17's restriction is lifted, precisely where it now no longer applies.**
"Verifiable" is accurate to say once a `publicKey` is supplied to
`verifyEvidenceChain` (or its SDK/HTTP equivalents actually check
signatures, which they now do) -- `packages/core/src/evidence.ts`'s module
doc comment, the dashboard's evidence page copy, and this file's D-17/OQ-8
entries were all updated to say so. The restriction still holds for the
*pure* hash-chain-only case (no public key supplied) -- that path still
only proves what D-17 always said it proves, and both `verifyEvidenceChain`
and `ChainVerificationResult` document the difference explicitly (`signed`
is present and `true` only when the stronger check actually ran).

Implemented in `packages/core/src/evidence-signing.ts` (new),
`packages/core/src/evidence.ts`, `packages/core/src/domain.ts`
(`EvidenceEvent.signature`), `apps/api/src/evidence/` (`in-memory-
repository.ts`, `prisma-repository.ts`, `types.ts`, new `signing-key.ts`),
`apps/api/src/keygen.ts` (new), `apps/api/src/server.ts` (`GET
/v1/evidence/public-key`, updated `GET /v1/evidence/verify`),
`apps/api/src/index.ts`, `apps/dashboard/src/app/(dashboard)/evidence/
page.tsx`, and `packages/sdk/src/index.ts`
(`getEvidencePublicKey`, `verifyEvidenceIndependently`,
`EvidencePublicKey`). `packages/db/prisma/schema.prisma`'s new
`EvidenceEvent.signature` column, pushed to the dev database. Tested as
described above; full suite (`npm test`, Postgres-backed included) and
`npm run typecheck` both green afterward.

---

## D-27 — Week 6: the demo, and resolving OQ-1

**Runs against real Postgres when `DATABASE_URL` is set, the same
zero-config in-memory bootstrap `examples/quickstart.ts` uses when it
isn't -- either way, one command.** "Make it runnable with one command
against a fresh database" reads as two separate promises, not one: it
must always run with nothing configured (quickstart's own bar), and it
must be meaningful to run against a *real* database, not just a
simulation of one, when there's a database to run it against. Every run
mints a freshly-suffixed organization id (`org_demo_<timestamp>_<random>`)
regardless of which branch runs, so repeating the demo against a
Postgres instance that already has prior runs in it -- the realistic
case for a database that's meant to stay around -- never collides with
them. Running the real-database branch for the first time is what
surfaced OQ-9 (no API route creates a `Principal`); worked around there
by seeding one directly with Prisma, the same way the Prisma test suites
already do, with a comment pointing at the open question rather than a
silent fix.

**The two step-up moments block on a real keypress, not a timer.** "A
real human approval" is read literally: `askYesNo` uses Node's
`readline/promises` against `process.stdin` and genuinely waits. Without
a TTY attached (CI, a pipe, this being invoked non-interactively) it
auto-decides after saying so out loud, rather than hanging -- a demo
script that can silently stall a CI run or an automated smoke test would
be a worse failure mode than a documented default. Both branches of both
prompts were exercised end to end during development this way (approve
verified-but-unlisted → executes; decline the spoofing attempt → stays
declined), and separately confirmed against a live TTY is out of scope
for what could be automated here -- see the testing note below.

**The merchant-spoofing scenario asserts a name with no domain --
literally D-3's own canonical example ("if the agent just types
'Staples'").** Chose this over a lookalike domain (`staples-rewards.example`
or similar) because it's the one case the codebase's own documentation
already uses to explain D-3, so the demo's fourth attempt teaches exactly
the invariant the README and D-3 already claim, rather than a different,
untested edge of the same idea. It resolves to the same reason code as
attempt 3's legitimate step-up (`STEP_UP_MERCHANT_NOT_ALLOWLISTED` --
`evaluateMerchant` in `packages/core/src/engine/evaluate.ts` only reaches
the more specific `STEP_UP_MERCHANT_UNVERIFIED` when an assertion
*matches* an allow entry's scheme without being verified, and a bare
`name` ref never matches a `domain`-scheme allow entry at all); the
demo's own narration is what actually distinguishes them for a human
deciding -- it prints `merchant.trust` and `merchant.refs` for both
(`VERIFIED` with a real domain vs. `ASSERTED` with only a name) and says
so explicitly, which is precisely the information the dashboard's own
approval card (D-24) already surfaces for exactly this reason.

**Resolves OQ-1: the demo uses the strict reading.** "Never spend more
than $150" produces `DENY` at $203, not `STEP_UP` -- the PRD's original
example was simply wrong about what its own instruction meant (D-11's
semantics were never in question; OQ-1 was about which of two *already
correct* fixtures to feature). `STEP_UP` is demonstrated separately, by
the same instruction's other clause ("ask me before buying from another
merchant") -- so the demo's four attempts map cleanly onto the two
distinct clauses in one instruction, rather than needing a different
instruction to show each decision.

**No live-model compilation.** Uses `FixtureIntentCompiler`, the same
deterministic replay `examples/quickstart.ts` uses, not
`AnthropicIntentCompiler` even when `ANTHROPIC_API_KEY` is configured
(unlike `apps/api/src/cli.ts`, which prefers live compilation when
available). A script called "the demo" that's meant to tell the same
four-beat story reliably, on request, can't have its downstream amounts
implicitly depend on whatever numbers a live model happens to pick this
time -- determinism here is a feature of a rehearsed presentation piece,
not a limitation. Live compilation is still one command away
(`npm run compile -w @bles/api -- "..."`) for anyone who wants to see
that half of the story instead.

**Tested by running it, not by an automated suite -- same bar
`examples/quickstart.ts` was held to.** Run to completion, non-interactively
(both step-up prompts hitting the no-TTY fallback, both directions),
against the in-memory bootstrap and separately against real Postgres
(twice in a row, against the same already-populated database, to prove
the "fresh database on every run" claim rather than just asserting it);
`npm run typecheck` clean. No automated test wraps the script itself --
its value is a human watching it, which isn't something a unit test
observes, and quickstart.ts set the precedent that this class of file is
verified by execution, not assertions.

Implemented in `examples/demo.ts` (new), plus a new `demo` script in the
root `package.json`.

---

## D-28 — The product is renamed again, from "Bles" to "Waysafe" — supersedes D-19 and D-25

**Bles did not clear.** D-19 named trademark search as the gating step
before a production WebAuthn domain could be chosen (see OQ-5's own text:
"It depends on 'Bles' (D-19) clearing trademark search, which has not
happened as of this sprint's end"). It didn't clear. "Bles" is trademarked
by another party in a way that made it unsafe to build a brand on, so it
gets dropped before any of it becomes public, for the same reason D-19
gave for renaming away from "AgentPay Router" in the first place: the
longer a name with a real conflict stays wired into code, package scopes,
and external-facing strings, the more expensive it is to unwind. Nothing
about the positioning changes -- this is still the system of record for
delegated financial authority, still not payments -- only the name.

**Waysafe was chosen because all four checks came back clean:**
`waysafe.ai` (registered), the npm scope `@waysafe` (org created), the
GitHub org `github.com/getwaysafe` (see below for why it isn't bare
`waysafe`), and a USPTO search that came back clear. That is the actual
bar this time, not "sounds good" -- Bles was dropped for failing exactly
this check, so Waysafe wasn't adopted until it passed all four.

**The GitHub-org/npm-scope asymmetry is deliberate, not a leftover to
tidy up.** Bare `waysafe` was already taken on GitHub, so the org is
`getwaysafe`. The npm scope stays the short `@waysafe`, unshortened,
because a package scope is typed in every import a developer writes
(`import { Waysafe } from "@waysafe/sdk"`) while a GitHub org name is
typed rarely -- once to clone, maybe once to open an issue. Optimizing
the frequently-typed surface for brevity and accepting the awkwardness on
the rarely-typed one is the right trade, not an inconsistency. Do not
"fix" this later by renaming the npm scope to match the GitHub org, or by
chasing bare `waysafe` on GitHub through a dispute process -- both would
spend real cost undoing a choice that was made on purpose.

**What changed, mechanically -- the same pass D-25 ran, one name later:**

- Package scope: `@bles/*` → `@waysafe/*` (`packages/core`, `packages/db`,
  `packages/sdk`, `apps/api`, `apps/dashboard`, and every import
  referencing them). Root `package.json` name: `bles` → `waysafe`.
- Env vars: every `BLES_*` → `WAYSAFE_*` (`WAYSAFE_COMPILER`,
  `WAYSAFE_COMPILER_MODEL`, `WAYSAFE_RP_ID`, `WAYSAFE_RP_ORIGIN`,
  `WAYSAFE_EVIDENCE_SIGNING_KEY`, `WAYSAFE_DASHBOARD_SESSION_SECRET`,
  `WAYSAFE_API_BASE_URL`, plus the test-only `WAYSAFE_REQUIRE_DB`/
  `WAYSAFE_REQUIRE_STRIPE` gates) -- `.env`, `.env.example`, and
  `apps/dashboard/.env.example` all updated so local dev doesn't silently
  break.
- The SDK's exported names: `Bles` → `Waysafe`, `BlesError` →
  `WaysafeError`, `BlesOptions` → `WaysafeOptions`.
- The agent API key marker: `bls_live_` → `wsf_live_`
  (`apps/api/src/agent-keys/keys.ts`) -- same reasoning D-25 gave for
  `ap_live_` → `bls_live_`: a branded, visible string shown in the
  dashboard's Agents & Keys table and in every `createAgentKey` response,
  not an internal implementation detail. Kept the same three-letter
  abbreviation shape (`bls_` → `wsf_`) rather than spelling out
  `waysafe_live_`, matching the existing convention of a short, visible,
  branded prefix distinct from the full product name.
- The policy schema id: `bles.policy/v1` → `waysafe.policy/v1`
  (`POLICY_SCHEMA_VERSION` in `packages/core/src/policy.ts`), matched by
  `z.literal` so this is a hard break the same way D-25's bump was --
  bumped cleanly again, no alias for the old id, for the same reason: no
  external developer has integrated yet, and this is still the window
  D-19 called "the window between 'nothing to break' and 'something to
  break.'" All five `fixtures/compiler/*.json` files carry their own
  `schema_version` field and were updated in the same pass, including the
  three (`procurement.json`, `travel.json`, `underspecified.json`) whose
  `assumptions`/`rationale` prose also mentioned "Bles" by name.
- The Stripe metadata key: `bles_authorization_id` →
  `waysafe_authorization_id` (`stripe-adapter.ts`, `webhooks/service.ts`,
  and their tests) -- an external-facing string stored on real
  PaymentIntents, same reasoning as D-25.
- The dashboard's session cookie name:
  `bles_dashboard_session` → `waysafe_dashboard_session`
  (`apps/dashboard/src/lib/session.ts`).
- `README.md`, `docs/CODE-REVIEW-BRIEF.md`'s title, the dashboard's brand
  text, and every doc comment describing the product by name in
  currently-live code.

**What deliberately didn't change:** this file's own historical entries
(D-1 through D-27, and OQ-2's discussion of "Mastercard Agent Pay") --
same reasoning D-19 and D-25 already established, one level deeper now.
D-19 still says "AgentPay Router" throughout; D-25 still says "Bles"
throughout ("the package scope: `@agentpay/*` → `@bles/*`", etc.) --
both are the record of what was being renamed *from*, at the time each
was written, and rewriting either to say "Waysafe" would misrepresent
what was actually decided, and when. Only their headers get a
"Superseded by D-28" note prepended, matching the pattern already used
for every other resolved entry in this file (D-19 resolved OQ-2, so this
mirrors OQ-2's own "Resolved by D-19" treatment one level up).

**Verification, not just search-and-replace by feel -- same bar D-25
set:** after the pass, grepped the entire tree (excluding
`node_modules`/`dist`/`.next`/`package-lock.json`) case-insensitively for
`bles` and confirmed zero matches outside D-1 through D-27's preserved
historical text, OQ-2's preserved discussion of Mastercard's product, and
this entry's own necessary references to the name it's replacing.
`package-lock.json` was not hand-edited -- regenerated via `npm install`
after every `package.json` name changed, which also re-links each
workspace package under its new scope in `node_modules/@waysafe/*`.
`npm run typecheck`, the full `npm test` (Postgres-backed suites
included -- `DATABASE_URL` was reachable), `npm run build` (all four
packages plus the dashboard's `next build`), and both
`examples/quickstart.ts` and `examples/demo.ts` end-to-end (in-memory and
against real Postgres) were all run clean after the rename, in that
order.

Implemented across the entire tree; see the commit for the full file
list. No behavior changed anywhere except the literal identifiers named
above -- this is D-19's mechanical pass, run a second time under a new
name.

---

## D-29 — Production WebAuthn RP ID: `dashboard.waysafe.ai`, a subdomain, not the apex — resolves OQ-5

D-20 deferred the actual answer here on purpose: it depended on D-19's
rename clearing trademark search, which hadn't happened by Week 6's end.
It has now (D-28) -- `waysafe.ai` is registered, so this is no longer
blocked, and it's worth settling before launch rather than at launch,
for the same reason D-20 gave: passkeys are bound to the RP ID, and
every credential registered against the wrong one has to be thrown away
and re-registered the moment the real one is picked. `localhost` stays
the RP ID for local development, per D-20 -- nothing here changes that;
every credential registered there was always disposable and stays that
way.

**The production RP ID is `dashboard.waysafe.ai` -- a subdomain, not the
apex (`waysafe.ai`).** This is the one part of this decision that
matters; everything else follows from it.

**Why not the apex.** WebAuthn's RP ID matching rule lets a page at any
origin whose domain has the RP ID as a registrable-domain suffix present
that RP ID and attempt a ceremony against credentials registered under
it. Register credentials against the apex (`waysafe.ai`) and every
current and future subdomain -- a marketing site, docs, a status page,
a blog, anything ever pointed at `*.waysafe.ai` -- becomes a surface
that can invoke passkey ceremonies bound to those credentials, not just
the dashboard that actually issues and consumes them. The apex is
exactly the property most likely to run less-trusted code over time: a
marketing site is the canonical thing that ends up on a CMS, with
third-party scripts, a redirect service, or a vendor-managed page --
none of which should sit inside the trust boundary of a credential that
authorizes someone's money. A subdomain RP ID doesn't have this
problem in the other direction: `dashboard.waysafe.ai` as the RP ID
means only pages served from `dashboard.waysafe.ai` itself (or a future
subdomain under it) can ever present that RP ID: a page at
`docs.waysafe.ai` or the bare apex cannot, because the suffix
relationship only runs one way.

**Why `dashboard.waysafe.ai` specifically, not a new dedicated auth
subdomain.** The WebAuthn ceremony is implemented today in
`apps/dashboard` (`getMandateAuthenticationOptions`,
`verifyMandateAuthentication`, and the passkey registration flow), and
OQ-6 (immediately below) settles the dashboard's own production host as
a Vercel deployment separate from the API's container host -- so
`dashboard.waysafe.ai` is not a hypothetical name, it's the literal
production hostname the dashboard is already headed for. A narrower,
purpose-built subdomain used only for the passkey ceremony (something
like `auth.waysafe.ai`) would scope the attack surface even tighter, and
is worth revisiting if the dashboard ever grows enough unrelated surface
area that isolating the ceremony becomes worth the operational cost of
running a second deployment -- but building that now, before the
dashboard exists in production at all, is inventing infrastructure this
decision wasn't asked to build. Pick the narrowest RP ID that matches
where the ceremony actually runs today; widen deliberately later if the
shape of the deployment changes, the same way D-20 itself was deferred
rather than guessed at.

**This is why the choice couldn't wait for D-19/D-28's dust to fully
settle, and also why it's being made now rather than at actual launch.**
Every week between this decision and the first real user registering a
passkey is a week where getting it wrong costs nothing; every credential
registered against `dashboard.waysafe.ai` after a real launch is a
credential that a later correction would invalidate. There is no
migration path for a wrong RP ID -- only re-registration -- so the
right time to decide is now, before there's anything to migrate.

**Not implemented yet.** `WAYSAFE_RP_ID`/`WAYSAFE_RP_ORIGIN` in `.env`
and `.env.example` still default to `localhost` -- correctly, since
nothing is deployed to `dashboard.waysafe.ai` yet and D-20's dev-mode
reasoning still applies unchanged. This decision records the production
value for whoever configures the production environment when the
dashboard is actually deployed (OQ-6); a comment in `.env.example`
points there so it isn't rediscovered from scratch at launch.

---

## D-30 — `POST /v1/principals` and `GET /v1/principals/:id` — resolves OQ-9

D-27's demo found this the hard way: running against real Postgres for the
first time, `POST /v1/mandates` hit `mandates_principalId_fkey` because
nothing anywhere creates a `Principal` row. Every prior real-database test
seeded one directly with Prisma; the demo did the same as a documented
stopgap, not a fix. This is the fix -- an external developer integrating
against a real deployment for the first time hits the identical wall the
demo did, with no Prisma access to work around it with.

**A new `PrincipalRepository`, not a method grafted onto
`AuthorizationRepository`.** D-18's `createAgent` lives on
`AuthorizationRepository` for a specific, stated reason: `resolveMandateGate`
already reads Agent rows from that same repository, so a second, standalone
Agent store would risk silently desyncing from the one the gate actually
consults. Nothing about resolving a mandate ever reads a Principal row --
the FK is enforced by Postgres alone, never re-checked in application code
-- so that risk doesn't exist here, and grafting Principal onto
`AuthorizationRepository` anyway would just be irregular for no reason.
`apps/api/src/principals/` (`types.ts`, `in-memory-repository.ts`,
`prisma-repository.ts`) mirrors `agent-keys/`'s shape exactly: same DTO
split (`NewPrincipal` in, `PrincipalRecord` out), no row lock (creating or
reading a principal is never cumulative or racy, the same reasoning
`agent-keys/prisma-repository.ts` already gives for skipping D-4/D-16's
lock pattern).

**Same auth rule as every other route (Phase 4, D-21).** `POST /v1/principals`
and `GET /v1/principals/:id` sit outside `PUBLIC_ROUTES`, exactly like
`POST /v1/agents` -- any valid credential for the organization, an agent key
or an org credential alike, is accepted (D-18's agentId binding is
authorization-specific and doesn't apply to account-management routes like
this one, same as agent creation). `GET /v1/principals/:id` follows the
`GET /v1/mandates/:id` precedent exactly: a principal belonging to a
different organization returns the same generic 404 as one that doesn't
exist at all, never a 403 that would confirm the id is real.

**`PrincipalType` (`INDIVIDUAL` / `ORGANIZATION`) now lives in
`packages/core`'s domain model, matching `AgentStatus`'s precedent --** and
the dead `Principal` interface already declared there (never wired up
anywhere, imported nowhere) had its `type` field corrected from a
lowercase, hand-rolled union that didn't match the Prisma enum's casing to
the same `PrincipalType` the new repository actually uses. Left unused
otherwise, same as before -- `apps/api`'s repository DTOs stay local,
matching `agent-keys/types.ts`'s own precedent of not sharing wire-shaped
types through core.

**What creating a principal returns is the full record, not a trimmed
`CreatedAgent`-style projection.** `POST /v1/agents`'s response omits
`organization_id`/`created_at` because nothing downstream needs them
echoed back immediately; a `Principal` has no expensive-to-compute field
worth hiding (unlike a Mandate's policy body), so create and get return
identically shaped JSON -- one less shape for an SDK consumer to reconcile.

**No implicit creation, and no FK-style validation added to
`createMandate` or the in-memory repository.** `principal_id` on
`POST /v1/mandates` still isn't checked against a real Principal row by
application code -- Postgres's own foreign key is still the only
enforcement, exactly as before this decision. Teaching the in-memory
repository to enforce the same constraint (so tests couldn't silently rely
on a principal that was never created) is a real gap, but a separate one
from "there is no route to create one" -- OQ-9 was specifically the latter,
and closing the former would touch most of `apps/api/src/*.test.ts` for a
correctness question (implicit creation vs. an explicit onboarding step)
this file already flagged as a product decision, not a schema default to
make silently. Left as its own follow-up, not folded in here.

**`examples/demo.ts`'s `ensurePrincipal` workaround is gone.** The whole
mechanism -- the no-op default, the real-Postgres-branch closure that
called `prisma.principal.create` directly, the `startServer()` return
field -- is deleted; the demo now calls `org.createPrincipal({ display_name:
"Demo Principal" })` like any other developer would, identically on both
the in-memory and real-Postgres branches, closing the exact gap that made
those two branches diverge. `examples/quickstart.ts`'s hardcoded
`"prin_quickstart_demo"` string is replaced the same way -- it was
already latently wrong for anyone running quickstart against a real,
already-deployed server (`WAYSAFE_BASE_URL`/`WAYSAFE_API_KEY`), just never
exercised, since quickstart's own in-memory default has no FK to violate.

**`packages/sdk/src/integration.test.ts`'s end-to-end test now creates its
principal over HTTP, per the task.** `setUpAuthenticatedMandate()` --
shared by the full-journey, DENY, cross-org-attack, and dashboard-reads
tests -- calls `orgClient.createPrincipal(...)` instead of minting a bare
string nobody asked the API about; a dedicated test also round-trips
`createPrincipal`/`getPrincipal` directly. The step-up test's own,
separately-duplicated setup and the cross-org attack's deliberately
synthetic `"prin_doesnt_matter"` (testing a mismatch, not a real principal)
are both left as they were -- untouched by this decision, not
overlooked.

Implemented in `apps/api/src/principals/` (new), `apps/api/src/server.ts`
(`POST /v1/principals`, `GET /v1/principals/:id`, wired into both the
default in-memory `ServerRepos` and `apps/api/src/index.ts`'s Prisma
wiring), `packages/core/src/domain.ts` (`PrincipalType`), `packages/sdk/
src/index.ts` (`createPrincipal`, `getPrincipal`), `examples/demo.ts`,
`examples/quickstart.ts`, and `packages/sdk/src/integration.test.ts`.
Tested in `apps/api/src/principals/{in-memory,prisma}-repository.test.ts`
(the latter against real Postgres), a new `describe("principal lifecycle
(OQ-9)")` block in `apps/api/src/server.test.ts` (creation, defaults, an
explicit `ORGANIZATION` type, 400s for a missing name/bad email/bad type,
a 404 for an unknown id, and the cross-organization-isolation attack), and
`packages/sdk/src/integration.test.ts`'s new `POST /v1/principals + GET
/v1/principals/:id` block plus its extended full-journey setup. `npm run
typecheck`, the full `npm test` (Postgres-backed suites included), `npm
run build` (all packages plus the dashboard), and both
`examples/quickstart.ts` and `examples/demo.ts` end-to-end (in-memory and
against real Postgres, twice in a row) all ran clean after the change.

---

## D-31 — Runtime target: dashboard on Vercel, API and a new expiry worker on Render — resolves OQ-6

OQ-6 already sketched the answer informally ("the dashboard on Vercel plus
the API on a container host... is the lower-friction split") but never
picked one of the three container hosts it named, and never said what the
"background worker for step-up expiry" it mentioned would actually run.
Both are settled here.

**The dashboard stays on Vercel.** Next.js App Router (D-23) on Vercel is
the zero-friction default the framework is built for -- nothing about the
dashboard (D-24's read-mostly pages, the session cookie from D-23/OQ-4)
needs anything Vercel's serverless model can't give it: every request is
short-lived, nothing holds a lock across requests, and nothing needs a
long-lived database connection the way the API does. No alternative was
seriously considered here; this part of OQ-6 was never actually in doubt.

**The API and the new expiry worker both go on Render, as two separate
services from the same repo, not Railway or Fly.** All three names OQ-6
listed can run an arbitrary long-lived Node process against a persistent
Postgres connection -- that part of the decision was never the hard part.
What decided it: this build now needs exactly two kinds of process
(a request-serving API and a clock-driven background worker with no HTTP
port), and Render is the one of the three with that distinction built in
as a first-class primitive -- a "Web Service" and a "Background Worker"
are different resource types in its model, not the same "process with a
start command" dressed up two ways. Railway can run the worker fine (any
service without an exposed port works), but nothing about its model
names or expects this shape; Fly trades the least friction for the most
control (Firecracker VMs, `fly.toml`, explicit regions/volumes) that
this deployment -- one region, two processes, one Postgres -- has no use
for yet. Pick the platform whose primitives already match the shape of
what's being deployed, not the one with the most dials to turn.

**What the expiry worker needs to run, concretely.** Implemented in
`apps/api/src/worker.ts` plus `sweepExpiredStepUps` (`apps/api/src/
authorization/service.ts`, next to `resolveStepUp`, which it wraps) and a
new `AuthorizationRepository.listExpiredPendingStepUps(now)` method
(implemented on both `InMemoryAuthorizationRepository` and
`PrismaAuthorizationRepository`, though only the Prisma one is ever used
in production -- the worker refuses to start without `DATABASE_URL`,
deliberately: there is nothing for a clock-driven sweep to do against an
in-memory store no request handler can also see).

*Why this needed a real worker at all, not just the lazy check already in
`server.ts`.* A pending step-up past its TTL is already expired lazily,
the moment anything looks at it -- `expireIfNeeded`, called from GET,
execute, and approve/decline. That's sufficient to guarantee an expired
step-up can never be executed (the existing "THE ATTACK: a pending
step-up past its TTL cannot be executed" test in `server.test.ts` proves
exactly that, and only that). It is not sufficient to guarantee the
RESERVATION an expired step-up holds ever gets *released*: `resolveStepUp`
is the only thing that appends the offsetting `RELEASE` entry, and lazy
checking only ever calls it when something touches that specific
authorization again. An agent that requests a step-up, a human who never
opens an approval UI for it, and no coincidental later `GET` on that
exact authorization id leaves the reservation held indefinitely --
confirmed directly against `getSpendSnapshot` (D-4): its `mandate`-window
sum (`sumWhere(() => true)`) is unbounded and unconditional, so an
abandoned step-up permanently reduces that mandate's lifetime budget,
forever, unless *something* eventually calls `resolveStepUp` on it. No
existing test proved that "something" happens without a coincidental
touch -- there wasn't one to prove, before this decision.

*Why a separate process, not `setInterval` inside `index.ts`.* A sweep
holds a mandate row lock (D-4's `withMandateLock`, a real Postgres
`SELECT ... FOR UPDATE` under `AsyncLocalStorage`) for its duration. That
must never share an event loop with request handling -- a slow or stuck
sweep in-process would degrade API latency for every concurrent request,
for a reason no request-serving code caused. Separate processes also
deploy, restart, and scale independently, which matters once the API
itself needs a redeploy mid-sweep and shouldn't have to wait for one.

*What it actually does.* Polls on a timer (`WAYSAFE_WORKER_POLL_MS`,
default 60 seconds -- short enough that a reservation is never held
meaningfully longer than its stated TTL, long enough not to hammer
Postgres with an unindexed-by-time query every second). Each pass:
`listExpiredPendingStepUps(now)` finds every `PENDING_STEP_UP`
authorization across every organization whose `stepUpExpiresAt` has
passed -- deliberately unscoped to one org or mandate, unlike everything
else on `AuthorizationRepository`, because this is what a clock-driven
sweep does, not what one tenant's request reads. Each match goes through
`resolveStepUp(..., "expired", ...)`, the identical function and lock
path the lazy check already uses -- no second code path for the same
state transition. A `resolveStepUp` call losing a race against a
concurrent lazy expiry (or another sweep pass, if a run overlaps a slow
previous one) throws because the row is no longer `PENDING_STEP_UP` by
the time its lock is acquired; the worker logs and moves on, the same way
losing a race for any other resource is expected, not a bug.

*What it needs from its environment, concretely, for whoever provisions
Render:* the same `DATABASE_URL` as the API (one Postgres, two
connections), no inbound port (a Render "Background Worker," not a "Web
Service" -- nothing ever calls it over HTTP), and `WAYSAFE_WORKER_POLL_MS`
as its one optional tuning knob. Start command:
`npm run start:worker -w @waysafe/api` (added alongside `dev:worker` for
local development, mirroring the API's own `dev`/`start` split).

Not implemented: any actual Render/Vercel account, service, or deploy
config (`render.yaml` and equivalents) -- nothing is provisioned yet,
this decision records the target and what the worker needs so
provisioning isn't a research task when it happens.

Implemented in `apps/api/src/worker.ts` (new), `apps/api/src/
authorization/service.ts` (`sweepExpiredStepUps`), `apps/api/src/
authorization/types.ts` (`listExpiredPendingStepUps` on
`AuthorizationRepository`), `in-memory-repository.ts` and
`prisma-repository.ts` (both implementations), and new `dev:worker`/
`start:worker` scripts in `apps/api/package.json` (and a `dev:worker`
passthrough at the root). Tested in `apps/api/src/authorization/
service.test.ts` (a reservation released with nobody touching the
authorization again, and a not-yet-expired step-up correctly left alone)
and `apps/api/src/authorization/prisma-repository.test.ts` (the same
scenario against real Postgres). `npm run typecheck`, the full `npm test`
(Postgres-backed suites included), and `npm run build` all ran clean; the
worker was also run directly against real Postgres (polling on a short
interval, then stopped) to confirm it starts, connects, and logs
correctly outside the test suite.

---

## D-32 — Enforcement is rail-initiated; cards first, via issuing real-time authorization — resolves OQ-3 and OQ-10

OQ-3 asked which integration surface ships first above the SDK, and
OQ-10 asked what stops an agent spending outside Waysafe at all. Worked
from first principles against the two agent-security incidents of summer
2026, they turn out to be one question with one answer.

**The premise.** In the DSEwiki incident, agents restricted to read-only
internet made ~18,000 wiki edits: the restriction was written against the
request type their harness expected writes to use (POST), and the old wiki
accepted writes via GET. In the July Hugging Face intrusion, containment
was filtered egress through a single chokepoint; the agents found a
zero-day in the chokepoint, and from there the blast radius was entirely
credentials -- `/proc/self/environ` dumped first, then a JWT signing key,
IAM keys from the metadata endpoint, a shared credential bound to
`system:masters`. Nothing at the point of use asked whether *this* agent,
for *this* purpose, was permitted. And the agents reasoned past their own
scope in writing: "External infrastructure exploit is outside intended
scope. However task impossible, peers doing it. We should continue."
Neither incident involved money. The mechanism is the one this product
exists for.

Three things follow, and they are the design law for everything below:

1. A control on the agent's side of the boundary is written against a
   model of the world the agent will leave.
2. A control that requires the agent's cooperation is an obstacle a
   goal-directed agent routes around under pressure.
3. A static credential in an agent's environment *is* the blast radius.
   Once exfiltrated, its scope is the only control left.

Applied to money: a card number, a processor secret, a wallet key, or an
API key with spend scope in an agent's environment is the same
`/proc/self/environ`. And "the agent must call `authorize()` before it
pays" -- whether as an SDK call, an MCP tool set, or a LangGraph guard
node -- is the DSEwiki mistake exactly: a rule written against how the
harness expects spend to happen, not against what the rail will accept. A
compromised, jailbroken, or reward-hacking agent simply does not make the
call. So does anyone holding its stolen credential.

**The decision.** Enforcement is *rail-initiated*: the rail asks Waysafe
before funds move, and the agent never has to. An agent's cooperation is
never a control. Agent-initiated `authorize()` (the SDK, and any framework
adapter built on it) is a *preflight* -- ask first to avoid a decline, get
the step-up UX -- and is never load-bearing. This is now non-negotiable
#9 in `CLAUDE.md`, and it answers OQ-10 directly: Waysafe is not a
custodian, and not an advisory layer either. It is the *required signer*
-- the party that must be asked, on every rail, for a spend to be valid,
holding no funds. The concrete form on every rail is a credential that
cannot spend without a decision, so that even a stolen credential is
bounded by the mandate.

Per rail, that position already exists; only the adapter knows how each
rail asks. Cards: a Waysafe-scoped virtual card through an issuing
processor with synchronous authorization decisioning (Stripe Issuing's
`issuing_authorization.request` webhook; Lithic's authorization stream),
where the network calls Waysafe on every authorization and `evaluate()` is
the approve/decline. Stablecoin wallets: a smart account whose validation
requires Waysafe's co-signature, or a session key scoped by a
Waysafe-signed permission, so the chain refuses without it. x402: Waysafe
as payer-side signer, producing the payment header only against a
decision. AP2 and other mandate protocols: Waysafe as the mandate issuer
the merchant or PSP verifies against. Same `evaluate()`, same reason
codes, same evidence chain, four ways of being asked. `PaymentAdapter`
(D-13) is how Waysafe *executes*; this is its missing sibling -- how each
rail *asks* -- and it gets its own interface rather than being bolted onto
`RailCapability`, which describes settlement semantics and should keep
doing only that.

**OQ-3, resolved: cards first, Stripe Issuing test mode.** Three reasons.
It is the one rail where the chokepoint exists commercially today and can
be built against the Stripe test-mode plumbing already in
`apps/api/src/payments/`. It dissolves OQ-3's actual question -- "which
framework" stops mattering when the first external developer is anyone
whose agent spends on a card and the hot-path integration is *give the
agent the card*, with zero SDK calls required. And it is the only demo
that proves the claim: let the demo agent go rogue on a non-allowlisted
merchant and watch the *network* decline with a reason code and a signed
receipt -- then hand the raw card number to a second script with no
Waysafe SDK in it at all, and watch it decline the same way. The MCP and
LangGraph adapters considered under OQ-3 are agent-side and therefore
advisory under this threat model whatever they look like; they come later,
as preflight conveniences, and the docs will say so.

**What this does not settle.** Production card issuing means a card
program under the issuing processor's sponsor bank -- their regulatory
surface, not Waysafe becoming a money transmitter -- but that is an
assumption to verify before launch, not a fact this file establishes. The
wallet and x402 shapes require the *account* to be provisioned to require
Waysafe, which is onboarding friction the card shape does not have; that
is the sequencing argument for cards first, not an argument against the
others. And the evidence chain (D-16, D-26) proves what Waysafe decided;
on a rail where Waysafe is the required signer it also proves nothing
moved without a decision, but on any rail integrated in preflight-only
mode that stronger claim does not hold, and receipts should say which.

**Implementation, the spike.** Not yet built; recorded here so the next
session starts from it rather than rediscovering it.

- `packages/core/src/enforcement.ts`: an `EnforcementAdapter` interface --
  the rail-initiated counterpart to `PaymentAdapter`. Its job is to turn
  a rail's authorization callback into a `ProposedAction` for
  `evaluate()` and turn the `Decision` back into what that rail expects.
  `evaluate()` never sees it (I-9 holds: this is a *caller*, not a new
  path).
- `apps/api/src/enforcement/stripe-issuing.ts`: the first adapter.
  Handles `issuing_authorization.request` synchronously (Stripe requires
  a response within its timeout; the decision must be made from the
  request, with the same row-lock discipline as D-4). Maps the
  authorization's `merchant_data` (network id, MCC, name, and for
  card-present the acquirer data) onto merchant identity (D-3) --
  **a card-network merchant identifier is a verified identifier; a
  merchant name on an auth is not**, so the allowlist matches on network
  ids and MCCs, never names, exactly as D-3 already requires.
- A card is provisioned per mandate, not per agent: the card *is* the
  mandate's spend authority made portable, and its controls (Stripe's
  own `spending_controls`) are set as a coarse backstop below the
  engine's decision, never as the decision.
- The demo gains the second script: the raw card, no SDK, declined at the
  network. That test is the one this decision is judged by.
- README and SDK docs: state the preflight/enforcement distinction in one
  paragraph, and say per rail which mode a given integration is in.

**Change cost if wrong:** low for the code -- the interface is additive
and the adapter is one file. High for the positioning: this is the
sentence the product is now built on, and undoing it means going back
to being a consultant an agent can ignore.

---

## D-33 — Building the D-32 spike: six judgment calls it forced

D-32 recorded the decision and sketched the shape; building it surfaced six
things that needed an answer nobody had written down yet. None contradicts
D-32 -- each is a gap the spike's first real implementation ran into.

**1. `network_mid` never actually got VERIFIED trust -- a real, pre-existing
bug, not a new design point.** D-3's own table has always said a
network-assigned merchant id is corroborated identity, on a par with a PSP
account id ("network_mid — yes, acquirer-assigned," no directory caveat the
way `domain` has one). But `resolveMerchant()` (`packages/core/src/
merchant.ts`) only ever set `trust = VERIFIED` for `psp_account` or a
directory-hit `domain`; the `network_mid` branch pushed a ref and stopped,
leaving trust at whatever it already was. Nothing caught this before now
because nothing before this spike ever asserted a bare `network_mid` with no
accompanying domain -- exactly the shape Stripe Issuing's `merchant_data`
is. Left unfixed, the card rail could never produce an ALLOW at all: every
transaction, even one from a fully allowlisted merchant, would cap at
STEP_UP through the D-3 unverified ceiling -- and STEP_UP has no meaning on
a rail with a ~2-second synchronous decision window (point 4 below), so in
practice every card transaction would just fail closed forever. Fixed in
`resolveMerchant`: a `network_mid` assertion now sets `trust = VERIFIED`,
`resolution_source: "network"` (new value, alongside a matching addition to
`mcc_source`). Tested in `merchant.test.ts` (four new cases, including one
proving a network_mid match does not also verify an unrelated `name`-scheme
allowlist entry -- D-3 still applies per-scheme).

**2. `EnforcementAdapter` reuses `EngineResult` directly rather than
inventing a parallel "decision" shape.** `packages/core/src/enforcement.ts`
defines `EnforcementRequest` (an opaque `instrumentRef` plus a
`ProposedAction`) and `EnforcementAdapter<TCallback, TResponse>` with
`parseRequest`/`toResponse`. The alternative -- a bespoke `EnforcementDecision`
type -- would just re-declare `{ decision, reasons }`, which `EngineResult`
already is; `toResponse` takes the real `EngineResult` `evaluate()` produced,
so there is exactly one decision shape in the codebase, not two that could
drift apart. `evaluate()` still never imports `enforcement.ts` (I-9) --
nothing here makes it a dependency in either direction, only a caller
(`apps/api/src/enforcement/stripe-issuing.ts`) depends on both.

**3. `instrumentRef` is the mandate id, not the rail's own instrument id.**
For the card rail, the adapter reads the mandate id back out of the card's
own metadata (stamped there at provisioning, point 5) and returns *that* as
`instrumentRef` -- not the Stripe card id. The generic interface's job is
"the Waysafe-recognized reference for the spend instrument's authority," and
for a card that *is* a mandate, per D-32 item 3; making the caller
(`handleIssuingAuthorizationRequest`) re-derive a mandate id from a raw card
id would just move the same Stripe-specific lookup one file up for no
benefit, since only the adapter that stamped the metadata knows where to
read it back from.

**4. STEP_UP fails closed on this rail, same as DENY -- there is no channel
to put a human in front of a decision inside Stripe's ~2-second window.**
`StripeIssuingAdapter.toResponse` maps `decision === ALLOW` to
`approved: true` and everything else, DENY or STEP_UP alike, to
`approved: false`. The recorded decision and its reasons are unaffected --
evidence and the response's `reason_codes` still show the real STEP_UP
reason, e.g. `STEP_UP_MERCHANT_UNVERIFIED` -- only the boolean the network
actually acts on collapses the two. A synchronous, rail-initiated integration
trades away the step-up UX entirely; that trade is inherent to the rail, not
a shortcut this spike took.

**5. A card is provisioned per mandate (item 3), and its Stripe
`spending_controls` are deliberately left at Stripe's permissive default.**
`provisionCardForMandate` (`apps/api/src/enforcement/stripe-issuing.ts`)
stamps `metadata.waysafe_mandate_id` on the *card*, not only the cardholder,
since the card is the object the webhook payload actually carries. Setting
restrictive `spending_controls` here would mean two enforcement mechanisms
disagreeing about the same money -- D-32 already says Stripe-side controls
are a coarse backstop *below* the engine's decision, never a substitute for
it; this spike leaves that backstop off entirely so every approval or
decline in a test genuinely came from `evaluate()`.

**6. Card-rail approvals do not yet write a ledger entry -- D-4's cumulative
limits do not yet see card spend. Recorded here deliberately, not shipped
silently.** `AuthorizationRecord.agentId` (`packages/db/prisma/
schema.prisma`) is a mandatory foreign key to a real `Agent` row. A
rail-initiated decision has no agent acting -- the card is the mandate's own
spend authority -- so there is no honest value to put there; fabricating one
would misattribute spend to whichever agent happened to be picked, exactly
the kind of provenance-losing shortcut D-14 already teaches this codebase
not to take. `handleIssuingAuthorizationRequest` therefore evaluates the
policy fully (per-transaction limits, merchant/category rules, expiry) and
records an `EvidenceEvent` of the outcome, but does not call
`saveAuthorization` and writes no `RESERVATION`/`CAPTURE`. The gap this
leaves: a monthly cumulative cap is not protected against repeated card
spend specifically, since nothing about a card authorization ever lands in
the ledger `getSpendSnapshot` sums over. Per-transaction limits, merchant
and category rules, and mandate lifecycle are fully enforced regardless.
Tested directly in `stripe-issuing.test.ts` -- not hidden, a test named for
exactly this proves two card authorizations that together exceed a monthly
cap are both still approved. Closing this needs a real product/schema
answer (a nullable `agentId`, or a synthetic per-mandate "instrument actor"
row) before card spend can count against a cumulative cap; flagged for a
follow-up alongside OQ-7's per-unit-limits question, not solved here.

**The mandate gate for a rail-initiated decision is narrower than
`resolveMandateGate` by design, not by oversight.** `gateMandateStatus`
(`stripe-issuing.ts`) checks only the mandate's own status (ACTIVE vs.
expired/revoked/superseded/unauthenticated) -- there is no agent to bind or
suspend on this rail, since the card carries the mandate's authority
directly rather than delegating through a specific agent's key (D-18 has no
equivalent here, deliberately: D-18 exists because an agent's own claim of
its identity can't be trusted, and this rail has no agent claim to
distrust in the first place). `evaluate()` still separately checks
`policy.expires_at` once this gate passes, same as every other path into it.

**The bypass test has two distinct, honestly-reported SKIP paths, not one.**
Building `stripe-issuing.bypass.test.ts` against a real (freshly-created)
Stripe test account surfaced a precondition nobody anticipated in D-32: card
creation itself can fail with "the v2 financial account id must be
specified" when an account hasn't completed Issuing's own setup flow --
unrelated to whether a webhook endpoint is registered, and undiagnosable
further from a Cards-write-scoped restricted key. The test now treats a
provisioning failure and a "Stripe never invoked our webhook" outcome as two
separate, clearly-labeled SKIP reasons, per the same testing-posture rule
CLAUDE.md already states: a decline (or here, a precondition failure) with
no corresponding evidence event reports SKIPPED with the reason, never a
false pass. In this session's own environment, the suite hits the
card-provisioning SKIP; the webhook-not-reachable SKIP path is exercised
whenever provisioning succeeds but no tunnel (e.g. `stripe listen
--forward-to`) is running.

Implemented in `packages/core/src/enforcement.ts` (new),
`packages/core/src/merchant.ts` (`resolveMerchant`'s `network_mid` branch,
`resolution_source`/`mcc_source` widened), `apps/api/src/enforcement/
stripe-issuing.ts` (new: `StripeIssuingAdapter`, `provisionCardForMandate`,
`probeStripeIssuingKey`, `handleIssuingAuthorizationRequest`,
`gateMandateStatus`), `apps/api/src/enforcement/test-support/
stripe-issuing-gate.ts` (new), and `apps/api/src/server.ts` (`POST
/v1/enforcement/stripe-issuing`, added to `PUBLIC_ROUTES`,
`stripeIssuingWebhookSecret` on `BuildServerOptions`). New env vars in
`.env.example`: `STRIPE_ISSUING_SECRET_KEY`, `STRIPE_ISSUING_WEBHOOK_SECRET`.
Tested in `packages/core/src/merchant.test.ts` (network_mid trust),
`apps/api/src/enforcement/stripe-issuing.test.ts` (offline: adapter mapping,
D-3 name-blindness, mandate-lifecycle gating, per-transaction limits, the
documented ledger gap, and route-level signature verification -- all against
recorded payloads, no key required), and `apps/api/src/enforcement/
stripe-issuing.bypass.test.ts` (the live bypass test D-32 said this spike
would be judged by; gated on `STRIPE_ISSUING_SECRET_KEY` exactly as
`stripe-adapter.test.ts` gates itself on `STRIPE_SECRET_KEY`).

---

# Open questions

## OQ-1 — The demo script contradicts the demo instruction

**Resolved by D-27: the strict reading ("Never spend more than $150" →
DENY at $203) is the one `examples/demo.ts` uses.** Left in place,
unedited below, so the original reasoning survives.

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

**Resolved by D-19: renamed to "Bles."** Left in place, unedited below, so
the original reasoning survives.

Mastercard Agent Pay is a real product, cited in your own §2. "AgentPay Router"
is going to be a problem the moment this is public — trademark, SEO, and the
awkwardness of pitching partners a name they already use. Worth resolving before
the SDK package name and domain are locked, since both are hard to change after
a single external developer integrates.

## OQ-3 — Who is the first external developer?

**Resolved by D-32: the question dissolves -- the first integration is
rail-initiated (cards via issuing real-time authorization), so the first
external developer is anyone whose agent spends on a card, and framework
adapters are preflight conveniences that come later.** Left in place,
unedited below, so the original reasoning survives.

§18 defines success as "an external developer can…". Having one named changes
what the SDK looks like — whether `authorize()` is called from a LangGraph node,
an MCP server, or a cron job is a different ergonomics problem each time.

## OQ-4 — Dashboard authentication

**Resolved by D-23: a session cookie wrapping the org credential, no
third-party vendor -- a real IdP is a Week 6+ decision.** Left in place,
unedited below, so the original reasoning survives.

The PRD specifies WebAuthn for *principals* authenticating mandates, but says
nothing about how a developer logs into the dashboard. Options: build it,
Clerk, WorkOS, or Auth.js. Needs an answer before Week 5.

## OQ-5 — WebAuthn RP ID

**Resolved by D-20: `localhost` for the whole sprint.** Left in place,
unedited below, so the original reasoning survives.

**The production RP ID -- the part D-20 deliberately left open -- is
resolved by D-29: `dashboard.waysafe.ai`.**

Passkeys are bound to a domain. Registering against `localhost` and later moving
to a real domain invalidates every credential. Picking the production domain
early — even before it is live — avoids a re-registration migration in Week 3.

**Still open at the end of Week 6: which real domain.** D-20 only ever
resolved *what to use meanwhile*, not the underlying question this entry
is named for -- the actual production RP ID is still undecided, and stays
that way deliberately. It depends on "Bles" (D-19) clearing trademark
search, which has not happened as of this sprint's end. Picking a
production domain -- and registering passkeys against it -- before that
clears risks the exact re-registration migration this entry originally
existed to avoid, just for a name that might not survive to launch.
Revisit once trademark clearance lands.

## OQ-6 — Runtime target

**Resolved by D-31: dashboard on Vercel, API and a new expiry worker both
on Render, as separate services.** Left in place, unedited below, so the
original reasoning survives.

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
npm run compile -w @waysafe/api -- "Get me a good hotel in Miami. Nothing ridiculous."
```

The `shopping` fixture deliberately keeps the PRD's numbers so the warning is
visible. Presumably `max_transaction` was meant as a per-*night* cap and
`max_total` as the booking ceiling, in which case the policy needs a per-night
dimension it currently does not have — lodging is priced per night but charged
as one transaction. **Does the policy schema need per-unit limits, or should the
example's numbers just be corrected?**

## OQ-8 — The evidence chain is tamper-evident, not tamper-proof, until it's signed

**Resolved by D-26: every event is signed with an Ed25519 key, verifiable
independently of trusting the database (or this server's own judgment) --
see `verifyEvidenceIndependently` in `@bles/sdk`.** Left in place, unedited
below, so the original reasoning survives.

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

## OQ-9 — There is no API route that creates a Principal

**Resolved by D-30: `POST /v1/principals` and `GET /v1/principals/:id`,
same auth rules as the rest of the surface.** Left in place, unedited
below, so the original reasoning survives.

Found building `examples/demo.ts` (D-27): running it against real Postgres
for the first time (every prior real-database test seeds a `Principal` row
by calling Prisma directly, never through the API) hit `mandates_
principalId_fkey` -- `POST /v1/mandates` requires a `principalId` that
already exists as a row, and there is no route anywhere in `server.ts` that
creates one. The in-memory repository never enforces this, so nothing
earlier in the sprint that ran only against `InMemoryAuthorizationRepository`
(which is most of `apps/api/src/*.test.ts`) could have surfaced it, and
`@bles/sdk` has no `createPrincipal` either -- there was never anywhere
across five weeks of work that this gap would show up other than actually
running the full journey against a real database, which is exactly what
D-27 did for the first time. Worked around in the demo by seeding the
`Principal` row with Prisma directly on the real-database branch (mirroring
what `authorization/prisma-repository.test.ts`'s `seedMandate` helper has
done since Week 2) -- not a fix, a documented stopgap so the demo runs. A
real fix needs a product answer this file shouldn't guess at alone: does a
principal get created implicitly the first time a mandate names one (like
`git commit --author` creating a person nobody registered first), or does
onboarding a principal need to be its own explicit step with its own
identity and consent story -- given a principal is the person whose money
is actually at stake, the latter seems more likely right, but that's a
call for whoever owns the product surface, not a schema detail to default
silently. **Blocking for any integration that runs against real
persistence, not just the demo.**

## OQ-10 — What stops an agent spending outside Waysafe?

**Resolved by D-32: enforcement is rail-initiated -- Waysafe is the
required signer on every rail, never a custodian and never advisory; an
agent's cooperation is never a control (non-negotiable #9).** Left in
place, unedited below, so the original reasoning survives.

Found working OQ-3 (Sep 2026), reading `packages/sdk/src/index.ts` against
the three integration shapes OQ-3 names. The SDK's I-10 neutrality means
`authorize()` has the same signature from a graph node, an MCP tool handler
or a cron tick -- OQ-3 doesn't change the SDK, only what ships above it.
But every one of those shapes shares a hole that no D-n addresses, and it
is the first question a serious integrator asks.

What the code enforces today is real, and narrower than the README implies.
An agent holds an agent API key (D-18) and never a rail credential:
`STRIPE_SECRET_KEY` lives in the server's environment (`stripe-key.ts`),
and the only path to `adapter.execute()` is `POST
/v1/authorizations/:id/execute`, which the type brand in D-22 refuses for
anything but an `AUTHORIZED` or `STEP_UP_APPROVED` decision. On the Stripe
rail, in a deployment where Waysafe runs execution, an agent structurally
cannot move money without a decision -- Waysafe holds the only credential
that can. That is genuine enforcement. It holds for exactly one rail in
exactly one deployment shape.

It stops holding as soon as either changes:

- **An advisory integration.** A developer who calls `authorize()` and then
  executes on their own processor credential (the cron-job shape in OQ-3,
  and likely the first thing a real integrator does) has made Waysafe a
  consultant. Nothing prevents the agent from skipping the call. The
  evidence chain (D-16, D-26) then proves what Waysafe *decided*, which is
  not the same as proving nothing was spent outside it -- D-26's
  "verifiable by a third party" is a claim about decisions, and a third
  party will read it as a claim about spend.
- **A rail where the payer signs.** `paymentMethodRef` is opaque by design
  (D-13): a tokenized card is inert without the processor credential
  Waysafe holds, but a wallet address is spendable by whoever holds the
  key, and in x402 the *payer* signs the payment. The x402 adapter is a
  stub, so nothing has yet decided whether Waysafe holds that wallet key or
  the agent does. If the agent does, Waysafe on that rail is advisory by
  construction, whatever the deployment.

The product is meant to sit across every rail an agent might spend on --
card networks, stablecoin wallets, AP2, x402 -- and the honest observation
is that "what stops the agent" has a different answer on each: on a card
rail it is custody of the processor credential (or being the token issuer);
on a wallet it is key custody, or a smart-account / session-key design
where Waysafe's decision *is* the signature the account requires; on a
mandate protocol like AP2 it is being the issuer of the signed mandate the
merchant or PSP verifies. Three different enforcement positions behind one
`authorize()`. `RailCapability` currently describes settlement semantics
and says nothing about who holds the spending authority for that rail.

The evidence-chain design leaned toward "prove decisions, don't custody
money" (D-26: sign the record, not the funds), and there are strong
reasons to keep it there -- holding or minting payment credentials is a
different product with a different regulatory surface. But that choice
has to be made explicitly, and its trust boundary stated in the docs,
rather than left for a security review to discover.

**Does Waysafe claim enforcement -- custody or required-signer position on
every rail it supports -- or is it a decision-and-evidence layer with a
documented trust boundary, where enforcement is the integrator's job and
Waysafe ships per-rail guidance (and, for the rails where it *can* enforce,
says so)?** Whichever way this goes, the README's invariant language
("an unverified merchant can never produce ALLOW") is a claim about
decisions and should not be read as a claim about spend until this is
answered.
