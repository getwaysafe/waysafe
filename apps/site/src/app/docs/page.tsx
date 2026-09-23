import type { Metadata } from "next";
import Link from "next/link";
import { DOCS_NAV, REPO, REPO_TREE } from "@/lib/docs-nav";

export const metadata: Metadata = {
  title: "Docs — Waysafe",
  description:
    "The rail-initiated enforcement endpoints, the preflight SDK reference, and the full reason-code dictionary.",
};

export default function DocsOverviewPage() {
  const cards = DOCS_NAV.filter((item) => item.href !== "/docs");

  return (
    <>
      <p className="kicker">Docs</p>
      <h1 className="display" style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)", marginTop: 8 }}>
        Waysafe
      </h1>
      <p style={{ fontSize: "1.05rem", maxWidth: 700, lineHeight: 1.7 }}>
        Waysafe decides whether an AI agent may take an economic action. A principal states an
        authority in their own words; it compiles to a policy, they sign it with a passkey, and the
        version freezes. From then on every spend is checked against that exact policy by
        deterministic code, and every decision is written to a signed, hash-chained log anyone can
        verify without trusting Waysafe.
      </p>

      <div
        className="card"
        style={{ marginTop: 24, marginBottom: 8, background: "#f1f7f7", borderColor: "#9ac9cb" }}
      >
        <p style={{ margin: 0, fontSize: "1.02rem", lineHeight: 1.65 }}>
          <strong>The one rule:</strong> the rail asks Waysafe before money moves; the agent never
          has to. Anything that depends on the agent calling Waysafe first is a{" "}
          <em>preflight</em> — useful, never the thing that stops a payment.
        </p>
      </div>

      <h2 style={{ marginTop: 44 }}>What you can build</h2>
      <ul style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: "1.02rem", maxWidth: 760 }}>
        <li>
          <strong>A card program.</strong> Point your Stripe Issuing real-time authorization
          webhook at Waysafe; the network declines anything outside the mandate, with no agent-side
          code at all.
        </li>
        <li>
          <strong>Wallet / x402 infrastructure.</strong> Deploy a 2-of-2 Safe per mandate with
          Waysafe as the second owner; a transfer the policy refuses simply cannot be signed.
        </li>
        <li>
          <strong>An agent platform.</strong> Call <code>authorize()</code> as a preflight to get a
          decision and a receipt before acting — with a real rail behind it doing the enforcing.
        </li>
      </ul>

      <h2 style={{ marginTop: 44 }}>Start here</h2>
      <div className="docs-cards">
        {cards.map((item) => (
          <Link key={item.href} href={item.href} className="docs-card">
            <strong>{item.label}</strong>
            <span>{item.blurb}</span>
          </Link>
        ))}
      </div>

      <h2 style={{ marginTop: 48 }}>Status, honestly</h2>
      <ul style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: "1.02rem", maxWidth: 760 }}>
        <li>The policy engine and evidence chain are real and running.</li>
        <li>
          On-chain decisions are live on Polygon Amoy testnet against a deployed 2-of-2 Safe.
        </li>
        <li>
          Card decisions run the real engine against recorded Stripe Issuing authorization
          requests. Live sandbox authorization is pending Stripe&rsquo;s live Issuing onboarding.
        </li>
      </ul>

      <h2 style={{ marginTop: 48 }}>Source</h2>
      <p style={{ maxWidth: 760 }}>
        Everything described here is public source. Read{" "}
        <a className="link" href={REPO} target="_blank" rel="noopener noreferrer">
          github.com/getwaysafe/waysafe
        </a>{" "}
        — or go straight to{" "}
        <a
          className="link"
          href={`${REPO_TREE}/docs/THREAT-MODEL.md`}
          target="_blank"
          rel="noopener noreferrer"
        >
          docs/THREAT-MODEL.md
        </a>
        , which inventories every key, what five compromise scenarios actually yield, what the
        evidence chain does and does not prove, and the gaps that are still open.
      </p>
    </>
  );
}
