/**
 * D-74: the one literal the unique index excludes must stay unmintable.
 *
 * `authorizations_one_decision_per_external_ref` is a *partial* unique index.
 * It excludes exactly one value — `iauth_demo_goodbeans_card_9001` — because
 * six historical `/film` demo rows carry it and cannot be deleted: each is the
 * `subjectId` of an evidence event, and two sit inside the contiguous,
 * published chain slice `/proof` displays (sequences 440 and 442 of
 * `org_demo`), so removing them would leave published provenance pointing at
 * nothing.
 *
 * That exclusion is safe only because the route that minted the value can no
 * longer produce it. This file is what keeps that true. Without it the
 * exemption could widen silently: someone simplifies the id back to
 * `iauth_demo_${networkId}`, the index quietly stops protecting that path, and
 * nothing fails.
 *
 * Deliberately asserted as **one literal, never a pattern**. A test that
 * accepted "any id containing an instrument id" would still pass if the
 * excluded literal came back by some other route; a test that excluded
 * `iauth_demo_*` wholesale would license exactly the generalization D-74
 * refused.
 */

import { describe, expect, it } from "vitest";
import {
  CARD_REPLAY_SCENARIOS,
  PROOF_CARD_REPLAY_SCENARIOS,
  demoIssuingAuthorizationId,
} from "./routes.js";

/** The single value `manual-constraints.sql` names. Hardcoded on purpose:
 * if the SQL's literal and this one ever disagree, that is the bug. */
const EXCLUDED_LITERAL = "iauth_demo_goodbeans_card_9001";

/** A realistic per-run instrument id — `generateId(ID_PREFIX.instrument)` shape. */
const INSTRUMENT = "inst_01m2rbf7xk0000000000000000";

describe("D-74: the demo route cannot mint the one externalRef the index excludes", () => {
  it("never produces the excluded literal, for any scenario in either real list", () => {
    const scenarios = [...CARD_REPLAY_SCENARIOS, ...PROOF_CARD_REPLAY_SCENARIOS];
    // Guards the guard: if someone empties the lists, the loop below would
    // assert nothing at all.
    expect(scenarios.length).toBeGreaterThanOrEqual(5);

    for (const [index, scenario] of scenarios.entries()) {
      const id = demoIssuingAuthorizationId(INSTRUMENT, index, scenario.networkId);
      expect(id, scenario.networkId).not.toBe(EXCLUDED_LITERAL);
      // Both segments are load-bearing, so both are asserted: the per-run
      // nonce, and the within-run disambiguator.
      expect(id, scenario.networkId).toContain(INSTRUMENT);
      expect(id, scenario.networkId).toContain(`_${index}_`);
    }
  });

  it("produces the excluded literal for NO instrument id, index, or merchant — not merely for the realistic ones", () => {
    // The format itself is what makes the exclusion closed. Every id carries
    // the instrument segment, so the bare `iauth_demo_<networkId>` shape is
    // unreachable regardless of inputs.
    const hostileInputs: Array<[string, number, string]> = [
      ["", 0, "goodbeans_card_9001"],
      ["goodbeans_card_9001", 0, ""],
      ["inst_x", -1, "goodbeans_card_9001"],
      ["inst_x", 9001, "goodbeans_card_9001"],
      // The exact shape of the old scheme, fed in as a network id.
      ["inst_x", 0, EXCLUDED_LITERAL],
    ];
    for (const [instrument, index, networkId] of hostileInputs) {
      expect(demoIssuingAuthorizationId(instrument, index, networkId)).not.toBe(
        EXCLUDED_LITERAL,
      );
    }
  });

  it("NEGATIVE CONTROL: the pre-D-74 scheme did produce it, and produced a collision within one run", () => {
    // Without this, the two tests above would pass against any id format at
    // all and prove nothing about what was actually fixed.
    const oldScheme = (networkId: string) => `iauth_demo_${networkId}`;
    expect(oldScheme("goodbeans_card_9001")).toBe(EXCLUDED_LITERAL);

    // And the collision was within a single run, not across runs: /proof's
    // list names one merchant for two different amounts.
    const oldIds = PROOF_CARD_REPLAY_SCENARIOS.map((s) => oldScheme(s.networkId));
    expect(new Set(oldIds).size).toBeLessThan(oldIds.length);

    // The fixed scheme keeps them distinct.
    const newIds = PROOF_CARD_REPLAY_SCENARIOS.map((s, i) =>
      demoIssuingAuthorizationId(INSTRUMENT, i, s.networkId),
    );
    expect(new Set(newIds).size).toBe(newIds.length);
  });

  it("the scenario list that caused it still reuses one merchant for two amounts, so the fix stays necessary", () => {
    // Pinned rather than assumed: if /proof's scenarios ever stopped sharing
    // a networkId, the index-exclusion story would read as unmotivated to the
    // next reader. The reuse is deliberate (the same merchant, once within
    // the cap and once over it), so it should outlive this fix.
    const networkIds = PROOF_CARD_REPLAY_SCENARIOS.map((s) => s.networkId);
    expect(new Set(networkIds).size).toBeLessThan(networkIds.length);
    expect(networkIds.filter((n) => n === "goodbeans_card_9001")).toHaveLength(2);
  });
});
