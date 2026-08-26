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

## D-19 — The product is renamed from "AgentPay Router" to "Bles"

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

**Resolved by D-19: renamed to "Bles."** Left in place, unedited below, so
the original reasoning survives.

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

**Resolved by D-23: a session cookie wrapping the org credential, no
third-party vendor -- a real IdP is a Week 6+ decision.** Left in place,
unedited below, so the original reasoning survives.

The PRD specifies WebAuthn for *principals* authenticating mandates, but says
nothing about how a developer logs into the dashboard. Options: build it,
Clerk, WorkOS, or Auth.js. Needs an answer before Week 5.

## OQ-5 — WebAuthn RP ID

**Resolved by D-20: `localhost` for the whole sprint.** Left in place,
unedited below, so the original reasoning survives.

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
