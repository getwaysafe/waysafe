/**
 * D-45 (copy revised by D-46): proves `constants.ts` actually matches
 * `design/film-storyboard/` word for word, rather than merely claiming to
 * in a comment. Reads each storyboard frame's real HTML and asserts the
 * relevant constant appears in it as a literal substring -- including the
 * exact typographic apostrophes/quotes/dashes the storyboard uses, since a
 * normalized ASCII copy would silently fail this check the same way a
 * genuinely different sentence would.
 *
 * Deliberately NOT checked here (each is real, run-specific data, or new
 * copy the storyboard never had, not storyboard-literal text): the
 * receipt/chain's own hex values (D-45), `RECEIPT_REAL_TAG`'s
 * predecessor's honesty wording (removed by D-46, see its own note),
 * `END_CARD_FOOTNOTE` (D-46 -- a brand-new disclosure, not storyboard
 * copy), the real Safe revert lines beyond their two fixed GS020
 * sentences (`SAFE_REVERT_BALANCE_SUFFIX` -- "balance unchanged" as of
 * the D-49 follow-up, which dropped the dramatized dollar figure that
 * used to sit next to it -- is combined with the real Safe's own address
 * at render time, tested separately in `safe-revert.test.ts`), and
 * `AGENT_REASONING_QUOTE`/`AGENT_REASONING_ATTRIBUTION` (D-47 follow-up --
 * kept exported for DECISIONS.md D-32's own citation, but no longer
 * rendered anywhere, so there is nothing left to check them against).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOW_HEADLINE_LINE_1,
  ALLOW_HEADLINE_LINE_2,
  ALLOW_KICKER,
  ALLOW_SPEND_LINE,
  ATTACKER_NOTIFICATIONS,
  COMPROMISE_CAPTION,
  COMPROMISE_HEADLINE_LINE_1,
  COMPROMISE_HEADLINE_LINE_2,
  DECLINE_MERCHANT_NOTE,
  DECLINE_SIGNED_LINES,
  DRAIN_BODY,
  END_CARD_LINE_1A,
  END_CARD_LINE_1B,
  END_CARD_LINE_3,
  EVIDENCE_BODY,
  FILM_INSTRUCTION,
  MANDATE_CARD_FOOTER,
  QUOTE_HEADLINE_LINE_1,
  QUOTE_HEADLINE_LINE_2,
  QUOTE_KICKER,
  QUOTE_SOURCE_LINE,
  RESULTS_KICKER,
  SAFE_PANEL_LABEL,
  STABLECOIN_HEADLINE_LINE_1,
  STABLECOIN_HEADLINE_LINE_2,
  STABLECOIN_THRESHOLD_CAPTION,
  VERIFIED_BAR_TEXT,
  WHO_PAYS_LEFT_ANSWER,
  WHO_PAYS_QUESTION,
  WHO_PAYS_RIGHT_ANSWER,
} from "./constants";

const STORYBOARD_DIR = join(process.cwd(), "design", "film-storyboard");

function storyboard(name: string): string {
  return readFileSync(join(STORYBOARD_DIR, name), "utf8");
}

describe("/film constants match design/film-storyboard/ word for word (D-45)", () => {
  it("frame 02: the compromise headline and terminal caption", () => {
    const html = storyboard("02-compromise.html");
    expect(html).toContain(COMPROMISE_HEADLINE_LINE_1);
    expect(html).toContain(COMPROMISE_HEADLINE_LINE_2);
    expect(html).toContain(COMPROMISE_CAPTION);
  });

  it("frame 03: the three attacker notifications and the D-46 caption", () => {
    const html = storyboard("03-drain-empty.html");
    for (const n of ATTACKER_NOTIFICATIONS) {
      expect(html).toContain(n.rowTitle);
      expect(html).toContain(n.rowSubtitle);
      expect(html).toContain(n.notifTitle);
      expect(html).toContain(n.notifMessage);
    }
    expect(html).toContain(DRAIN_BODY);
  });

  it("frame 04: the mandate and its D-46 footer", () => {
    const html = storyboard("04-replay-intro.html");
    // The storyboard wraps the instruction in curly quotes as one text node;
    // FILM_INSTRUCTION is the sentence itself, so check it as a contained
    // substring rather than requiring the surrounding quote marks too.
    expect(html).toContain(FILM_INSTRUCTION);
    expect(html).toContain(MANDATE_CARD_FOOTER);
  });

  it("frame 05: the D-46 merchant note and the three signed lines", () => {
    const html = storyboard("05-decline-card-1.html");
    expect(html).toContain(DECLINE_MERCHANT_NOTE);
    for (const line of DECLINE_SIGNED_LINES) {
      expect(html).toContain(line);
    }
  });

  it("frame 06: the D-47 paraphrase kicker/headline/source line, both signature captions, and the D-46 panel label", () => {
    const html = storyboard("06-quote-decline-stablecoin.html");
    expect(html).toContain(QUOTE_KICKER);
    expect(html).toContain(QUOTE_HEADLINE_LINE_1);
    expect(html).toContain(QUOTE_HEADLINE_LINE_2);
    expect(html).toContain(QUOTE_SOURCE_LINE);
    expect(html).toContain(STABLECOIN_HEADLINE_LINE_1);
    expect(html).toContain(STABLECOIN_HEADLINE_LINE_2);
    expect(html).toContain(STABLECOIN_THRESHOLD_CAPTION);
    expect(html).toContain(SAFE_PANEL_LABEL);
  });

  it("frame 07: the D-46 kicker, headline, and the allow spend line", () => {
    const html = storyboard("07-allow-fleet-glimpse.html");
    expect(html).toContain(ALLOW_KICKER);
    expect(html).toContain(ALLOW_HEADLINE_LINE_1);
    expect(html).toContain(ALLOW_HEADLINE_LINE_2);
    expect(html).toContain(ALLOW_SPEND_LINE);
  });

  it("frame 08: the evidence body (D-46's sentence 3) and the D-46 verified-bar text", () => {
    const html = storyboard("08-receipt-chain-verify.html");
    expect(html).toContain(EVIDENCE_BODY);
    expect(html).toContain(VERIFIED_BAR_TEXT);
  });

  it("frame 09: the D-46 kicker, Who pays?, and both D-46 answers", () => {
    const html = storyboard("09-aftermath.html");
    expect(html).toContain(RESULTS_KICKER);
    expect(html).toContain(WHO_PAYS_QUESTION);
    expect(html).toContain(WHO_PAYS_LEFT_ANSWER);
    expect(html).toContain(WHO_PAYS_RIGHT_ANSWER);
  });

  it("frame 10: the end card headline and footer, unchanged", () => {
    const html = storyboard("10-endcard.html");
    expect(html).toContain(END_CARD_LINE_1A);
    expect(html).toContain(END_CARD_LINE_1B);
    expect(html).toContain(END_CARD_LINE_3);
  });
});
