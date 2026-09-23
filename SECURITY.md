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
- **Approver-cycle risk, bounded by design (D-62).** Resolving a step-up now
  requires a different, named approver mandate's own credential — closing
  the defect that used to be listed here (an agent credential resolving its
  own step-up). Two mandates naming each other as approver are rejected at
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
for exactly what that does and doesn't mean for each key in the system,
including the one path (the on-chain Safe cosigner) that does not yet sign
through the interface at all.
