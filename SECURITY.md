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
- **An agent credential can resolve its own step-up.** `POST
  /v1/authorizations/:id/step-up` checks only that the credential belongs to
  the right organization — the same agent key that produced a `STEP_UP`
  decision can approve it immediately after, with no human and no second
  credential involved. This is a defect in the current implementation, not
  an accepted design. See
  [`docs/THREAT-MODEL.md` §1.3](docs/THREAT-MODEL.md#13-agent-api-keys-and-org-credentials)
  for the full finding (§2.4 cross-references it) and the Approver Mandates
  design at [waysafe.ai/docs](https://waysafe.ai/docs) that's meant to close
  it.
- **The evidence chain has no external anchor.** Verifying a chain proves
  Waysafe signed the record and nothing was altered after the fact. It does
  not prove completeness — that nothing happened outside what you were
  shown. See
  [`docs/THREAT-MODEL.md` §3](docs/THREAT-MODEL.md#3-what-the-evidence-chain-proves-and-what-it-does-not).

## Key custody, plainly

Every private signing key in this codebase today is loaded from an
environment variable directly into process memory — no hardware security
module, no key management service, no boundary between a process compromise
and a key compromise. See
[`docs/THREAT-MODEL.md` §5](docs/THREAT-MODEL.md#5-where-the-private-keys-actually-live-envsigner)
for exactly what that does and doesn't mean for each key in the system.
