/**
 * Public surfaces carry no internal identifiers.
 *
 * `D-78`, `OQ-14`, `R5`, "non-negotiable #3" are how this repository talks to
 * itself. They are precise, and they are useless to the audience the site and
 * the README are written for: someone evaluating whether to put Waysafe in
 * their authorization path, reading for ten minutes, who has never opened
 * `DECISIONS.md` and should not have to.
 *
 * A reference like that is not neutral. It either sends the reader somewhere
 * else or asks them to accept a claim whose support they cannot see. Both are
 * worse than writing the reason down.
 *
 * So every one was replaced with the plain-language reason it stood for, and
 * this test keeps them out. The decision log is still the record, and
 * `docs/THREAT-MODEL.md` links to it from one "Decision record:" line per
 * section, which is where a reader who does want the trail should find it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..");

/** `D-78`, `OQ-14`, `R5`, and the whole-word forms only. */
const IDENTIFIER = /\b(?:D|OQ|R)-\d+\b/g;
/** The internal name for the invariants, which the README now spells out. */
const INVARIANT = /non-negotiable/gi;

/**
 * Test files are not a public surface. Nothing in one is served, rendered or
 * read by anyone evaluating the product, and a test that cites the decision
 * it defends is more useful with the identifier than without it. This is the
 * one exclusion inside `apps/site/src`, and it is written out rather than
 * inferred so that adding a page can never quietly inherit it.
 */
const isTestFile = (path: string) => /\.test\.tsx?$/.test(path);

function filesUnder(dir: string, matches: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "out") continue;
        walk(path);
        continue;
      }
      if (matches(path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function publicSurfaces(): string[] {
  const site = filesUnder(
    join(REPO, "apps/site/src"),
    (path) => /\.(tsx?|css|mdx?)$/.test(path) && !isTestFile(path),
  );
  const diagrams = filesUnder(join(REPO, "docs/diagrams"), (path) => path.endsWith(".mmd"));
  return [...site, ...diagrams, join(REPO, "README.md")].sort();
}

/** Every match, with the line it sits on, for an error a reader can act on. */
function findIn(path: string, pattern: RegExp): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const found: string[] = [];
  lines.forEach((line, i) => {
    for (const match of line.matchAll(pattern)) {
      found.push(`${relative(REPO, path)}:${i + 1}  ${match[0]}  — ${line.trim().slice(0, 90)}`);
    }
  });
  return found;
}

describe("public surfaces speak plainly", () => {
  const surfaces = publicSurfaces();

  it("finds the surfaces it is supposed to be checking", () => {
    // Guards the guard. A walk that silently returned nothing would make
    // every assertion below pass against an empty list.
    expect(surfaces.length).toBeGreaterThan(12);
    expect(surfaces.some((p) => p.endsWith("README.md"))).toBe(true);
    expect(surfaces.filter((p) => p.endsWith(".mmd"))).toHaveLength(5);
    expect(surfaces.some((p) => p.endsWith("app/page.tsx"))).toBe(true);
    expect(surfaces.some((p) => p.endsWith("docs/reference/page.tsx"))).toBe(true);
  });

  it("carries no decision-log or review identifiers", () => {
    const found = surfaces.flatMap((path) => findIn(path, IDENTIFIER));
    expect(
      found,
      "Replace each with the plain-language reason it stood for. If a pointer " +
        "genuinely helps, link a named section of docs/THREAT-MODEL.md instead.\n" +
        found.join("\n"),
    ).toEqual([]);
  });

  it("does not call the invariants by their internal name", () => {
    const found = surfaces.flatMap((path) => findIn(path, INVARIANT));
    expect(found, found.join("\n")).toEqual([]);
  });

  /**
   * The allowlist, stated as an assertion rather than as a comment.
   *
   * `docs/THREAT-MODEL.md` and `SECURITY.md` are written for someone who
   * wants the trail, and both keep their identifiers inside links to the
   * decision log. The threat model additionally confines them to one
   * "Decision record:" line per section, which this checks.
   */
  it("THREAT-MODEL.md keeps every identifier inside a Decision record link", () => {
    const path = join(REPO, "docs/THREAT-MODEL.md");
    const offenders = readFileSync(path, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => IDENTIFIER.test(line) && !line.includes("DECISIONS.md#"))
      .map(({ line, n }) => `docs/THREAT-MODEL.md:${n}  ${line.trim().slice(0, 90)}`);
    expect(offenders, offenders.join("\n")).toEqual([]);

    const records = readFileSync(path, "utf8").match(/^\*\*Decision record:\*\*/gm) ?? [];
    expect(records.length).toBeGreaterThanOrEqual(10);
  });

  it("SECURITY.md keeps every identifier inside a link to the decision log", () => {
    const offenders = readFileSync(join(REPO, "SECURITY.md"), "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => IDENTIFIER.test(line) && !line.includes("DECISIONS.md#"))
      .map(({ line, n }) => `SECURITY.md:${n}  ${line.trim().slice(0, 90)}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
