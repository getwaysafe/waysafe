/**
 * Render docs/diagrams/*.mmd to apps/site/public/diagrams/<name>-{dark,light}.svg.
 *
 *   npm run diagrams -w @waysafe/site
 *
 * The `.mmd` files are the single source: `docs/THREAT-MODEL.md`'s inline
 * blocks and these SVGs both come from them, and `docs/diagrams.test.ts`
 * asserts both copies still match.
 *
 * The output is **committed**. mermaid-cli drives a headless Chromium, which
 * a static site build has no business needing — so rendering is a deliberate
 * local step, and a source edited without re-rendering fails the hash test
 * rather than shipping a diagram of the old system.
 *
 * On the palette: these are the site's own tokens, read from the same values
 * `globals.css` defines. The accent is the brand teal (`--teal-on-dark`
 * `#22b8be` / `--teal-on-light` `#008389`), not the `#29D3FF` cyan the first
 * `/film` pass used — D-46 replaced that placeholder with the real brand
 * mark and teal, and a diagram rendered in it would be the only place on the
 * site still carrying the retired accent.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SOURCE_DIR = join(REPO, "docs/diagrams");
const OUT_DIR = join(REPO, "apps/site/public/diagrams");

/** The site's tokens. See globals.css -- these are the same values. */
const PALETTE = {
  midnight: "#07111f",
  frost: "#f7f9fc",
  tealOnDark: "#22b8be",
  tealOnLight: "#008389",
  slate: "#64748b",
  slateLight: "#94a3b8",
  hairline: "#cbd5e1",
};

/**
 * One mermaid theme per scheme.
 *
 * `theme: "base"` plus explicit `themeVariables` rather than "dark"/"neutral":
 * the built-in themes pick their own accents, and the point here is that a
 * diagram looks like the rest of the page.
 *
 * `background` is set to the page's own ground rather than left transparent,
 * because these are served as <img> inside <picture> and an <img> cannot
 * inherit the page's background.
 *
 * Fonts are NOT embedded (`--no-font-embed`): embedding adds hundreds of
 * kilobytes of base64 per SVG for a face the page has already loaded from
 * Google Fonts, and the stack below falls back to Helvetica on a machine
 * without it.
 */
const THEMES = {
  dark: {
    background: PALETTE.midnight,
    themeVariables: {
      darkMode: true,
      background: PALETTE.midnight,
      primaryColor: "#102033",
      primaryTextColor: PALETTE.frost,
      primaryBorderColor: PALETTE.tealOnDark,
      secondaryColor: "#16283d",
      tertiaryColor: "#0d1b2c",
      lineColor: PALETTE.slateLight,
      textColor: PALETTE.frost,
      mainBkg: "#102033",
      nodeBorder: PALETTE.tealOnDark,
      clusterBkg: "rgba(34,184,190,0.06)",
      clusterBorder: "rgba(148,163,184,0.35)",
      titleColor: PALETTE.frost,
      edgeLabelBackground: PALETTE.midnight,
      // Sequence diagrams use their own variable names.
      actorBkg: "#102033",
      actorBorder: PALETTE.tealOnDark,
      actorTextColor: PALETTE.frost,
      actorLineColor: PALETTE.slateLight,
      signalColor: PALETTE.frost,
      signalTextColor: PALETTE.frost,
      labelBoxBkgColor: "#16283d",
      labelBoxBorderColor: PALETTE.tealOnDark,
      labelTextColor: PALETTE.frost,
      loopTextColor: PALETTE.frost,
      noteBkgColor: "#16283d",
      noteBorderColor: PALETTE.slateLight,
      noteTextColor: PALETTE.frost,
      sequenceNumberColor: PALETTE.midnight,
      activationBkgColor: PALETTE.tealOnDark,
    },
  },
  light: {
    background: PALETTE.frost,
    themeVariables: {
      darkMode: false,
      background: PALETTE.frost,
      primaryColor: "#ffffff",
      primaryTextColor: PALETTE.midnight,
      primaryBorderColor: PALETTE.tealOnLight,
      secondaryColor: "#eef4f4",
      tertiaryColor: "#f1f7f7",
      lineColor: PALETTE.slate,
      textColor: PALETTE.midnight,
      mainBkg: "#ffffff",
      nodeBorder: PALETTE.tealOnLight,
      clusterBkg: "rgba(0,131,137,0.05)",
      clusterBorder: PALETTE.hairline,
      titleColor: PALETTE.midnight,
      edgeLabelBackground: PALETTE.frost,
      actorBkg: "#ffffff",
      actorBorder: PALETTE.tealOnLight,
      actorTextColor: PALETTE.midnight,
      actorLineColor: PALETTE.slate,
      signalColor: PALETTE.midnight,
      signalTextColor: PALETTE.midnight,
      labelBoxBkgColor: "#eef4f4",
      labelBoxBorderColor: PALETTE.tealOnLight,
      labelTextColor: PALETTE.midnight,
      loopTextColor: PALETTE.midnight,
      noteBkgColor: "#eef4f4",
      noteBorderColor: PALETTE.hairline,
      noteTextColor: PALETTE.midnight,
      sequenceNumberColor: "#ffffff",
      activationBkgColor: PALETTE.tealOnLight,
    },
  },
};

/**
 * The attack map sets its own `classDef` fills for CLOSED / PARTIAL / OPEN,
 * and those are the diagram's only non-colour-dependent signal's backup --
 * the status word is in every box, so the fills are decoration. Left alone in
 * both schemes rather than re-themed per scheme, because a "closed" box that
 * is green on one background and something else on the other would be worse
 * than one green box.
 */
function mermaidConfig(scheme) {
  return {
    theme: "base",
    themeVariables: THEMES[scheme].themeVariables,
    // Short edge labels only, in every .mmd here: a flowchart edge label's
    // background box is sized for one line, so a <br/> inside one puts its
    // second line on top of whatever is below. Qualifiers belong in nodes.
    flowchart: { htmlLabels: true, curve: "basis", padding: 18, nodeSpacing: 70, rankSpacing: 140, wrappingWidth: 230 },
    sequence: { useMaxWidth: true, wrap: false, actorMargin: 60 },
    // Not the site's DM Sans: mermaid measures label widths in the headless
    // browser, which has no webfont loaded, so naming one it cannot load
    // means every box is sized for a font that is not the one drawn.
    fontFamily: "Helvetica, Arial, sans-serif",
  };
}

async function main() {
  const sources = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith(".mmd")).sort();
  if (sources.length === 0) throw new Error(`no .mmd files in ${SOURCE_DIR}`);

  await mkdir(OUT_DIR, { recursive: true });
  const tmp = join(OUT_DIR, ".tmp");
  await mkdir(tmp, { recursive: true });

  for (const file of sources) {
    const name = file.replace(/\.mmd$/, "");
    const source = await readFile(join(SOURCE_DIR, file), "utf8");
    const hash = createHash("sha256").update(source).digest("hex");

    for (const scheme of ["dark", "light"]) {
      const configPath = join(tmp, `${name}-${scheme}.json`);
      await writeFile(configPath, JSON.stringify(mermaidConfig(scheme)), "utf8");
      const outPath = join(OUT_DIR, `${name}-${scheme}.svg`);

      await execFileAsync(
        "npx",
        [
          "mmdc",
          "--input", join(SOURCE_DIR, file),
          "--output", outPath,
          "--configFile", configPath,
          "--backgroundColor", THEMES[scheme].background,
          // --size sets max-width on an SVG; responsiveness on the page is
          // the <img>'s own max-width:100%, this is just the natural size.
          "--size", "1600",
          "--no-font-embed",
          "--quiet",
        ],
        { cwd: REPO, maxBuffer: 32 * 1024 * 1024 },
      );

      // The provenance stamp the hash test reads. Written after rendering
      // rather than injected into the source, so it records the source that
      // was actually rendered.
      const svg = await readFile(outPath, "utf8");
      const stamped =
        `<!-- generated by apps/site/scripts/render-diagrams.mjs from docs/diagrams/${file} -->\n` +
        `<!-- source-sha256: ${hash} -->\n` +
        svg;
      await writeFile(outPath, stamped, "utf8");
      process.stdout.write(`  ${name}-${scheme}.svg  ${hash.slice(0, 12)}\n`);
    }
  }

  await rm(tmp, { recursive: true, force: true });
  process.stdout.write(`\n${sources.length} diagrams, 2 schemes each, in ${OUT_DIR}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
