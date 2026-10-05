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
closing them turned up five more, each with its own decision-log entry:

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
- **The `/film` demo route had the same bug, and `/proof` recorded it.** It
  minted one Stripe authorization id per merchant rather than per
  authorization, and `/proof`'s scenario list deliberately uses one merchant
  for two different amounts — so two genuinely distinct card authorizations
  in a single run shared one id. Under D-74's replay rule and the old
  scheme, the demo's over-the-cap DENY would have been served the earlier
  ALLOW. Fixed; see the known issue below.

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

The full suite is **707 passing, 1 skipped**, with one standing failure that
is a testnet funding gap rather than a code regression (documented in
`DECISIONS.md` D-42).

## Known open issues

**D-74's unique index is not yet installed on the development database.**
The application-level replay check is active and proven: a redelivered
Issuing event returns the original decision, writes no second row and takes
no second hold. The database-level control behind it — a unique index on
`(mandate_id, external_ref)` — is what decides the case where two deliveries
arrive *concurrently*, since both then read "not seen" and both try to
insert. `npm run db:constraints` creates that index conditionally and reports
what blocks it, because this database still holds pre-D-74 `/film` demo rows
that duplicate the pair, and `/proof`'s committed capture cites two of them
by id. Clearing them is a judgment call about demo history that a constraint
script must not make silently. **Until the index is installed, the
concurrent-delivery race is not closed.** The test for it says so out loud
and skips, rather than passing against an absent control.

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
  [`docs/THREAT-MODEL.md` §2.1](docs/THREAT-MODEL.md#21-remote-code-execution-on-the-api-process)
  (the finding) and
  [§7](docs/THREAT-MODEL.md#7-revocation-and-incident-response) (the named,
  unbuilt remediation direction).
- **Approver-cycle risk, bounded by design (D-62).** Resolving a step-up
  requires a different, named approver mandate's own credential. That
  closure was briefly incomplete: it assumed an agent could not *obtain* an
  approver's credential, which finding 1 above disproved and D-64 fixed.
  Two mandates naming each other as approver are rejected at
  creation, but a longer cycle (three or more) is not caught there; it's
  accepted as bounded by every approval permanently costing real budget on
  the approving mandate's own cumulative cap, not by validation. See
  [`docs/THREAT-MODEL.md` §1.3](docs/THREAT-MODEL.md#13-agent-api-keys-and-org-credentials)
  for the closure, the residual risk of a leaked key paired with a leaked
  approver key, and the cycle reasoning in full.
- **The evidence chain has no external anchor.** Verifying a chain proves
  Waysafe signed the record and nothing was altered after the fact. It does
  not prove completeness — that nothing happened outside what you were
  shown. See
  [`docs/THREAT-MODEL.md` §3](docs/THREAT-MODEL.md#3-what-the-evidence-chain-proves-and-what-it-does-not).

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
[`docs/THREAT-MODEL.md` §5](docs/THREAT-MODEL.md#5-where-the-private-keys-actually-live-envsigner)
for exactly what that does and doesn't mean for each key in the system. All
three keys — including the on-chain Safe cosigner — now sign through the
interface; `@waysafe/core` no longer decodes a private key at all.
