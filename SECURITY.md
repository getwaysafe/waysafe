# Security Policy

## Reporting a vulnerability

Email **samhf718@gmail.com**. Include what you found, how to reproduce it,
and its impact as you understand it. You'll get an acknowledgment within
**72 hours**.

Please don't open a public GitHub issue for a security finding before it's
been triaged — email first.

## Scope

This is **pre-production software**. There is no production deployment, and
no real money has ever moved through it — it runs against Stripe test mode
and the Polygon Amoy testnet only. See the README's Status section and
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) before assuming anything here
protects real funds today.

**There is no bug bounty.** Reports are welcome and will be acknowledged and
read, but there is no payment program behind this policy.

## Findings from adversarial review, 2026-09-27

An independent adversarial review of commit `387958a` found six
vulnerabilities. All six are now closed. Each is listed here with the
decision-log entry that records the fix, and each shipped as its own commit
with the attack written as a failing-then-passing test first.

| # | Finding | Status |
|---|---|---|
| 1 | Agent credentials could mint API keys for any agent, manufacturing a second authority and reopening the step-up self-approval hole | **Fixed** — D-64 |
| 2 | An authentication challenge could be answered with a registration response, enrolling an attacker's passkey for a victim principal | **Fixed** — D-66 |
| 3 | Merchant-supplied `decimals` controlled atomic-to-cents conversion, so a hostile merchant could have a large transfer evaluated as ~0 — and the signed evidence chain recorded $0.00 while real value moved | **Fixed** — D-68 |
| 4 | A directory-verified domain laundered an unverified PSP account id in the same request | **Fixed** — D-69 |
| 5 | With `reserve_on_step_up: false`, an approval never consumed the original mandate's budget, and the release landed on the wrong mandate | **Fixed** — D-71, with D-73 |
| 6 | A reservation made before a period boundary was released against the next period, driving a ledger window negative | **Fixed** — D-72, with D-74 |

**On D-59.** An earlier version of this file said the step-up
self-approval defect was closed by D-62. That was true when written, and
then stopped being true: finding 1 reopened it by a different route. D-62's
check was never bypassed — it correctly refuses a mandate approving its own
escalation — but an agent able to mint a credential for its *approver*
satisfies the check honestly while supplying the second authority itself.
Closed again by D-64, which makes credential minting administrative.

**Tenancy sub-finding of finding 2 — fixed, D-67.** Mandate creation did not
check that the named principal belonged to the caller's organization, nor
that it existed at all. Both are now rejected, with a single
indistinguishable error so the route cannot be used as a cross-tenant
existence oracle.

**Finding 4, how the laundering worked.** Trust was stored once per resolved
merchant as a high-water mark, so one verified identifier spoke for every
identifier that arrived with it. An agent asserting
`{domain: "staples.com", psp_account: "acct_attacker"}` got a VERIFIED
merchant — the directory corroborated the domain — and the allowlist check
read *that* value rather than the trust of the identifier it matched, so an
allowlist naming only the attacker's own account id was satisfied and the
request ALLOWed. Verification status, attestation source and timestamp now
live on each identifier, and a match can produce ALLOW only when the matched
identifier is itself verified **and** no identifier in the request is
unverified. The receipt names which one failed, so a laundered sibling reads
differently from a wholly unknown merchant.

**Finding 5 was only reproducible against real Postgres.** The in-memory
repository was *structurally unable to express the bug*: it keeps one ledger
array per mandate, so its reservation lookups are scoped to a mandate by
construction, and the cross-mandate half of the defect could not occur there
no matter what a test did. The entire in-memory suite stayed green
throughout. That is the gap `DECISIONS.md` D-15 predicted the fake would
leave, and this is the first time it mattered in the money path — a reminder
that "the tests pass" means "the tests pass against the fake" wherever a
Postgres-gated case does not exist. The new adversarial tests for findings 5
and 6 are therefore Postgres-gated and skip cleanly without a database.

**Found by the remediation, not the review.** The review found six things;
closing them turned up eight more, each with its own decision-log entry:

- **Four more routes with finding 1's shape (D-65).** Auditing every route
  that creates or modifies a credential, agent, principal, or org membership
  found mandate creation, agent creation, principal creation, and key
  revocation all open to any credential. Mandate creation is the most severe
  of the five — it let an agent write itself a fresh policy with any ceiling,
  bypassing the approver mechanism rather than subverting it.
- **Tenancy on mandate creation (D-67).** Described above; found while fixing
  finding 2, not reported by it.
- **The merchant directory suffix-matched (D-70).** Any subdomain of a listed
  merchant resolved VERIFIED, and nothing checked that the party asserting
  `attacker-controlled.staples.com` controlled it. An agent could *mint*
  verified merchant trust by typing a hostname, then launder its own account
  id through it via finding 4. The directory is now exact-match; an entry
  lists additional hosts, or opts into its whole DNS zone, explicitly. A
  policy allowlist still matches subdomains — that entry is the principal's
  own choice about a merchant they picked, whereas the directory is Waysafe
  vouching for a third party.
- **Approval did not re-validate the spending mandate (D-73).** Three things
  could lapse between a step-up being raised and an approver resolving it —
  the step-up's own TTL, the mandate being revoked, and the mandate policy's
  `expires_at` — and all three were approved and executable. The TTL was
  guarded, but outside the row lock, so the guarantee depended on one caller
  remembering to call one helper first. All three are now re-read inside the
  same lock that takes the money.
- **The Issuing webhook had no idempotency (D-74).** Stripe redelivers
  events; an identical redelivery produced a second authorization row and a
  second reservation, and since the capture webhook names one row the
  duplicate hold had no event that would ever clear it. $120 was held for one
  $60 card authorization, and the cardholder's next genuine $60 payment was
  declined against their own cap by a phantom.
- **Server-side request forgery through `resource_url` (D-75).** `POST
  /v1/enforcement/x402` takes a URL from the caller and Waysafe's own server
  fetches it — the mechanism D-40 relies on to stop an agent asserting its
  own payment requirements. Nothing validated where that request went, and
  the route is reachable with an ordinary agent key, so a leaked credential
  could make the API process GET cloud instance metadata, a loopback admin
  port, or any private-range host. A second half made it worse: no
  `setErrorHandler` existed, so Fastify's default echoed the error message —
  which contains the URL and the upstream status — turning blind SSRF into a
  status-code oracle. Now an explicit fetch policy (HTTPS, public addresses
  only, one DNS resolution with the connection pinned to the classified
  address, redirects re-validated, time and size capped) and a generic 5xx
  body for every route. Found during the threat-model diagram pass, not by
  the review.
- **A decision and its evidence event were two transactions (D-76).** The
  authorization row and its ledger hold committed in one transaction; the
  evidence event was a second one immediately afterwards. A failure between
  them left a committed hold with no record of why, and a 500 that relied on
  Stripe's own decline-on-timeout setting to fail closed. All three now commit
  or roll back together, on both rails, and a decision that cannot be recorded
  is answered with an explicit decline. Found while drawing the card decision
  path for the threat model.
- **The `/film` demo route had the same bug, and `/proof` recorded it.** It
  minted one Stripe authorization id per merchant rather than per
  authorization, and `/proof`'s scenario list deliberately uses one merchant
  for two different amounts — so two genuinely distinct card authorizations
  in a single run shared one id. Under D-74's replay rule and the old
  scheme, the demo's over-the-cap DENY would have been served the earlier
  ALLOW. Fixed; see the known issue below.

## Findings from the second independent review, 2026-10

A second independent adversarial review, of commit `1caf39b`, reported eleven
findings. Ten were real; one was wrong and is named below. All ten are closed,
each as its own commit, each with the attack written as a passing test against
the unfixed code before anything was changed, and most with a negative control
proving the test would catch a regression rather than agreeing with the
implementation.

The review's own numbering (R-n) is kept alongside this file's, because its
evidence refers to it.

| # | Finding | Status |
|---|---|---|
| R1 | A same-organization agent credential could list, read and execute another agent's authorization, and choose the payment instrument at execution | **Fixed** — D-78 |
| R2 | A Stripe Issuing **incremental** request replayed the original approval: $10 approved, then the same authorization id re-presented at $10,000, approved | **Fixed** — D-79 |
| R3 | A revocation committed between the unlocked gate read and the money lock was still approved | **Fixed** — D-80 |
| R4 | A provider event was marked consumed before its ledger effect committed, so a failed refund credit was never retried and the budget stayed uncredited | **Fixed** — D-81 |
| R5 | Stripe's **cumulative** `amount_refunded` was applied as a delta: $40 then $100 of one $100 charge produced a net ledger amount of **minus $40**, i.e. $140 of fresh budget | **Fixed** — D-82 |
| R6 | Reversed and expired Issuing authorizations kept their reservation forever, and a partial capture recorded the authorized amount rather than the settled one | **Fixed** — D-83 |
| R7 | `max_count` was reservations minus releases, so every **settled** payment handed its slot back: under `max_count: 1`, unlimited payments by letting each settle first | **Fixed** — D-87 |
| R8 | A policy-activation signature could be redeemed as a passkey **re-enrollment grant**, enrolling an attacker's authenticator | **Fixed** — D-86 |
| R9 | Multiple non-reserving step-ups were each invisible to the others: three $90 step-ups on a $100 mandate, all three approved, $270 spent | **Fixed** — D-85 |
| R10 | Sub-cent x402 transfers rounded to **zero cents**: 14,997 atomic USDC co-signed across three requests, $0.00 on the ledger and the receipt | **Fixed** — D-88 |
| R11 | A slow-drip response body defeated the fetch deadline, because the only timer was an idle timer every byte reset | **Fixed** — D-89 |

**Refuted: "real Postgres mandate activation swaps `ip` and `now`".** The
review listed this as Critical and it is wrong. `activateMandate(mandateId,
mandateVersionId, ip, now)` is declared in that order, called in that order,
and writes `authenticatedAt: now, authenticationIp: ip`. The review's own
probe constructed the call by hand with the arguments transposed and then
reported Prisma's resulting validation error as the product's behaviour. It
was reproduced before being believed, which is why it is listed here as
refuted rather than as a twelfth D-number. A real Postgres activation test
now pins both fields, so the claim cannot be made again without failing.

Two further findings the review raised are **not** vulnerabilities and were
not treated as such: that evidence proves authorship and the integrity of
the chain it shows rather than completeness (true, stated in
`docs/THREAT-MODEL.md` §7 and in OQ-8 below), and that there is no rate
limiter (true, and tracked as a hardening gap rather than a defect).

### Self-found extensions

Closing the eleven turned up four more, each with its own decision-log entry:

- **Force capture and overcapture were silently ignored (D-84).** Raised as a
  question while modelling the card lifecycle for R6, and the answer was a
  hole: `issuing_transaction.created` was not handled at all, so a settlement
  the network cleared without asking — or one above what was approved — moved
  money and nothing in Waysafe recorded it. Both are now written to the
  ledger, charged against the cap, and flagged on the receipt with two new
  reason codes (`DENY_SETTLED_WITHOUT_AUTHORIZATION`,
  `DENY_SETTLED_ABOVE_AUTHORIZATION`), the raw rail payload a dispute needs,
  and what the engine *would* have decided had it been asked.
- **Ordinary agent decisions wrote no evidence (D-90).** The review found this
  at the service layer; it was reproduced here through the real HTTP route,
  because `POST /v1/authorizations` is the path the public claim is about.
  The rail-initiated paths each append decision evidence; the agent path
  predates them and never did, so "every decision produces a signed receipt"
  was false on the primary API path. ALLOW, DENY and STEP_UP now each append a
  signed `authorization.decided` event in the same transaction as the decision
  and its hold.
- **x402 never checked policy expiry at all (D-80).** Found while fixing R3.
  That file kept its own copy of the mandate status gate and had no expiry
  check, so an expired policy was enforceable on the x402 rail indefinitely.
  Both rails now obtain their policy through one gated helper, and a
  structural test asserts that every file calling `evaluate()` goes through
  it.
- **An increment consumed two `max_count` slots (D-87).** A defect introduced
  by this remediation's own D-79, which gives each incremental request its own
  authorization row: counting rows made one incremented card payment consume
  two slots, and the increment was declined by the count rule. The counting
  unit is now the transaction, not the row.

### What the remediation itself got wrong

Recorded because a remediation that only reports its successes is not
evidence of anything:

- **D-79's first version was still exploitable**, by a different route. It
  keyed the revision on the payload's `request_history.length`, which the
  review's increment payload leaves untouched — so the increment collided on
  the uniqueness key, the insert was refused, and D-74's own conflict handler
  replayed the winner. The attack still passed. Fixed to a decision sequence.
- **D-78's first version broke D-62.** The ownership check landed on the
  step-up route too, where the resolver must be a *different* agent. Caught by
  R1's own test failing with the wrong status code; that route now carries a
  comment saying why it deliberately has none.
- **D-85's first version declined legitimate approvals.** It evaluated the
  step-up's full amount against a snapshot that already contained its hold,
  so $90 + $90 read as $180 on a $100 cap. Caught by D-72's existing test.
- **D-80's helper read wall-clock time** for its expiry check, which two
  existing D-73 tests caught: a repository must never invent the time a
  decision is made.
- **One negative control was vacuous and looked like a pass.**
  `@waysafe/core` resolves to its built output, so editing its source and
  re-running vitest tests the previous build. D-87's first control reported
  every case still passing; re-run with `tsc -b` in between, four of six
  failed. Recorded in D-87, because a control that proves nothing while
  looking like it proved something is the exact failure mode these controls
  exist to prevent.

Across the whole remediation, **three** existing expectations encoded a bug
and had to be updated (D-71's, D-81's, and two of D-66's purpose-name
assertions), **four** caught regressions in the fixes themselves, and **four**
hung rather than failed on a deadlock in the in-memory repository's lock,
which had never been re-entrant while Postgres's always was.

### Where these attack tests live

| File | Findings | Tests |
|---|---|---|
| `apps/api/src/review2.adversarial.test.ts` | all eleven, plus D-84 and D-90 — Postgres-gated | 52 |
| `packages/core/src/engine/window-rollup.test.ts` | D-87's counting rule, offline | 9 |

The earlier review's files are unchanged and still listed above. The full
suite is **683 passing offline, 107 in the serial Postgres pass, 1 skipped**,
with the one standing testnet-funding failure documented in `DECISIONS.md`
D-42.

### What remains open after both reviews

Nothing here is a live hole; all are written up with candidate fixes, and
what has not been built, in `DECISIONS.md`.

- **OQ-8 — no external transparency anchor.** The evidence chain proves
  authorship and the integrity of the slice it shows. An operator with both
  database and signing-key access can present an incomplete slice, and
  nothing outside Waysafe would contradict it. The review is right about
  this, and the claim in `docs/THREAT-MODEL.md` §7 is scoped to match.
- **OQ-12 — the mandate-authentication challenge is predictable**, derived
  from the public `policy_hash`. **Narrowed by D-86**: the re-enrollment
  ceremony's challenge is random, and after D-86 is the only value its own
  completion path accepts, so a predictable challenge is a concern for
  mandate activation only. Before D-86 it was worse than OQ-12 described,
  because one purpose covered two operations.
- **OQ-13 — x402 "VERIFIED" is weaker than card "VERIFIED".** Unchanged; see
  the full statement above.
- **OQ-14 — a step-up expiry writes no evidence.** Found while closing D-90.
  An expiry releases a reservation with nothing in the signed chain to say
  so. Not a decision, which is why D-90 did not fold it in; recorded rather
  than rushed because the fix changes a signature the expiry worker calls in
  a loop.
- **Cosigner-key custody (D-56/D-59).** The 2-of-2 Safe proves a session key
  alone cannot settle. It proves nothing about the Waysafe co-signer key,
  which is a single secp256k1 key in an environment variable, with no
  rotation plan and no kill switch. The review states this correctly.
- **Database-write authority (D-54).** Anything that can write the database
  can alter a policy, and the signed chain records the decision that *was*
  made, not whether the policy it cited was the one the principal approved.
- **A dependency can alter `evaluate()` (D-43).** The authorization path is
  deterministic TypeScript, which means it is as trustworthy as the supply
  chain it is installed from.

## Open questions raised

Neither is a live hole. Both are written up in full, with candidate fixes and
what has not been built, in `DECISIONS.md`.

**OQ-12 — the mandate-authentication challenge is predictable, not secret.**
It is derived from the public `policy_hash`. Finding 2's fix does not depend
on the challenge being unguessable, so nothing here is exploitable today. But
replay of a captured assertion onto another mandate sharing that hash is
currently prevented only by WebAuthn's signature counter, which is an
authenticator-reported value that some real platform authenticators always
report as zero. Three candidate fixes are recorded; none is built.

**OQ-13 — x402 merchant verification is weaker than card merchant
verification, and the difference is worth stating outright.** On the card
rail, identity is an acquirer-assigned merchant id that arrives in Stripe's
own authorization payload. On x402, the payee address and the merchant's
domain both come from Waysafe's independent fetch of the resource — so the
*agent* cannot forge either — but the host serving that resource is what
declares its own payee address, and nothing outside that host corroborates
that the address belongs to whoever owns the domain. The agent also chooses
which resource URL Waysafe fetches. So on x402, "VERIFIED" means *Waysafe
fetched this resource and this host asked for this payment*, not *this host
is who it claims to be*. That is not an allowlist bypass — the identifiers
verify as what they are, and a mandate naming real merchants will not match
them — but a mandate leaning on `unlisted: ALLOW` plus "the merchant was
verified" gets materially less assurance on x402 than the same words buy on a
card. Closing it needs an out-of-band binding from a domain to its payee
addresses, which this codebase has no source of truth for; the likely shape
is a distinct trust level (rail-attested vs. directory-verified) that a
policy can require, rather than a behaviour change.

## Where the attack tests live

Four files, written attack-first throughout — each case was confirmed to pass
against the unfixed code before anything was changed, and several were
re-checked with a negative control proving the test would catch a
regression rather than agreeing with the implementation:

| File | Findings |
|---|---|
| `apps/api/src/server.adversarial.test.ts` | 1, 2 (route authorization, passkey enrollment, tenancy) |
| `apps/api/src/enforcement/x402.adversarial.test.ts` | 3 (asset decimals) |
| `packages/core/src/merchant.adversarial.test.ts` | 4, and D-70's directory suffix-match |
| `apps/api/src/authorization/budget.adversarial.test.ts` | 5, 6, and D-73/D-74 — Postgres-gated |

| `apps/api/src/enforcement/x402-ssrf.adversarial.test.ts` | the seventh finding, D-75 — SSRF through `resource_url` |
| `apps/api/src/enforcement/decision-atomicity.test.ts` | D-76 — decision, hold and evidence event in one transaction (Postgres-gated) |

The full suite is **731 passing, 1 skipped**, with one standing failure that
is a testnet funding gap rather than a code regression (documented in
`DECISIONS.md` D-42).

**Gated suites now announce themselves (D-77).** Nine suites depend on an
external resource and skip when it is absent. Seven of those need a real
Postgres, including the two that carry the row-lock and ledger-window proofs,
and they used to vanish in silence — so a green run could mean the money-path
proofs passed or that they never ran. Every run now prints one line per
skipped suite naming the variable that would enable it, and those seven run in
their own serial pass because running them concurrently against one database
made the ledger suite fail 3 of 9 runs. See
[`docs/THREAT-MODEL.md` Appendix C](docs/THREAT-MODEL.md#appendix-c-gated-suites).

## Known open issues

**D-74's unique index is installed, scoped to exclude one historical
literal.** The webhook-replay race is closed: a redelivered Issuing event
returns the original decision and writes no second row or hold, and two
*concurrent* deliveries now produce exactly one row — enforced by a unique
index on `(mandate_id, external_ref)`, applied by `npm run db:constraints`.

The index excludes exactly one value, `iauth_demo_goodbeans_card_9001`. Six
historical `/film` demo rows carry it, and they cannot be removed: each is the
subject of an evidence event, and two sit inside the contiguous, published
chain slice `/proof` displays, so deleting them would leave published
provenance pointing at nothing. The exclusion is a **closed** set rather than
an open-ended exemption — D-74 changed the route so every id now carries a
per-run instrument id, making that literal unmintable, and a test
(`apps/api/src/demo/routes.test.ts`, with a negative control) is what keeps
that true so the exemption cannot widen silently.

These are already public, written up in detail in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). Please read the relevant
section before reporting — the goal of this list is to save a researcher the
time of rediscovering what's already been found and documented, not to
discourage looking further.

- **The Safe co-signer key alone can complete a pending transaction.** The
  2-of-2 on-chain multisig genuinely defends against an attacker who holds
  only the agent's session key. It does not defend against an attacker who
  holds the cosigner key, since every genuine payment request already
  carries a session-signed payload the cosigner key is sufficient to
  complete — demonstrated live, not hypothetically. See
  [`docs/THREAT-MODEL.md` §3](docs/THREAT-MODEL.md#3-code-execution-on-the-api-process)
  (the finding) and
  [§10](docs/THREAT-MODEL.md#10-what-we-dont-know) (the named,
  unbuilt remediation direction).
- **Approver-cycle risk, bounded by design (D-62).** Resolving a step-up
  requires a different, named approver mandate's own credential. That
  closure was briefly incomplete: it assumed an agent could not *obtain* an
  approver's credential, which finding 1 above disproved and D-64 fixed.
  Two mandates naming each other as approver are rejected at
  creation, but a longer cycle (three or more) is not caught there; it's
  accepted as bounded by every approval permanently costing real budget on
  the approving mandate's own cumulative cap, not by validation. See
  [`docs/THREAT-MODEL.md` §1](docs/THREAT-MODEL.md#1-a-leaked-agent-key)
  for the closure, the residual risk of a leaked key paired with a leaked
  approver key, and the cycle reasoning in full.
- **The evidence chain has no external anchor.** Verifying a chain proves
  Waysafe signed the record and nothing was altered after the fact. It does
  not prove completeness — that nothing happened outside what you were
  shown. See
  [`docs/THREAT-MODEL.md` §7](docs/THREAT-MODEL.md#7-the-evidence-chain).

## Key custody, plainly

Every private signing key in this codebase today is loaded from an
environment variable directly into process memory — no hardware security
module, no key management service, no boundary between a process compromise
and a key compromise.

A `Signer` interface now sits in front of that (D-63), with `EnvSigner` as
its only implementation. This is a code-structure change, not a security
improvement: the key is still a plaintext env var decoded into ordinary
process memory, and an attacker with code execution in the process reaches
it exactly as before. What it buys is that a KMS-backed signer becomes a new
class plus config rather than a rewrite of every signing call site. See
[`docs/THREAT-MODEL.md` §8](docs/THREAT-MODEL.md#8-key-custody-rotation-and-revocation)
for exactly what that does and doesn't mean for each key in the system. All
three keys — including the on-chain Safe cosigner — now sign through the
interface; `@waysafe/core` no longer decodes a private key at all.
