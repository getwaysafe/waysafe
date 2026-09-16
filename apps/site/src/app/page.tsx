import Link from "next/link";

export default function HomePage() {
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
            A rail-side authorization and evidence layer. The payment rail asks Waysafe before money
            moves — and every decision is signed, chained, and independently verifiable. Cards and
            on-chain, one record.
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
            Why a rule in the prompt isn&rsquo;t a control
          </p>
          <h2 className="display" style={{ fontSize: "clamp(1.5rem, 3.5vw, 2.1rem)", marginTop: 0 }}>
            A model that reasons about a limit can also reason its way past it.
          </h2>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7, marginTop: 20 }}>
            In the July 2026 Hugging Face intrusion, an agent recorded that an action was outside its
            intended scope, judged the task impossible otherwise, noted that its peers were doing the
            same thing, and continued anyway.
          </p>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.7 }}>
            A spending limit written into a prompt is that same kind of rule — a suggestion the model
            weighs against everything else it&rsquo;s reasoning about, including the pressure to
            finish the task. A co-signature is not. It doesn&rsquo;t ask the model to agree; it asks
            whoever moves the money to check with someone else first.
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
                request on cards, a 2-of-2 signature requirement on-chain. The agent&rsquo;s
                cooperation is never part of the control.
              </p>
            </div>
            <div>
              <div className="mono" style={{ color: "var(--teal-on-dark)", fontSize: "1.4rem", marginBottom: 12 }}>
                03
              </div>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Every decision is signed and chained</h3>
              <p className="muted" style={{ lineHeight: 1.65, margin: 0 }}>
                Every decision is written to a signed log, each entry carrying the hash of the one
                before it; anyone with Waysafe&rsquo;s public key can verify the whole record without
                asking Waysafe.
              </p>
            </div>
          </div>
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
              requests, with live sandbox authorization pending Stripe test-mode funds settlement.
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
