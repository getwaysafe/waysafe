/**
 * The diagrams have one source and two renderings, and this file is what
 * keeps the three in agreement.
 *
 *   docs/diagrams/<name>.mmd        the source
 *   docs/THREAT-MODEL.md            an inline ```mermaid block, for GitHub
 *   apps/site/public/diagrams/*.svg committed renderings, for the site
 *
 * Without these assertions the inline copy and the SVG each drift on their
 * own schedule, and a diagram that disagrees with the system is worse than
 * no diagram — it is a confident, wrong picture of how money is authorized.
 *
 * Byte-identical, not equivalent. A normalising comparison would accept a
 * copy that has been reformatted, and reformatting is exactly how the two
 * copies start diverging.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..");
const SOURCE_DIR = join(REPO, "docs/diagrams");
const SVG_DIR = join(REPO, "apps/site/public/diagrams");
const THREAT_MODEL = join(REPO, "docs/THREAT-MODEL.md");

/**
 * The order the diagrams appear in THREAT-MODEL.md §0. Written out rather
 * than derived, so that adding a diagram to the document without adding a
 * source file fails here instead of silently shifting the pairing by one.
 */
const ORDER = ["context", "card", "x402", "trust", "attackmap"] as const;

function inlineBlocks(): string[] {
  const markdown = readFileSync(THREAT_MODEL, "utf8");
  return [...markdown.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
}

describe("docs/diagrams — one source, two renderings", () => {
  it("every .mmd file is accounted for, in order", () => {
    const onDisk = readdirSync(SOURCE_DIR)
      .filter((f) => f.endsWith(".mmd"))
      .map((f) => f.replace(/\.mmd$/, ""))
      .sort();
    expect(onDisk).toEqual([...ORDER].sort());
  });

  it("THREAT-MODEL.md has exactly one inline block per source, in the same order", () => {
    // Guards the guard: if this count drifts, every per-diagram assertion
    // below would compare the wrong pair and could still pass.
    expect(inlineBlocks()).toHaveLength(ORDER.length);
  });

  describe.each(ORDER)("%s", (name) => {
    const source = readFileSync(join(SOURCE_DIR, `${name}.mmd`), "utf8");

    it("the inline block in THREAT-MODEL.md is byte-identical to the .mmd", () => {
      const index = ORDER.indexOf(name);
      const inline = inlineBlocks()[index];
      expect(
        inline,
        `docs/THREAT-MODEL.md's diagram ${index + 1} has drifted from docs/diagrams/${name}.mmd. ` +
          `Edit the .mmd, then copy it back into the markdown block.`,
      ).toBe(source.replace(/\n$/, ""));
    });

    it.each(["dark", "light"])("the committed %s SVG was rendered from this source", (scheme) => {
      const svg = readFileSync(join(SVG_DIR, `${name}-${scheme}.svg`), "utf8");
      const stamped = /<!-- source-sha256: ([0-9a-f]{64}) -->/.exec(svg)?.[1];
      const actual = createHash("sha256").update(source).digest("hex");
      expect(
        stamped,
        `apps/site/public/diagrams/${name}-${scheme}.svg is stale: it was rendered from a ` +
          `different version of docs/diagrams/${name}.mmd. Run ` +
          `\`npm run diagrams -w @waysafe/site\` and commit the result.`,
      ).toBe(actual);
    });

    it("the rendered SVG uses the site's own palette, not mermaid's defaults", () => {
      // The one visual property worth asserting mechanically: that the
      // render picked up the config at all. A render that silently fell back
      // to mermaid's default theme produces a perfectly valid SVG in the
      // wrong colours, which no other assertion here would catch.
      const dark = readFileSync(join(SVG_DIR, `${name}-dark.svg`), "utf8");
      const light = readFileSync(join(SVG_DIR, `${name}-light.svg`), "utf8");
      expect(dark).toContain("rgb(7, 17, 31)"); // --midnight
      expect(light).toContain("rgb(247, 249, 252)"); // --frost
      expect(dark).not.toBe(light);
    });
  });

  it("the attack map is NOT published to the site's pages", () => {
    // It is a map of what is still open, and each box is qualified by the
    // prose beside it in the threat model. The site links to that document
    // rather than lifting the picture out of its context.
    const pages = ["page.tsx", "docs/page.tsx", "docs/concepts/page.tsx", "docs/enforcement/page.tsx", "proof/page.tsx"];
    for (const page of pages) {
      const source = readFileSync(join(REPO, "apps/site/src/app", page), "utf8");
      expect(source, `${page} references the attack map`).not.toContain("attackmap-");
    }
  });
});
