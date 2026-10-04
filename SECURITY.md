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
vulnerabilities. Each is listed here with its status and the commit that
fixed it. Remediation is in progress; this section is updated per finding,
not at the end.

| # | Finding | Status |
|---|---|---|
| 1 | Agent credentials could mint API keys for any agent, manufacturing a second authority and reopening the step-up self-approval hole | **Fixed** — D-64 |
| 2 | An authentication challenge could be answered with a registration response, enrolling an attacker's passkey for a victim principal | **Fixed** — D-66 |
| 3 | Merchant-supplied `decimals` controlled atomic-to-cents conversion, so a hostile merchant could have a large transfer evaluated as ~0 | Open |
| 4 | A directory-verified domain laundered an unverified PSP account id in the same request | Open |
| 5 | With `reserve_on_step_up: false`, an approval never consumed the original mandate's budget | Open |
| 6 | A reservation made before a period boundary was released against the next period, driving a ledger window negative | Open |

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

**Open question raised by finding 2 (OQ-12).** The mandate-authentication
challenge is derived from the public `policy_hash`, so it is predictable
rather than secret. Finding 2's fix does not depend on the challenge being
unguessable, so this is not a live hole — but replay of a captured assertion
onto another mandate sharing that hash is currently prevented by WebAuthn's
signature counter, which is an authenticator-reported value that some real
platform authenticators always report as zero. See `DECISIONS.md` OQ-12 for
the scenario and three candidate fixes, none built.

**Found by the remediation audit, not the review.** Auditing every route
that creates or modifies a credential, agent, principal, or org membership
found four more with the same shape as finding 1, all closed by D-64's
inversion (D-65): mandate creation, agent creation, principal creation, and
key revocation. Mandate creation is the most severe of the five —
it let an agent write itself a fresh policy with any ceiling, bypassing the
approver mechanism rather than subverting it.

## Known open issues

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
