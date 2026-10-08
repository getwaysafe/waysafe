import type { Metadata } from "next";
import { EVIDENCE_EXAMPLE } from "@/lib/docs-content";
import { CopyButton } from "@/components/CopyButton";
import { Diagram } from "@/components/Diagram";

export const metadata: Metadata = {
  title: "Concepts — Waysafe docs",
  description:
    "Mandate, mandate version, authorization, and evidence entry -- the four objects, in the order they come into existence.",
};

export default function Page() {
  return (
    <>
        <h2 style={{ marginTop: 56 }}>Concepts</h2>
        <p style={{ maxWidth: 700 }}>
          Four objects, in the order they come into existence. Skip this if you just ran the
          quickstart above — you already saw all four.
        </p>

        <Diagram
          name="context"
          minWidth={900}
          alt={"Waysafe sits between the principal who signs a policy and the two payment rails that settle: Stripe asks it before any card charge, and the Safe cannot settle on one signature, so both rails reach the merchant only through a decision Waysafe made. The agent's own call to Waysafe is a preflight, never a control."}
          caption="Who holds which key, and who asks whom."
        />

        <Diagram
          name="trust"
          minWidth={820}
          alt={"Anything an agent asserts -- a merchant name, a PSP account id, a payee address, which resource URL to fetch -- caps at STEP_UP rather than producing ALLOW, and the asset decimals a merchant declares are overridden by Waysafe's own registry. Neither an agent nor a merchant can forge an evidence signature, raise a limit, or turn its own STEP_UP into an ALLOW."}
          caption={
            <>
              What each party can assert, and what that assertion cannot produce. The rule behind
              every row: trust comes from <em>who attested</em> an identifier, never from which
              field it arrived in.
            </>
          }
        />
        <p style={{ maxWidth: 700 }}>
          <strong>Mandate.</strong> A stable handle: which principal, and a lifecycle status
          (<code>PENDING_AUTHENTICATION</code>, <code>ACTIVE</code>, <code>EXPIRED</code>,{" "}
          <code>REVOKED</code>, <code>SUPERSEDED</code>). It carries no policy of its own.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Mandate version.</strong> The actual policy — immutable once written: the
          compiled policy, the original instruction text, a SHA-256 <code>policy_hash</code>,
          and the agents it delegates to. A Mandate points at one current version. Authenticated
          once by the principal over WebAuthn; editing writes a new version rather than mutating
          this one, so an authorization can always cite the exact bytes it was decided against,
          even after the mandate changes.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Authorization.</strong> One decision: <code>evaluate()</code> run against a
          specific mandate version&rsquo;s policy for one proposed action, at one instant. Cites
          that <code>mandate_version_id</code> and <code>policy_hash</code> directly. Always
          exactly one of <code>ALLOW</code>, <code>DENY</code>, or <code>STEP_UP</code>.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Evidence entry.</strong> One append-only, hash-chained, signed log row
          recording that something happened — a mandate version authenticated, a decision made.
          Real example, from the same captured run <code>/proof</code> publishes:
        </p>
        {EVIDENCE_EXAMPLE && (
          <div style={{ position: "relative" }}>
            <CopyButton text={JSON.stringify(EVIDENCE_EXAMPLE, null, 2)} />
            <pre>{JSON.stringify(EVIDENCE_EXAMPLE, null, 2)}</pre>
          </div>
        )}
    </>
  );
}
