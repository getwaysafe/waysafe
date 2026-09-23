import type { Metadata } from "next";
import { EVIDENCE_EXAMPLE } from "@/lib/docs-content";
import { CopyButton } from "@/components/CopyButton";

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
