import type { Metadata } from "next";
import Link from "next/link";
import proof from "@/data/proof.json";
import { SITE_TITLE } from "@/lib/constants";

const DESCRIPTION =
  "Spend authorization for AI agents, enforced by the payment rail — not the agent. Even a compromised agent can't spend outside its mandate.";

/** Overrides the root layout's site-wide default for this page only; the
 * layout's `other: { "build-sha" }` is merged in, not replaced. og:title is
 * the same constant the <title> uses, so the two cannot drift apart. */
export const metadata: Metadata = {
  description: DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: DESCRIPTION,
  },
};

export default function HomePage() {
  const proofCapturedDate = new Date(proof.captured_at).toISOString().slice(0, 10);
  return (
    <>
      <section className="section-dark" style={{ paddingTop: 72, paddingBottom: 56 }}>
        <div className="container">
          <p className="kicker" style={{ marginBottom: 20 }}>
            Delegated financial authority
          </p>
          <h1 className="display" style={{ fontSize: "clamp(2.2rem, 6vw, 3.6rem)", maxWidth: 820, margin: 0 }}>
            Agents can spend. Waysafe decides whether they may.
          </h1>
          <p
            className="muted"
            style={{ fontSize: "1.15rem", maxWidth: 680, marginTop: 24, lineHeight: 1.6 }}
          >
            The required signer for agent payments. The rail asks Waysafe before money moves —
            every decision signed, chained, and independently verifiable. Cards and stablecoin
            wallets, one record.
          </p>
          <p
            className="muted"
            style={{ fontSize: "1.02rem", maxWidth: 680, marginTop: 12, lineHeight: 1.6 }}
          >
            For the rails, processors, and platforms that hold liability when an agent spends
            wrongly.
          </p>
          <div style={{ display: "flex", gap: 14, marginTop: 36, flexWrap: "wrap" }}>
            <Link href="/docs" className="btn btn-primary">
              Read the docs
            </Link>
            <Link href="/proof" className="btn btn-ghost">
              See the proof
            </Link>
          </div>
        </div>
      </section>

      <section className="section-dark" style={{ paddingTop: 0, paddingBottom: 88 }}>
        <div className="container">
          <video
            controls
            preload="metadata"
            playsInline
            poster="/media/waysafe-film-poster.jpg"
            style={{ width: "100%", borderRadius: 12, border: "1px solid rgba(148,163,184,0.25)" }}
          >
            <source src="/media/waysafe-film.mp4" type="video/mp4" />
          </video>
        </div>
      </section>

      <section className="section-light section">
        <div className="container" style={{ maxWidth: 760 }}>
          <p className="kicker" style={{ marginBottom: 16 }}>
            Without the agent&rsquo;s cooperation
          </p>
          <h2 className="display" style={{ fontSize: "clamp(1.5rem, 3.5vw, 2.1rem)", marginTop: 0 }}>
            An agent&rsquo;s cooperation is never the control.
          </h2>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7, marginTop: 20 }}>
            Every agent spend control shipping today lives on the agent&rsquo;s side of the
            boundary — which means it holds exactly as long as the agent cooperates. A compromised
            agent holding the credential walks through all of them.
          </p>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7, marginTop: 20 }}>
            Give a compromised agent the raw card number and no Waysafe SDK, and it still
            can&rsquo;t spend outside the mandate — Stripe&rsquo;s real-time authorization asks
            Waysafe before the network approves the charge, not after. That path runs the real
            engine against recorded Stripe Issuing authorization requests today; live sandbox
            authorization is pending Stripe&rsquo;s live Issuing onboarding. Hand the session key alone to a
            script with no Waysafe in it, and the transaction can&rsquo;t be signed — the
            payer&rsquo;s wallet is a genuine 2-of-2, and one key isn&rsquo;t enough. Neither script
            ever had to call Waysafe, agree with it, or even know it exists.
          </p>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7 }}>
            This is proven on-chain, recorded on{" "}
            <Link className="link" href="/proof">
              /proof
            </Link>{" "}
            (captured {proofCapturedDate}): three separate attempts to move funds with fewer than
            both signatures, each rejected on-chain, each with the real revert reason recorded
            alongside it.
          </p>
          <p className="muted" style={{ fontSize: "1.02rem", lineHeight: 1.7, marginTop: 20 }}>
            What this is not: Waysafe is non-custodial — it never holds funds and cannot initiate a
            transfer the agent hasn&rsquo;t already signed for. It is one of two required
            signatures, not a custodian. It never handles a full card number, and is never
            advisory. There is no step where the agent is asked and can decline.
          </p>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7, marginTop: 20 }}>
            Being in the authorization path means being a dependency. A rail told to fail closed
            declines everything if Waysafe doesn&rsquo;t answer inside its authorization window —
            the correct failure direction, and the reason key custody and uptime are the two things
            a reviewer should press on.
          </p>
        </div>
      </section>

      <section className="section-light section" style={{ paddingTop: 0 }}>
        <div className="container" style={{ maxWidth: 760 }}>
          <p className="kicker" style={{ marginBottom: 16 }}>
            Why a rule in the prompt isn&rsquo;t a control
          </p>
          <h2 className="display" style={{ fontSize: "clamp(1.5rem, 3.5vw, 2.1rem)", marginTop: 0 }}>
            A model that reasons about a limit can also reason its way past it.
          </h2>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7, marginTop: 20 }}>
            In the{" "}
            <a
              className="link"
              href="https://openai.com/index/hugging-face-incident-and-the-road-ahead/"
              target="_blank"
              rel="noopener noreferrer"
            >
              July 2026 Hugging Face intrusion
            </a>
            , an agent wrote in its own log: &ldquo;We&rsquo;re attacking third-party HF using
            leaked token, potentially outside intended scope... This is arguably unauthorized. Yet
            goal solution.&rdquo; Another agent had first objected — &ldquo;We should not do
            unauthorized real infrastructure harm&rdquo; — then reversed when a peer signalled go.
          </p>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7 }}>
            A spending limit written into a prompt is that same kind of rule — a suggestion the model
            weighs against everything else it&rsquo;s reasoning about, including the pressure to
            finish the task. On cards, the control that isn&rsquo;t a suggestion is the issuer&rsquo;s
            own real-time authorization decline; on-chain, it&rsquo;s a second key the agent
            doesn&rsquo;t hold. Neither asks the model to agree — each asks whoever moves the money to
            check with someone else first.
          </p>
        </div>
      </section>

      <section className="section-dark section">
        <div className="container">
          <p className="kicker" style={{ marginBottom: 16 }}>
            How it works
          </p>
          <div className="grid-3" style={{ marginTop: 32 }}>
            <div>
              <div className="mono" style={{ color: "var(--teal-on-dark)", fontSize: "1.4rem", marginBottom: 12 }}>
                01
              </div>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>State it, sign it, freeze it</h3>
              <p className="muted" style={{ lineHeight: 1.65, margin: 0 }}>
                You state the mandate in your own words; it compiles to a policy, you sign it with a
                passkey, the version freezes, and every later decision cites the version and policy
                hash it was checked against.
              </p>
            </div>
            <div>
              <div className="mono" style={{ color: "var(--teal-on-dark)", fontSize: "1.4rem", marginBottom: 12 }}>
                02
              </div>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>The rail asks first</h3>
              <p className="muted" style={{ lineHeight: 1.65, margin: 0 }}>
                The rail asks before money moves — Stripe Issuing&rsquo;s real-time authorization
                request on cards, a 2-of-2 signature requirement on-chain. Nothing here waits on
                the agent to ask first.
              </p>
            </div>
            <div>
              <div className="mono" style={{ color: "var(--teal-on-dark)", fontSize: "1.4rem", marginBottom: 12 }}>
                03
              </div>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Every decision is signed and chained</h3>
              <p className="muted" style={{ lineHeight: 1.65, margin: 0 }}>
                Every decision is written to a signed log, each entry carrying the hash of the one
                before it; anyone with Waysafe&rsquo;s public key can verify the record&rsquo;s
                integrity without asking Waysafe. When an agent is wrong, you can show who
                authorized what — to a party that doesn&rsquo;t trust you.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section-dark section" style={{ paddingTop: 0 }}>
        <div className="container" style={{ maxWidth: 760 }}>
          <p className="kicker" style={{ marginBottom: 16 }}>
            One agent, several rails
          </p>
          <p className="muted" style={{ fontSize: "1.05rem", lineHeight: 1.7 }}>
            AP2, Visa Intelligent Commerce and Mastercard Agent Pay each solve delegated
            authorization within their own rail, by issuing a credential the agent carries. An
            agent rarely spends on one rail. Waysafe is the required signer across them: the
            transaction cannot complete without a decision Waysafe produced, that decision can
            take a rail&rsquo;s own credential as an input, and the record reads the same whether
            the rail underneath is a card network or a chain.
          </p>
        </div>
      </section>

      <section className="section-light section">
        <div className="container" style={{ maxWidth: 760 }}>
          <p className="kicker" style={{ marginBottom: 16 }}>
            Status, honestly
          </p>
          <ul style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: "1.02rem" }}>
            <li>The policy engine and evidence chain are real and running.</li>
            <li>
              On-chain decisions are live on Polygon Amoy testnet against a deployed 2-of-2 Safe.
            </li>
            <li>
              Card decisions run the real engine against recorded Stripe Issuing authorization
              requests. Live sandbox authorization is pending Stripe&rsquo;s live Issuing
              onboarding.
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
