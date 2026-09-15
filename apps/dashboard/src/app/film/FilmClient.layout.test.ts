import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D-49: a regression guard for the exact bug class that produced frames
 * 05/06/07/09's real text overlaps -- a child positioned with its own
 * `top` inside one of `FilmClient.tsx`'s left-column flex containers,
 * silently assuming a height its neighbor's real content (three reason
 * codes, a three-line "signed" row, a three-line headline) then grew past.
 *
 * What this is NOT, and why: the task asked for a test that renders each
 * frame at 1920x1080 with representative data and asserts no two sibling
 * text blocks' real bounding boxes overlap. That is not practical in this
 * repository's test harness, for two independent reasons, either one
 * sufficient on its own:
 *
 *   1. `vitest.config.ts` runs this suite with `environment: "node"` -- no
 *      DOM at all, not even jsdom. Switching a single test file to jsdom
 *      would not actually help: jsdom implements the DOM API surface but
 *      has no real layout or font-metrics engine, so `getBoundingClientRect()`
 *      always returns a zero-sized rect at (0,0) for every element,
 *      regardless of its real CSS. An "overlap" assertion built on that
 *      would pass or fail on the geometry of nothing -- exactly the
 *      vacuous test the task explicitly warned against writing.
 *   2. Even with a real browser (Playwright/Puppeteer -- not part of this
 *      project's test infrastructure at all today), `FilmClient`'s real
 *      per-frame content only exists after its own `useEffect` completes
 *      a real, unmocked round trip to `/api/demo/mandate`, `/api/demo/card`,
 *      `/api/demo/bypass`, `/api/demo/pay`, and `/api/demo/evidence`.
 *      Reaching any specific frame deterministically would need a running
 *      API server, fetch/timer mocking, and driving the component through
 *      `act()` cycles to force `elapsedMs` to an arbitrary beat -- a real
 *      browser-based E2E harness, not a quick regression test.
 *
 * What this DOES check, honestly: the actual, mechanical invariant that
 * prevents this bug class from recurring, applied directly to
 * `FilmClient.tsx`'s own source rather than to anything rendered. Every
 * frame whose left column uses the shared `LEFT_COLUMN_STYLE` flex
 * container (01/02/03/05/06 (both sub-beats)/07/08/09 -- 04 and 10 are
 * fully centered, a different layout, and were never in scope for this
 * container) is a real, current fact this test locates and counts, not
 * assumed; within each one, no child may carry its own `top` -- the flex
 * column is what's responsible for vertical position now, not a per-child
 * absolute offset. This cannot catch every possible visual overlap (two
 * siblings inside the same flex row could still theoretically be sized to
 * collide), but it directly guards the specific, real defect this
 * decision fixes and would fail immediately if it recurred.
 */

const SOURCE_PATH = join(process.cwd(), "apps", "dashboard", "src", "app", "film", "FilmClient.tsx");

function findLeftColumnSpans(source: string): string[] {
  const spans: string[] = [];
  const markerRe = /<div\s+style=\{(?:LEFT_COLUMN_STYLE\}|\{\s*\.\.\.LEFT_COLUMN_STYLE\b)/g;
  let marker: RegExpExecArray | null;
  while ((marker = markerRe.exec(source))) {
    // The two known opening-tag shapes (`style={LEFT_COLUMN_STYLE}` and
    // `style={{ ...LEFT_COLUMN_STYLE, width: N }}`) never contain a literal
    // `>` before the tag's own close, so the first `>` at/after the marker
    // really is the end of this specific opening tag.
    const tagOpenEnd = source.indexOf(">", marker.index) + 1;
    // Captures whether a `<div ...>` tag is self-closing (`<div ... />`, e.g.
    // frame 09's own divider) -- those never get a matching `</div>` and
    // must not count as opening a new nesting level, or every span past one
    // silently miscounts and never finds its own real closing tag.
    const tagRe = /<div\b[^>]*?(\/)?>|<\/div>/g;
    tagRe.lastIndex = tagOpenEnd;
    let depth = 1;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(source))) {
      if (tag[0] === "</div>") {
        depth -= 1;
        if (depth === 0) {
          spans.push(source.slice(tagOpenEnd, tag.index));
          break;
        }
      } else if (!tag[1]) {
        depth += 1;
      }
    }
  }
  return spans;
}

/** Matches a bare `top` style key (`top: 250`, `top:'0'`) but not a
 * camelCase key that merely ends in "Top" (`marginTop`, `paddingTop`,
 * `borderTop`, ...), which are unrelated, legitimate spacing properties
 * several of these spans genuinely use. */
const BARE_TOP_KEY = /(?<![A-Za-z])top\s*:/;

describe("/film FilmClient.tsx left-column containers never let a child carry its own `top` (D-49)", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const spans = findLeftColumnSpans(source);

  it("finds every current left-column container -- not zero, not silently fewer than expected", () => {
    // 01, 02, 03, 05, 06 (quote sub-beat), 06 (decline-stablecoin), 07, 08,
    // 09 -- nine as of D-49. A future frame adopting the same container
    // only ever adds to this count; a refactor that stops using
    // `LEFT_COLUMN_STYLE` entirely (and this test along with it) is the
    // only way this number goes down, and would need its own deliberate
    // update here.
    expect(spans.length).toBe(9);
  });

  it("contains no bare `top` style key inside any left-column container", () => {
    for (const [i, span] of spans.entries()) {
      expect(BARE_TOP_KEY.test(span), `left-column container #${i + 1} has a child with its own \`top\``).toBe(false);
    }
  });
});
