# Diagram sources

Five diagrams, each defined once here and used in two places:

| File | What it claims | Where it appears |
|---|---|---|
| `context.mmd` | Waysafe decides and never holds funds; both rails ask it before money moves. | THREAT-MODEL §0.1, `/docs`, `/docs/concepts` |
| `card.mmd` | The card lifecycle: decide, hold, increment, release, capture what settled, and flag what was never asked about. | THREAT-MODEL §0.2, `/docs/enforcement` |
| `x402.mmd` | On-chain, Waysafe fetches the payment requirements itself and holds one of two required signatures. | THREAT-MODEL §0.3, `/docs/enforcement`, `/proof` |
| `trust.mmd` | What an agent and a merchant can each assert, and what that assertion cannot produce. | THREAT-MODEL §0.4, `/docs/concepts` |
| `attackmap.mmd` | Ten attack surfaces, their controls, and what is still open. | THREAT-MODEL §0.5 only — deliberately not on the site. |

## The two copies, and the test that keeps them one

`docs/THREAT-MODEL.md` keeps its diagrams as **inline** ` ```mermaid ` blocks,
because GitHub renders those and a reader of that file should not have to
follow five links to see the system. So each diagram's text exists twice.

`docs/diagrams.test.ts` asserts every inline block is **byte-identical** to its
`.mmd` file. Not equivalent, not normalised — identical. A diagram edited in
one place and not the other fails the suite rather than quietly disagreeing
with itself.

The attack map is intentionally absent from the published site: it is a map of
what is still open, and it belongs next to the prose that qualifies each box.
`/docs/enforcement` links to the threat model as "what's still open" instead.

## Rendering

```bash
npm run diagrams -w @waysafe/site
```

Renders each `.mmd` to `apps/site/public/diagrams/<name>-dark.svg` and
`-light.svg` via `@mermaid-js/mermaid-cli`, in the site's own palette. The
SVGs are **committed**, so a site build needs no Chromium.

Each rendered SVG carries an HTML comment with the SHA-256 of the `.mmd` it
came from, and `docs/diagrams.test.ts` asserts those hashes match. A source
edited without re-rendering fails the suite instead of shipping a diagram that
shows the old system.
