/**
 * The published dictionaries say what the code does, and this file is what
 * makes that a checked claim rather than a hope.
 *
 * `apps/site` deliberately has no `@waysafe/core` or `@waysafe/api`
 * dependency (D-50): a static marketing site that imports the authorization
 * engine in order to render a table is a build graph nobody wants. The cost
 * is that `docs-content.tsx` is a **transcription**, and a transcription
 * falls behind.
 *
 * So these assertions read the real source files as text and compare sets.
 * Text, not imports, for the same reason: importing `reason-codes.ts` here
 * would work, but importing `apps/api`'s enforcement modules to enumerate
 * evidence event types would pull Stripe, Prisma and viem into a test about
 * a documentation table.
 *
 * Both directions matter. A code in the engine and not the table is an
 * undocumented public value; a code in the table and not the engine is a
 * promise about something that does not exist.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");

/**
 * Every evidence event type literal in the API's source.
 *
 * Matched on the literal rather than on `type:` specifically, because the
 * assignment is not always a plain field: D-84's handler picks between two
 * types with a ternary, and `writeStepUpEvidence` takes its type as a
 * parameter. A `type:`-anchored match found 8 of the 17 that exist, which is
 * the kind of guard that passes while proving nothing.
 */
function evidenceTypesInSource(): Set<string> {
  const found = new Set<string>();
  const PREFIXES = /^(agent_key|authorization|step_up|execution|refund|mandate|enforcement)\./;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(path);
        continue;
      }
      // Test files invent their own event types (`test.event`,
      // `latency.probe.*`) and are not part of the public dictionary.
      if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/"([a-z_][a-z_]*(?:\.[a-z_]+)+)"/g)) {
        if (PREFIXES.test(match[1]!)) found.add(match[1]!);
      }
    }
  };

  walk(join(REPO, "apps/api/src"));
  return found;
}

/** Codes declared in the engine's reason-code dictionary. */
function reasonCodesInSource(): Set<string> {
  const source = readFileSync(join(REPO, "packages/core/src/reason-codes.ts"), "utf8");
  // The ReasonCode const object: `KEY: "KEY",` -- taken from the keys, which
  // is the half the engine actually returns. The second table in that file
  // is descriptions, keyed by the same names.
  const body = source.slice(source.indexOf("export const ReasonCode"));
  const codes = new Set<string>();
  for (const match of body.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*"\1",$/gm)) codes.add(match[1]!);
  return codes;
}

/** Values listed in a `docs-content.tsx` table, by field name. */
function published(field: "code" | "type"): Set<string> {
  const source = readFileSync(join(__dirname, "docs-content.tsx"), "utf8");
  const start = source.indexOf(
    field === "code" ? "export const REASON_CODES" : "export const EVIDENCE_EVENT_TYPES",
  );
  expect(start, `docs-content.tsx has no ${field} table`).toBeGreaterThan(-1);
  const end = source.indexOf("\n];", start);
  const body = source.slice(start, end);
  const pattern = field === "code" ? /code:\s*"([A-Z0-9_]+)"/g : /type:\s*"([a-z_][a-z_.]+)"/g;
  return new Set([...body.matchAll(pattern)].map((m) => m[1]!));
}

describe("/docs/reference transcriptions match the code", () => {
  it("the reason-code table is exactly the engine's dictionary", () => {
    const engine = reasonCodesInSource();
    // Guards the guard: a regex that stopped matching would make every
    // assertion below compare two empty sets and pass.
    expect(engine.size).toBeGreaterThan(30);

    const table = published("code");
    expect([...engine].filter((c) => !table.has(c)), "in the engine, missing from /docs").toEqual([]);
    expect([...table].filter((c) => !engine.has(c)), "on /docs, absent from the engine").toEqual([]);
    expect(table.size).toBe(engine.size);
  });

  it("the evidence event table is exactly what the API appends", () => {
    const api = evidenceTypesInSource();
    expect(api.size).toBeGreaterThan(10);

    const table = published("type");
    expect([...api].filter((t) => !table.has(t)), "appended by the API, missing from /docs").toEqual(
      [],
    );
    expect([...table].filter((t) => !api.has(t)), "on /docs, never appended").toEqual([]);
  });

  it("the three card-settlement events added by D-83 and D-84 are documented", () => {
    // Named explicitly rather than left to the set comparison: these are the
    // events a principal needs in order to dispute a settlement nobody was
    // asked about, and "the sets happened to match" is a weaker statement
    // than "these three are there".
    const table = published("type");
    expect(table).toContain("enforcement.stripe_issuing.released");
    expect(table).toContain("enforcement.stripe_issuing.unauthorized_settlement");
    expect(table).toContain("enforcement.stripe_issuing.over_authorized_settlement");
  });

  it("authorization.decided is documented, now that the agent path emits it", () => {
    // D-90. Until then this type appeared only in the evidence repositories'
    // own tests, and documenting it would have been a claim about nothing.
    expect(published("type")).toContain("authorization.decided");
  });
});
