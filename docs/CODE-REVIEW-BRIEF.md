# Bles — Code Review Brief

**Version 1.0 · For use with an independent code reviewer**

---

## How to use this document

Attach this brief alongside the source and the PRD. The reviewer's job is **not** to assess style, naming, or architecture taste. It is to answer one question:

> Does the code actually enforce what the product claims, and does it stay neutral and composable while doing it?

This system decides whether an autonomous agent may spend someone's money. A defect here is not a bug report — it is a policy that permitted something the person never agreed to. Review accordingly.

Three standing constraints shape every judgment below:

1. **Payments agnosticism.** The product's only durable advantage is neutrality across rails. Any provider-specific assumption that leaks out of an adapter and into the core is a structural defect, not a style issue.
2. **Modular developer experience.** Developers must be able to build their own user experience on these primitives. Anything that forces a particular UI, framework, hosting model, or vendor is a defect.
3. **Objectivity.** A finding is only a finding if it comes with a concrete failure scenario: specific inputs and state producing a specific wrong output. Opinions without a reproduction are noise.

---

## Part 1 — What the system claims to be

One API decides whether an AI agent may take an economic action, returning `ALLOW`, `DENY`, or `STEP_UP`.

A person writes a natural-language instruction ("$500 a month on office supplies, Amazon and Staples are approved"). A language model compiles that into a structured policy. The person reviews and authenticates that policy. From that moment on, **only deterministic code evaluates it.** The model is never in the authorization path.

The architecture:

```
Economic action → authorization / orchestration → Stripe · Visa · Mastercard
                                                   PayPal · AP2 · x402
                                                   stablecoins · banks
```

Key artifacts the reviewer should read first, in this order:

| File | Why |
|---|---|
| `DECISIONS.md` | Twelve implemented decisions (`D-1`…`D-12`) and open questions (`OQ-n`). Referenced by ID throughout the code. **Read before anything else.** |
| `CLAUDE.md` | The non-negotiable invariants |
| `packages/core/src/policy.ts` | The policy schema — what can be expressed |
| `packages/core/src/engine/evaluate.ts` | The decision logic |
| `packages/core/src/merchant.ts` | Merchant identity and trust |
| `packages/db/prisma/schema.prisma` | Persistence and the spend ledger |

---

## Part 2 — The invariants

These are objective pass/fail. Violating one is a defect **even if every test passes.**

**I-1 · A model never authorizes.**
An LLM appears in exactly one place: the intent compiler, turning natural language into a *proposed* policy. Everything downstream of a frozen policy is deterministic. *Check:* no model client, no network call, no non-determinism reachable from `evaluate()`.

**I-2 · Money is integer minor units.**
`$150` is `15000`. No floats, no decimal strings, no `parseFloat` on an amount, anywhere. *Check:* every amount that crosses a boundary; every arithmetic operation on an amount.

**I-3 · An unverified merchant can never produce ALLOW.**
Allowlists match on domains and PSP account ids, never names. An agent asserting only a name, or an uncorroborated domain, caps at `STEP_UP`. This is `D-3` and it is the difference between a policy engine and policy theater. *Check:* every path that can reach an ALLOW outcome.

**I-4 · No credential reaches a model prompt, a log, or a trace.**
*Check:* logger redaction paths; anything interpolated into a compiler prompt; error messages and stack traces.

**I-5 · Mandates are immutable versions.**
A `MandateVersion` is never mutated after creation except to stamp authentication. Edits write a new version. Every authorization cites the `mandateVersionId` and `policyHash` it was decided against. *Check:* every write path touching mandate rows.

**I-6 · Cumulative spend is a SUM over the ledger, never a counter column.**
Concurrent authorizations serialize on a row lock on the mandate. *Check:* the limit-check transaction; whether two simultaneous requests that each pass alone can both commit when together they exceed the cap.

**I-7 · Reason codes are a public API.**
Additive only, never renamed. Every decision branch returns one. *Check:* any renamed or removed code; any branch returning a decision without a code.

**I-8 · The compiler asks rather than inventing a limit.**
`needs_clarification` is a valid outcome at HTTP 200. A spending ceiling the principal did not state is never defaulted. *Check:* every path where the compiler could silently supply a number.

**I-9 · The core is payment-agnostic.**
No provider name, provider type, provider SDK, or provider-specific assumption appears in `packages/core`. Rails are reachable only through an adapter interface. *Check:* imports, type names, vocabulary, and — more subtly — semantics (see §3D).

**I-10 · The developer surface is modular.**
Every primitive is usable independently. No forced UI, framework, hosting model, or vendor. A developer can build their own approval experience, bring their own merchant directory, and swap the compiler. *Check:* anything that only works one way.

**I-11 · A decision is reproducible from its receipt.**
Same policy, same resolved merchant, same spend snapshot, same instant → bit-identical decision. *Check:* any clock read, random value, map-iteration-order dependency, or ambient state inside the evaluation path.

---

## Part 3 — Review dimensions

### A. Policy enforcement fidelity

Does the engine enforce exactly what the policy says — no more permissive, no more restrictive?

- For every field in the policy schema: is it read by the engine at all? A schema field nothing enforces is a promise to the principal that the system silently breaks.
- Where two rules interact, is the **stricter** one applied? Precedence is `DENY` > `STEP_UP` > `ALLOW`.
- Are boundary conditions right and intentional? `>` versus `>=` on a limit is the difference between denying and permitting a transaction exactly at the ceiling. Does it match the wording the principal was shown at confirmation?
- Does the human-readable confirmation describe what the code actually does? A divergence here means the person authenticated something other than what runs.

### B. The trust boundary

Everything the agent supplies is a **claim**, not a fact. The reviewer should build a mental list of every agent-supplied field and ask, for each: what happens if this is a lie?

- Merchant name, domain, PSP account, MCC
- Category
- Amount and currency
- Attestations (`refundable`, `stops`, `destination_city`)

For each: can a false value produce a **more permissive** outcome than the truth would? Note that denylists correctly work on claims — a *claim* of a blocked thing is disqualifying. Allowlists must not.

### C. Concurrency and money accounting

- Two authorizations arriving simultaneously against the same mandate: can both pass a limit that together they exceed?
- Does a pending `STEP_UP` hold budget when the policy says `reserve_on_step_up`? Is it released on decline, expiry, and execution failure — all three?
- Do refunds credit back correctly when `refunds_credit_budget` is set?
- Are calendar windows computed in the **policy's** timezone, not the server's? What happens across a DST transition, and at a month boundary?
- Idempotency: does the same key with a *different* body get rejected rather than silently replayed?

### D. Payment agnosticism

This is the dimension most likely to be under-reviewed, because violations look like reasonable code.

- Does anything in `packages/core` import, name, or type against a specific provider?
- **Does the schema assume card semantics?** Authorization-then-capture, chargebacks, and reversibility are card concepts. Stablecoin settlement is atomic and irreversible. Does `reserve_on_step_up` still make sense on a rail with no authorization hold? Does `refunds_credit_budget` mean anything where refunds don't exist?
- **Do the money primitives generalize?** A hardcoded two-decimal minor-unit exponent works for USD and breaks for a six-decimal stablecoin unit. Is the currency abstraction actually extensible or merely parameterized-looking?
- Is `psp_account` a generic identity scheme, or does it encode one provider's account-id shape?
- Could a second rail be added without editing the engine? If adding x402 requires touching `evaluate()`, the abstraction has already failed.
- Does the ledger record *which* rail executed? Without it, neutrality cannot be audited or metered.

### E. Developer surface and modularity

- Can a developer render their own step-up approval UI, or is a hosted page the only option? The approval token and its API must be exposed for the former to be true.
- Are reason codes sufficient to build a complete UX **without parsing prose**? Every branch a developer must handle differently needs its own code.
- Is the policy engine usable standalone, without the hosted service?
- Is the intent compiler swappable behind an interface, so a developer can bring their own model or none at all?
- Can a developer supply their own merchant directory?
- Does the SDK force a framework, a runtime, or a bundler?
- Are errors actionable — do they say what went wrong and what to do?

### F. Auditability

- Can every decision be reconstructed from stored data alone?
- Is the evidence log genuinely append-only and hash-chained, with tampering detectable?
- Does a receipt distinguish **verified facts** from **agent claims**? Fulfillment attestations are claims; presenting them as verification is a correctness defect, not a wording one.
- Does the receipt record the exact policy bytes — the hash — rather than a reference that can change underneath it?

### G. Test integrity

- Does each policy rule have a passing case, a failing case, **and** an adversarial case with hostile input?
- Are tests asserting real behavior, or asserting that an implementation matches itself? A test that passes because a regex agreed with a regex proves nothing.
- **Look for untested combinations, not just untested functions.** Coverage tools report lines. The dangerous gaps are interactions — see Worked Example 1.
- Are fixtures reviewed, or generated and trusted? These record a model's guesses about someone's money.

---

## Part 4 — Two worked examples

These are real findings from this codebase. They demonstrate the **shape** a good finding takes and the **class** of defect that matters here. Use them to calibrate.

### Worked Example — Finding 1

**An untested interaction made a security cap more permissive than the policy.**

*File:* `packages/core/src/engine/evaluate.ts`, in `evaluateMerchant`.

The code, when a merchant is not on the allowlist:

```js
if (merchant.trust !== MerchantTrust.VERIFIED) {
  reasons.push(unverifiedMerchantReason());   // STEP_UP
} else {
  switch (rules.unlisted) { DENY / STEP_UP / ALLOW }
}
```

**The defect.** An unverified merchant never reaches the `unlisted` switch. A policy stating *"deny anything not on the allowlist"* therefore returns `STEP_UP` for an unverified unlisted merchant — **strictly more permissive than what the principal asked for.**

The invariant (`I-3`, `D-3`) was implemented as a *replacement* — "unverified is always STEP_UP" — when it should be a *ceiling*: "unverified can never exceed STEP_UP." A ceiling only ever moves an outcome toward DENY. A replacement can move it away.

**Why it survived review.** Every existing test of unverified merchants used `unlisted: "ALLOW"`, where replacement and ceiling produce the same answer. The combination that distinguishes them was never tested. Line coverage was complete; the interaction was not.

**Correct behavior:**

| Trust | `unlisted` | Expected |
|---|---|---|
| unverified | `DENY` | `DENY` |
| unverified | `STEP_UP` | `STEP_UP` |
| unverified | `ALLOW` | `STEP_UP` — the cap |
| verified | any | as stated |

**What this teaches the reviewer.** When a security control and a policy setting both bear on one outcome, check every combination — especially the ones where the two disagree. Ask of every guard: *is this a ceiling or a replacement, and which was intended?*

---

### Worked Example — Finding 2

**A comment asserted a security property the code did not provide.**

*Files:* `packages/core/src/engine/evaluate.ts` (the claim), `packages/core/src/merchant.ts` (the reality).

`evaluate.ts` documents the `deny_mcc` check as spoof-resistant because the MCC is *"directory- or PSP-sourced, never the agent's claim."*

But `merchant.ts` assigns `let mcc = assertion.mcc` **before any directory lookup** — an agent-supplied MCC flows straight into `resolved.mcc`. The stated provenance guarantee does not exist.

**Severity is genuinely low.** An agent evades by *omitting* the MCC, and omitting means no directory match, which caps the outcome at `STEP_UP` anyway. The exploit is narrow.

**Why it still matters.** An untrue comment about spoof-resistance, inside the one module that exists to prevent spoofing, is how the next person builds a real vulnerability on a false premise. The fix is not to stop checking asserted MCCs — a *claim* of a blocked category should still disqualify, consistent with denylist behavior — but to **track provenance explicitly** (`mcc_source: "psp" | "directory" | "assertion"`), surface it on the receipt, and make the comment describe what happens.

**What this teaches the reviewer.** Verify comments against code, especially comments making security claims. Where data provenance determines trust, provenance must be a **value in the system**, not an assumption in prose. Flag any place where trust is asserted rather than represented.

---

## Part 5 — How to report findings

Every finding must include, at minimum:

- **File and line.**
- **One-sentence statement** of the defect.
- **A concrete failure scenario** — specific inputs and state producing a specific wrong output. If you cannot construct one, it is not a finding.
- **Which invariant or decision ID it violates** (`I-n`, `D-n`), if any.
- **Verdict:** `CONFIRMED` (you traced the code and are certain) or `PLAUSIBLE` (it looks wrong but you could not fully verify).

Severity, most to least:

1. **Permissive** — the system allows something the policy forbids. Always highest.
2. **Money-incorrect** — wrong amounts, lost updates, double-counting, unreleased holds.
3. **Unauditable** — a decision that cannot be reconstructed or proven after the fact.
4. **Restrictive** — the system denies something the policy permits. A bug, but it fails safe.
5. **Structural** — provider leakage, forced UX, or a broken abstraction that will be expensive later.

Rank by severity, not by confidence or by how interesting the finding is.

---

## Part 6 — Out of scope

Do not report:

- Style, formatting, naming preferences, or file organization.
- Library or framework substitutions without a correctness argument.
- Performance, unless it changes behavior under concurrency.
- Missing features that are scheduled — the sprint plan is in `README.md` and `CLAUDE.md`; Weeks 3–6 are known gaps, not defects.
- Anything already recorded as an open question (`OQ-n`) in `DECISIONS.md`. Those are decisions awaiting a human, not oversights. If you believe an `OQ` is resolved incorrectly, say so explicitly and explain why — but label it as a disagreement, not a defect.
- Speculation without a failure scenario.

A short report of confirmed, reproducible findings is worth more than a long one padded with possibilities.
