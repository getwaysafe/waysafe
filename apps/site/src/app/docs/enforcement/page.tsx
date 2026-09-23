import type { Metadata } from "next";
import { REPO_TREE } from "@/lib/docs-nav";

export const metadata: Metadata = {
  title: "Enforcement — Waysafe docs",
  description:
    "The two endpoints a payment rail calls before money moves, and what you build on your side.",
};

export default function Page() {
  return (
    <>
        <h2 style={{ marginTop: 56 }}>Enforcement</h2>
        <p style={{ maxWidth: 700 }}>
          The two endpoints a payment rail calls before money moves. Neither depends on the agent
          calling anything first — that&rsquo;s the difference between enforcement and the preflight
          SDK (see <a className="link" href="/docs/reference">Reference</a>). Shapes are transcribed from <code>apps/api/src/server.ts</code>,{" "}
          <code>apps/api/src/enforcement/</code>, and <code>packages/sdk/src/index.ts</code>.
        </p>

        <h3 style={{ marginTop: 40 }}>
          <code>POST /v1/enforcement/stripe-issuing</code>
        </h3>
        <p style={{ maxWidth: 700, marginBottom: 4 }}>
          Source:{" "}
          <a className="link" href={`${REPO_TREE}/apps/api/src/enforcement/stripe-issuing.ts`} target="_blank" rel="noopener noreferrer">
            apps/api/src/enforcement/stripe-issuing.ts
          </a>
        </p>
        <p style={{ maxWidth: 700 }}>
          Stripe&rsquo;s real-time authorization webhook, called by Stripe — not by the agent —
          when a card is presented. The inbound body is a standard Stripe event; only{" "}
          <code>issuing_authorization.request</code> is a synchronous decision this route owes a
          same-request answer to. The request must carry a valid <code>Stripe-Signature</code>{" "}
          header, verified against the Issuing webhook secret before anything is decided.
        </p>
        <pre>{`// inbound: a Stripe event, signature-verified before evaluation
{
  "type": "issuing_authorization.request",
  "data": {
    "object": {                          // Stripe.Issuing.Authorization
      "id": "iauth_...",
      "amount": 4200,                    // integer minor units, Stripe's own field
      "currency": "usd",
      "card": { "id": "ic_...", ... },   // resolved to a Waysafe Instrument
      "merchant_data": {
        "name": "STAPLES",
        "network_id": "...",             // rail-attested -- this is what makes it verifiable
        "category_code": "5943"
      }
    }
  }
}

// Waysafe's response -- exactly these two fields, nothing else
{ "approved": true, "reason_codes": ["ALLOW_WITHIN_MANDATE"] }`}</pre>
        <p style={{ maxWidth: 700 }}>
          Stripe reads only <code>approved</code>. <code>reason_codes</code> is Waysafe&rsquo;s own
          addition for observability (Stripe ignores unknown fields), so a caller can see which code
          a decline carried without a second round trip for evidence. Every response also carries the
          library&rsquo;s configured <code>Stripe-Version</code> header.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>The window is about two seconds.</strong> Miss it, or answer with anything
          malformed, and Stripe declines on its own. That timeout behavior is a Stripe account
          setting (&ldquo;decline on timeout,&rdquo; turned on for this account) — not something this
          codebase asserts or could enforce if it were ever switched off. Independent of that
          setting, the route fails closed on its own side in three specific ways:
        </p>
        <ul style={{ maxWidth: 700, lineHeight: 1.8 }}>
          <li>
            <strong>Unrecognized event type</strong> → <code>{`{ "approved": false, "reason_codes": [] }`}</code>
            . Deliberately empty: fail closed without fabricating a reason code for a decision{" "}
            <code>evaluate()</code> never made.
          </li>
          <li>
            <strong>No resolvable Waysafe instrument</strong> for the presented card → an explicit{" "}
            <code>DENY_NO_ACTIVE_MANDATE</code>. A card Waysafe never provisioned cannot buy
            anything, even if it was created directly against Stripe.
          </li>
          <li>
            <strong>A decision needing a human</strong> (<code>STEP_UP</code>) → also a decline.
            There is no channel to reach a person inside a two-second synchronous window.
          </li>
        </ul>
        <div className="card" style={{ marginTop: 8, marginBottom: 16, background: "#fff8e1", borderColor: "#f0c96b" }}>
          <p style={{ margin: 0 }}>
            <strong>Status:</strong> this path runs the real engine against{" "}
            <strong>recorded</strong> Stripe Issuing authorization requests today — real payloads,
            real decisions, replayed. Live sandbox authorization is pending Stripe&rsquo;s
            live Issuing onboarding.
          </p>
        </div>

        <h3 style={{ marginTop: 40 }}>
          <code>POST /v1/enforcement/x402</code>
        </h3>
        <p style={{ maxWidth: 700, marginBottom: 4 }}>
          Source:{" "}
          <a className="link" href={`${REPO_TREE}/apps/api/src/enforcement/x402.ts`} target="_blank" rel="noopener noreferrer">
            apps/api/src/enforcement/x402.ts
          </a>
        </p>
        <p style={{ maxWidth: 700 }}>
          On-chain, there is no third-party network to call Waysafe, so the caller is the
          agent&rsquo;s own runtime presenting its ordinary Bearer credential. That is not a weaker
          position, because of the rule that makes it safe:{" "}
          <strong>Waysafe never accepts payment requirements from the caller.</strong> The request
          supplies a <code>resource_url</code>; Waysafe fetches that resource itself and evaluates
          only what its own fetch returned. An agent cannot get itself co-signed by asserting what
          it&rsquo;s paying for.
        </p>
        <pre>{`// request
{
  "instrument_id": "inst_...",
  "resource_url": "https://merchant.example/paid-endpoint",  // Waysafe fetches this itself
  "session_signature": {                 // optional -- omit for a decision + co-signature only
    "nonce": 7,
    "signer": "0x...",                   // the agent's session key address
    "data": "0x..."                      // its partial Safe signature, never its private key
  }
}

// response
{
  "decision": "ALLOW",                   // or "DENY" / "STEP_UP"
  "reason_codes": ["ALLOW_WITHIN_MANDATE"],
  "co_signature": {                      // null for anything but a genuine ALLOW
    "pay_to": "0x...",
    "asset": "0x...",
    "network": "polygon-amoy",
    "amount_atomic": "100000",
    "resource": "https://merchant.example/paid-endpoint",
    "expires_at": "2026-09-16T03:29:03.431Z",
    "authorization_id": "auth_...",      // traces back to the evidence event
    "signature": "..."                   // Ed25519, over the canonical payload above
  },
  "mandate_id": "mdt_...",
  "safe_address": "0x...",
  "settlement": { "tx_hash": "0x..." }   // or { "error": "..." }, or null if not attempted
}`}</pre>
        <p style={{ maxWidth: 700 }}>
          <code>co_signature</code> is <code>null</code> for <code>DENY</code> and{" "}
          <code>STEP_UP</code> alike — same constraint as the card rail: no channel to put a human
          in front of a decision inside this window. The co-signature is an Ed25519 attestation over
          the payment intent; it has no EVM address and <strong>cannot itself move funds</strong>.
          Treating it as proof that money moved is trusting an off-chain claim, not on-chain
          enforcement.
        </p>
        <p style={{ maxWidth: 700 }}>
          What actually stops an unauthorized transfer is the <strong>2-of-2 Safe</strong> deployed
          per mandate: the agent&rsquo;s session key is one owner, Waysafe&rsquo;s secp256k1
          cosigner address is the other. Waysafe&rsquo;s signature is one of the two the Safe&rsquo;s
          own <code>execTransaction</code> requires to accept the call at all. A real session-key
          signature submitted alone is rejected by the contract itself, on-chain — broadcast and
          mined <code>reverted</code>, not simulated; see{" "}
          <a className="link" href="/proof">
            /proof
          </a>{" "}
          for the transaction hashes and revert reasons.
        </p>

        <h3 style={{ marginTop: 40 }}>What you build on your side</h3>
        <p style={{ maxWidth: 700 }}>
          <strong>Cards:</strong> point your Stripe Issuing real-time authorization webhook at{" "}
          <code>POST /v1/enforcement/stripe-issuing</code>, share the Issuing webhook secret, and
          turn on &ldquo;decline on timeout.&rdquo; That is the whole integration — no agent-side
          code, and nothing for an agent to skip.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>On-chain:</strong> deploy the 2-of-2 Safe per mandate with Waysafe&rsquo;s cosigner
          address as the second owner (<code>POST /v1/instruments/x402</code> provisions it), and
          have the agent&rsquo;s runtime call <code>POST /v1/enforcement/x402</code> with its session
          signature. The agent&rsquo;s cooperation buys it nothing it didn&rsquo;t already have: one
          signature against a threshold of two.
        </p>
    </>
  );
}
