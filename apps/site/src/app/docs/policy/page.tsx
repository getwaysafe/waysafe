import type { Metadata } from "next";
import { AMOUNT_FIELDS, COUNTERPARTY_FIELDS, ESCALATION_FIELDS, EVIDENCE_FIELDS, INSTRUMENT_FIELDS, PERIOD_FIELDS, PolicyFieldTable, TIME_FIELDS, VELOCITY_FIELDS } from "@/lib/docs-content";

export const metadata: Metadata = {
  title: "Policy schema — Waysafe docs",
  description:
    "Every policy field, whether the engine enforces it today, and the reason code that does.",
};

export default function Page() {
  return (
    <>
        <h2 style={{ marginTop: 56 }}>Policy Schema Reference</h2>
        <div className="card" style={{ marginTop: 8, marginBottom: 24, background: "#fff8e1", borderColor: "#f0c96b" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            The engine enforces the IMPLEMENTED fields below today, each cited against the exact
            function and reason code that enforces it.
          </p>
          <p style={{ margin: "8px 0 0" }}>
            Fields marked <strong>SPECIFIED</strong> are defined in the schema but not yet enforced;{" "}
            <strong>RESERVED</strong> names exist in code (an enum member, a reason code) only to
            prevent a future collision, with no behavior behind them. Every status was verified
            directly against <code>packages/core</code> — not inferred from the PRD, not assumed
            from the field existing in a type. Unimplemented and reserved fields are described here
            in the <em>future</em> tense — never as something a mandate can rely on today.
          </p>
        </div>
        <p style={{ maxWidth: 700 }}>
          Reason codes are additive-only and never renamed (non-negotiable #7) — every code named
          below, including the reserved one, is a permanent commitment once it ships. Amounts are
          integer minor units throughout, same as everywhere else in this SDK.
        </p>

        <h3 style={{ marginTop: 32 }}>Amount</h3>
        <PolicyFieldTable rows={AMOUNT_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Period</h3>
        <p style={{ maxWidth: 700 }}>
          Worth stating plainly because it&rsquo;s easy to conflate: every window Waysafe
          actually computes is a <strong>fixed calendar window</strong> — a calendar day, a
          Monday-start calendar week, a calendar month, each in the policy&rsquo;s own timezone.
          None of them is a <strong>rolling window</strong> (the trailing N days from now,
          sliding forward every second). &ldquo;No more than $500 in any rolling 30 days&rdquo;
          and &ldquo;no more than $500 per calendar month&rdquo; are different guarantees — the
          first resets continuously, the second resets on the 1st regardless of when in the prior
          month spending happened. Only the second is expressible today.
        </p>
        <PolicyFieldTable rows={PERIOD_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Counterparty</h3>
        <PolicyFieldTable rows={COUNTERPARTY_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Time</h3>
        <PolicyFieldTable rows={TIME_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Velocity</h3>
        <PolicyFieldTable rows={VELOCITY_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Instrument</h3>
        <PolicyFieldTable rows={INSTRUMENT_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Evidence</h3>
        <p style={{ maxWidth: 700 }}>
          The minimum merchant trust tier required to ALLOW is a real rule the engine enforces
          unconditionally (D-34) — it is not, today, a field a mandate can set.
        </p>
        <PolicyFieldTable rows={EVIDENCE_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Escalation</h3>
        <PolicyFieldTable rows={ESCALATION_FIELDS} />

        <h3 style={{ marginTop: 40 }}>Invariants</h3>
        <p style={{ maxWidth: 700 }}>
          The security properties a reviewer checks — not a summary of the tables above, a
          separate set of claims about how any policy, present or future, must compose.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>1. Absence fails closed.</strong> An unset field never widens scope. Omitting{" "}
          <code>per_transaction_max</code> does not mean unlimited spend is intended — every
          mandate still has <code>expires_at</code>, a currency, and an{" "}
          <code>unlisted</code> disposition on both merchants and categories, each independently
          capable of stopping an action. A missing ceiling is a ceiling nobody set, not a ceiling
          of infinity.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>2. Composition is most-restrictive-wins.</strong> Every dimension in{" "}
          <code>evaluate()</code> can only ever <em>add</em> a reason at its own tier or above;
          none can downgrade a decision another dimension already forced upward. Precedence is{" "}
          <code>DENY</code> &gt; <code>STEP_UP</code> &gt; <code>ALLOW</code>. Adding a rule to a
          policy can never widen what it already permitted. And a decision carries{" "}
          <em>every</em> reason code that applies at its winning tier, not just the first one
          evaluated — a request that&rsquo;s both over the per-transaction cap and from an
          unlisted merchant returns both <code>DENY_TRANSACTION_LIMIT_EXCEEDED</code> and{" "}
          <code>DENY_MERCHANT_NOT_ALLOWLISTED</code>, so a receipt never hides a second real
          reason behind whichever check happened to run first.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>3. Policy change requires mandate-creation authority.</strong> An approval
          authorizes one action. It can never mutate a policy — not the mandate it was decided
          under, not any other. Widening a limit, adding a merchant, or extending an expiry is a
          new mandate version, created with the same authority (and, today, the same WebAuthn
          ceremony) that created the first one — never a side effect of approving a transaction.
        </p>

        <h3 style={{ marginTop: 40 }}>Approver Mandates</h3>
        <div className="card" style={{ marginTop: 8, marginBottom: 16, background: "#e8f5e9", borderColor: "#7cb87f" }}>
          <p style={{ margin: 0 }}>
            <strong>D-62: real, shipped, tested.</strong> Resolving a needs-higher-authority
            step-up now requires a different, named approver mandate&rsquo;s own credential — the
            same <code>evaluate()</code> engine, a real ledger entry, real reason codes. This
            closes D-59 (below). Two things stay SPECIFIED, not built — delegation depth beyond
            one level, and the needs-evidence class ((a) below) — each called out where it applies.
          </p>
        </div>
        <p style={{ maxWidth: 700 }}>
          A step-up is not a pause waiting for a human. It is a second authorization, evaluated by
          the same <code>evaluate()</code> engine against a <em>different</em> mandate — the
          approver&rsquo;s — producing the same decision shape, the same evidence entries, and the
          same reason codes as any other authorization.
        </p>
        <p style={{ maxWidth: 700 }}>
          The principal signs the approver&rsquo;s authority <strong>once</strong>, at enrollment,
          via WebAuthn (D-20) — the same passkey ceremony that activates any mandate.{" "}
          <code>escalation.approvers</code> is set at mandate creation, alongside every other
          policy field, by the same signature. (No separate &ldquo;update this mandate&rdquo;
          ceremony exists yet — changing an existing mandate&rsquo;s approver set means creating a
          new mandate, same as changing any other field today.) After that, approvals run at
          machine speed with no human present. The human is in the <em>authority</em> path, not
          the <em>transaction</em> path.
        </p>
        <p style={{ maxWidth: 700 }}>
          An approver is any actor holding an approver mandate: a treasury service, a manager, a
          controller system, or the principal themselves. The human-in-the-loop, async-approval
          case most people picture first is the <strong>degenerate form</strong> of this model,
          not a separate mechanism from it — a human approving on their phone and a treasury
          service approving programmatically both resolve a step-up the identical way, through the
          identical engine.
        </p>
        <p style={{ maxWidth: 700 }}>
          An approver mandate is bounded by the same policy schema documented above — amount
          ceilings, merchant scope, time windows, velocity. An approver cannot approve outside its
          own mandate; it is a mandate, evaluated the same way any other is. And it is not free to
          approve: an approval writes a real, permanent ledger entry against the{" "}
          <strong>approver&rsquo;s own mandate</strong> (never released), so its cumulative and
          velocity limits actually accumulate from the approvals it grants, not only from its own{" "}
          <code>authorize()</code> calls. A per-period cumulative cap on an approver mandate is a
          real ceiling on how much it can approve in that period, not just on how much it can
          spend directly.
        </p>
        <p style={{ maxWidth: 700 }}>
          Authority is <strong>single-level</strong>: an approver may authorize transactions but
          may not mint another approver, and cannot escalate a step-up further. If the approver&rsquo;s
          own <code>evaluate()</code> also returns <code>STEP_UP</code> for the action, the
          resolution declines with <code>DENY_APPROVER_WOULD_ESCALATE</code> — it does
          not chain to a second approver. A delegation-depth field is not currently reserved
          anywhere in <code>packages/core</code> — checked directly, not assumed — so this stays
          documented as a gap rather than a reservation that doesn&rsquo;t exist. The intent
          stands regardless of the naming: a delegation-depth field belongs in a future schema
          from the start, so chains can be added later without a migration.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Cycles.</strong> Rules 1 and 2 alone don&rsquo;t stop mutual approval — mandate A
          naming B as approver and B naming A back would let each resolve the other&rsquo;s
          step-ups with neither rule firing. A mandate naming itself (the degenerate 1-cycle) or
          two mandates naming each other (an exact mutual pair) is rejected at{" "}
          <strong>mandate creation</strong>, not at resolve time — <code>DENY_APPROVER_CYCLE</code>{" "}
          — checked by looking at whether the candidate approver&rsquo;s own current policy
          already names the mandate being created back. Cycles of three or more (A names B, B
          names C, C names A) are <strong>not</strong> caught here — that would need a full graph
          walk across every mandate in an organization on every creation, which this build doesn&rsquo;t
          do. That gap is accepted, not overlooked, because it&rsquo;s bounded by the ledger rule
          just above: <code>evaluate()</code> in a longer cycle still runs against each
          approver&rsquo;s own policy, and each approval still costs real, permanent budget on
          that approver&rsquo;s own mandate — a cycle can&rsquo;t be used to escalate authority
          without limit, only up to whatever the weakest link&rsquo;s own signed cumulative cap
          allows. See <code>DECISIONS.md</code> D-62 and <code>THREAT-MODEL.md</code> for this
          named as a bounded risk, not left undiscussed.
        </p>
        <p style={{ maxWidth: 700 }}>
          Approval authorizes <strong>one action</strong>. It never mutates <em>policy</em> on
          either mandate — no raised cap, no extended window, no new approver — approving a
          $9,000 purchase does not raise the mandate&rsquo;s per-transaction ceiling for the next
          one. (It does write the real ledger entry described above; that&rsquo;s ledger, not
          policy.)
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Single-use and idempotent.</strong> A step-up resolves at most once. A second
          resolve attempt on an already-resolved (or already-expired) step-up — from the same
          approver, a different approver, or anyone else — replays the recorded outcome and its
          reason codes; it never re-runs <code>evaluate()</code>. Two approvers resolving the same
          step-up simultaneously, or an approval racing the TTL sweep, settle atomically: first
          writer wins, every other caller gets the recorded outcome back, never an error and never
          a second decision.
        </p>
        <p style={{ maxWidth: 700 }}>
          Step-up classes resolve differently, and the distinction matters:
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(a) Needs-evidence</strong> (e.g. <code>STEP_UP_MERCHANT_UNVERIFIED</code>)
          would resolve the moment a better-attested source supplies the identifier — a
          rail&rsquo;s own callback corroborating a domain, for instance — with no approver, no
          human, at machine speed. This class of automatic resolution is SPECIFIED, not built: no
          code today re-evaluates a pending step-up when new evidence arrives, only when a real
          approver mandate explicitly resolves it. What is real today (D-34) is that the{" "}
          <em>same underlying trust rule</em> already runs on every fresh evaluation — a
          rail-attested merchant on a new request resolves to <code>VERIFIED</code> the same way
          it always does; nothing here re-checks a specific pending authorization automatically.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(b) Needs-higher-authority</strong> resolves via an approver mandate — real,
          shipped, described above and in the sequence below.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(c) Unresolvable</strong> is a <code>DENY</code> at evaluation time, not a
          step-up that sits around waiting to expire — consistent with OQ-1&rsquo;s resolution
          (D-27): a hard ceiling denies outright rather than escalating something that was never
          going to be approvable.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Expiry and fail direction:</strong> an unresolved step-up expires to{" "}
          <code>DENY</code>. <code>step_up.ttl_seconds</code> and the expiry-sweep path (D-31) are
          real, implemented today (see Escalation above), and hold identically whether the step-up
          is ever offered to an approver or not.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>The full sequence:</strong>
        </p>
        <pre>{`authorize()  ->  STEP_UP, status PENDING_STEP_UP
resolveStepUp(authorizationId, approver)
  -> approver's evaluate() ALLOW  ->  status STEP_UP_APPROVED
  -> approver's evaluate() DENY/STEP_UP  ->  status STEP_UP_DECLINED
asExecutable(decision)  ->  non-null exactly when STEP_UP_APPROVED (same as a fresh ALLOW)
execute(executable, params)  ->  status EXECUTED`}</pre>
        <p style={{ maxWidth: 700 }}>
          <code>STEP_UP_APPROVED</code> is executable the identical way <code>AUTHORIZED</code>{" "}
          is — <code>asExecutable()</code> has treated the two identically since before this
          section existed; D-62 didn&rsquo;t need to change that, only what can produce{" "}
          <code>STEP_UP_APPROVED</code> in the first place.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>D-59, closed:</strong> an agent credential could resolve its own step-up — the
          same agent key that produced a <code>STEP_UP</code> decision could immediately call the
          resolution endpoint on it, with no human, no second credential, and no code path that
          refused it, collapsing <code>STEP_UP</code> to the same outcome as <code>ALLOW</code> for
          anyone holding just that one key. Closed by requiring the resolving credential to belong
          to a <em>different</em>, named approver mandate: rejected with{" "}
          <code>DENY_STEP_UP_SELF_APPROVAL</code> if it&rsquo;s the same mandate, checked first,
          ahead of every other rule. An org-level credential — which has no agent identity at all
          — was never a valid resolver either, and still isn&rsquo;t: it can never match a real
          approver mandate&rsquo;s own agent key. Proven, not just described: the adversarial
          suite (<code>apps/api/src/authorization/service.test.ts</code>,{" "}
          <code>server.test.ts</code>) covers self-approval, a mandate not on the approvers list,
          an approver whose own policy caps below the amount, an approver at its own cumulative
          ceiling, TTL expiry racing resolution, the 1- and 2-cycle rejections at creation, a real
          runtime 3-cycle bounded by the ledger rule, and both concurrency races — plus a real,
          non-simulated Postgres regression test for a nested-transaction hazard the first live
          run against a real database surfaced.
        </p>
    </>
  );
}
