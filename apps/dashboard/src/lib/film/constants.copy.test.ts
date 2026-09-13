/**
 * D-45: proves `constants.ts` actually matches `design/film-storyboard/`
 * word for word, rather than merely claiming to in a comment. Reads each
 * storyboard frame's real HTML and asserts the relevant constant appears in
 * it as a literal substring -- including the exact typographic
 * apostrophes/quotes/dashes the storyboard uses, since a normalized ASCII
 * copy would silently fail this check the same way a genuinely different
 * sentence would.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_REASONING_ATTRIBUTION,
  AGENT_REASONING_QUOTE,
  ALLOW_SPEND_LINE,
  ATTACKER_NOTIFICATIONS,
  COMPROMISE_CAPTION,
  COMPROMISE_HEADLINE_LINE_1,
  COMPROMISE_HEADLINE_LINE_2,
  END_CARD_LINE_1A,
  END_CARD_LINE_1B,
  END_CARD_LINE_3,
  EVIDENCE_BODY,
  FILM_INSTRUCTION,
  STABLECOIN_HEADLINE_LINE_1,
  STABLECOIN_HEADLINE_LINE_2,
  STABLECOIN_THRESHOLD_CAPTION,
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

  it("frame 03: the three attacker notifications, unchanged", () => {
    const html = storyboard("03-drain-empty.html");
    for (const n of ATTACKER_NOTIFICATIONS) {
      expect(html).toContain(n.rowTitle);
      expect(html).toContain(n.rowSubtitle);
      expect(html).toContain(n.notifTitle);
      expect(html).toContain(n.notifMessage);
    }
  });

  it("frame 04: the mandate, unchanged", () => {
    const html = storyboard("04-replay-intro.html");
    // The storyboard wraps the instruction in curly quotes as one text node;
    // FILM_INSTRUCTION is the sentence itself, so check it as a contained
    // substring rather than requiring the surrounding quote marks too.
    expect(html).toContain(FILM_INSTRUCTION);
  });

  it("frame 06: the quote, its attribution, and both signature captions, unchanged", () => {
    const html = storyboard("06-quote-decline-stablecoin.html");
    expect(html).toContain(AGENT_REASONING_QUOTE);
    expect(html).toContain(AGENT_REASONING_ATTRIBUTION);
    expect(html).toContain(STABLECOIN_HEADLINE_LINE_1);
    expect(html).toContain(STABLECOIN_HEADLINE_LINE_2);
    expect(html).toContain(STABLECOIN_THRESHOLD_CAPTION);
  });

  it("frame 07: the allow spend line, given verbatim by the task", () => {
    const html = storyboard("07-allow-fleet-glimpse.html");
    expect(html).toContain(ALLOW_SPEND_LINE);
  });

  it("frame 08: the four-sentence evidence body", () => {
    const html = storyboard("08-receipt-chain-verify.html");
    expect(html).toContain(EVIDENCE_BODY);
  });

  it("frame 09: Who pays? and both answers, unchanged", () => {
    const html = storyboard("09-aftermath.html");
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
