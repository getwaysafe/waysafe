import type { Metadata } from "next";
import { QUICKSTART_COMMANDS, QUICKSTART_OUTPUT_ALLOW, QUICKSTART_OUTPUT_DENY } from "@/lib/docs-content";

export const metadata: Metadata = {
  title: "Quickstart — Waysafe docs",
  description:
    "Five commands from a clean clone to a real ALLOW from the real engine, running locally.",
};

export default function Page() {
  return (
    <>
        <h2 style={{ marginTop: 48 }}>Quickstart</h2>
        <p style={{ maxWidth: 700 }}>
          There&rsquo;s no hosted API yet — clone the public repo and this is the fastest path to
          a real decision: not a mock, the actual <code>evaluate()</code> engine, running locally.
          Verified from a clean clone just before writing this page, ~13.5 seconds end to end on a
          warm npm cache (a first install over the real network will take longer; nothing here
          waits on a database or a compiler API key):
        </p>
        <pre>{QUICKSTART_COMMANDS}</pre>
        <details style={{ maxWidth: 700, marginTop: 16, marginBottom: 16 }}>
          <summary style={{ cursor: "pointer" }}>
            Why this runs in-memory rather than against SQLite
          </summary>
          <p style={{ marginTop: 12 }}>
            <code>packages/db</code>&rsquo;s schema uses native Postgres enums, <code>String[]</code>{" "}
            columns, and (the disqualifying one) real <code>SELECT ... FOR UPDATE</code> row locking
            that the cumulative-spend guarantee depends on, none of which SQLite can express — so the
            in-memory adapter already built for <code>npm test</code> is the honest zero-setup path,
            not a shortcut around it.
          </p>
        </details>
        <p style={{ maxWidth: 700 }}>
          The build step is real, not optional — <code>dist/</code> is gitignored, so a clean
          clone has no <code>@waysafe/sdk</code> to import until it&rsquo;s built. Real,
          unedited output from that run, sections 1–4 (connect, compile, create and authenticate
          a mandate, and the first decision — an <strong>ALLOW</strong>, from the real engine):
        </p>
        <pre>{QUICKSTART_OUTPUT_ALLOW}</pre>
        <p style={{ maxWidth: 700 }}>Same run, same mandate, a purchase over the hard cap:</p>
        <pre>{QUICKSTART_OUTPUT_DENY}</pre>
        <p style={{ maxWidth: 700 }}>
          Sections 5–6 and 8–10 of the same run (execution, a step-up resolved by a real approver
          mandate after a rejected self-approval attempt (D-62), a typed SDK error, and
          independently verifying the signed evidence chain) are elided here for density — run{" "}
          <code>npm run quickstart</code> yourself to see them, or read{" "}
          <code>examples/quickstart.ts</code> directly.
        </p>
    </>
  );
}
