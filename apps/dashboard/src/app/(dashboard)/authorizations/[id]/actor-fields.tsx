import { type ActorKind } from "@waysafe/core";
import { type InstrumentDetail } from "@waysafe/sdk";
import { Badge, maskExternalRef, truncateId } from "../../../../lib/format";

/**
 * Who acted (D-35): an agent-actor decision keeps the pre-existing "Agent"
 * row exactly as it was; an instrument-actor one shows the instrument's rail
 * and a masked `external_ref` instead -- never the raw value (treat it like
 * a card number). Kept in its own file, importing nothing server-only, so
 * it's directly testable with `renderToStaticMarkup` -- no Next.js/SDK
 * mocking required. See actor-fields.test.tsx.
 */
export function ActorFields({
  receipt,
  instrument,
}: {
  receipt: { actor_kind: ActorKind; agent_id: string | null; instrument_id: string | null };
  instrument: InstrumentDetail | null;
}) {
  return (
    <>
      <dt>Actor</dt>
      <dd>
        <Badge value={receipt.actor_kind} />
      </dd>
      {receipt.actor_kind === "agent" && (
        <>
          <dt>Agent</dt>
          <dd className="mono">{receipt.agent_id}</dd>
        </>
      )}
      {receipt.actor_kind === "instrument" && (
        <>
          <dt>Instrument</dt>
          <dd className="mono">{receipt.instrument_id ? truncateId(receipt.instrument_id) : "—"}</dd>
          {instrument && (
            <>
              <dt>Rail</dt>
              <dd>{instrument.rail}</dd>
              <dt>Card</dt>
              <dd className="mono">{maskExternalRef(instrument.external_ref)}</dd>
            </>
          )}
        </>
      )}
    </>
  );
}
