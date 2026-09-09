/**
 * D-35: proves the dashboard actually shows who acted, for both actor
 * kinds. `ActorFields` is a pure, dependency-free component (no data
 * fetching, no Next.js/SDK calls) precisely so this can render it directly
 * with `renderToStaticMarkup` -- no mocking of `next/headers`,
 * `next/navigation`, or the SDK client required, and no new test
 * dependency (jsdom, React Testing Library) needed either.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActorFields } from "./actor-fields";

describe("ActorFields (D-35: who acted)", () => {
  it("renders the existing Agent display, unchanged, for an agent actor", () => {
    const html = renderToStaticMarkup(
      <dl>
        <ActorFields
          receipt={{ actor_kind: "agent", agent_id: "agt_test_1234", instrument_id: null }}
          instrument={null}
        />
      </dl>,
    );

    expect(html).toContain("Agent");
    expect(html).toContain("agt_test_1234");
    expect(html).toContain("agent"); // the actor_kind badge
    expect(html).not.toContain("Rail");
    expect(html).not.toContain("Card");
    expect(html).not.toContain("Instrument<");
  });

  it("renders the instrument's rail and a masked external_ref for an instrument actor, never the full card id", () => {
    const html = renderToStaticMarkup(
      <dl>
        <ActorFields
          receipt={{ actor_kind: "instrument", agent_id: null, instrument_id: "inst_abcdef123456" }}
          instrument={{
            instrument_id: "inst_abcdef123456",
            organization_id: "org_1",
            mandate_id: "mdt_1",
            rail: "stripe_issuing",
            external_ref: "ic_1AbCdEfGhIjKlMnO9999",
            status: "ACTIVE",
            created_at: "2026-01-01T00:00:00.000Z",
          }}
        />
      </dl>,
    );

    expect(html).toContain("instrument"); // the actor_kind badge
    expect(html).toContain("Rail");
    expect(html).toContain("stripe_issuing");
    expect(html).toContain("Card");
    expect(html).toContain("9999"); // last 4 of the external_ref
    // THE ATTACK: the raw external_ref must never appear in the rendered
    // markup -- this is the whole point of "last 4 only, never the full
    // card id".
    expect(html).not.toContain("ic_1AbCdEfGhIjKlMnO9999");
    expect(html).not.toContain("AbCdEfGhIjKlMnO");
    expect(html).not.toContain("Agent<");
  });

  it("shows the instrument reference but omits rail/card fields when the instrument lookup came back null (e.g. 404)", () => {
    const html = renderToStaticMarkup(
      <dl>
        <ActorFields
          receipt={{ actor_kind: "instrument", agent_id: null, instrument_id: "inst_xyz123456789" }}
          instrument={null}
        />
      </dl>,
    );

    expect(html).toContain("instrument");
    expect(html).toContain("Instrument");
    expect(html).not.toContain("Rail");
    expect(html).not.toContain("Card");
  });
});
