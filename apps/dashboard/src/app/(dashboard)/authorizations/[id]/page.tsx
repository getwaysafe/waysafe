import { notFound } from "next/navigation";
import { formatMoney } from "@waysafe/core";
import { NotFoundError } from "@waysafe/sdk";
import { requireSessionClient } from "../../../../lib/waysafe";
import { Badge, formatDate } from "../../../../lib/format";
import { formatDetail } from "../../../../lib/reasons";
import { approveStepUp, declineStepUp } from "./actions";

export default async function AuthorizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const waysafe = await requireSessionClient();

  const [receipt, reasonCodes] = await Promise.all([
    waysafe.verify(id).catch((error) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    }),
    waysafe.listReasonCodes(),
  ]);
  if (!receipt) notFound();

  const descriptionFor = (code: string) => reasonCodes.find((r) => r.code === code)?.description;

  return (
    <>
      <h1 className="mono">{receipt.authorization_id}</h1>
      <p className="subtitle">
        <Badge value={receipt.decision} /> &nbsp; <Badge value={receipt.status} />
      </p>

      {receipt.status === "PENDING_STEP_UP" && (
        <div className="card approval">
          <h2 style={{ marginTop: 0 }}>Approval needed</h2>
          <p>
            The agent asked to spend{" "}
            <strong>{formatMoney({ amount: receipt.action.amount, currency: receipt.action.currency })}</strong>
            {receipt.action.description ? ` on "${receipt.action.description}"` : ""} at{" "}
            <strong>
              {receipt.merchant.refs.map((ref) => ref.value).join(", ") || "an unverified merchant"}
            </strong>
            {receipt.action.category ? ` (category: ${receipt.action.category})` : ""}.
          </p>

          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Merchant trust: {receipt.merchant.trust.toLowerCase()} · via {receipt.merchant.resolution_source}
          </p>

          {receipt.step_up && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>Expires {formatDate(receipt.step_up.expires_at)}</p>
          )}

          <form style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              formAction={approveStepUp.bind(null, receipt.authorization_id)}
              className="approve"
              type="submit"
            >
              Approve
            </button>
            <button
              formAction={declineStepUp.bind(null, receipt.authorization_id)}
              className="decline"
              type="submit"
            >
              Decline
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <dl className="field-grid">
          <dt>Agent</dt>
          <dd className="mono">{receipt.agent_id}</dd>
          <dt>Principal</dt>
          <dd className="mono">{receipt.principal_id}</dd>
          <dt>Mandate</dt>
          <dd className="mono">{receipt.mandate_id}</dd>
          <dt>Policy hash</dt>
          <dd className="mono">{receipt.policy_hash}</dd>
          <dt>Amount</dt>
          <dd>{formatMoney({ amount: receipt.action.amount, currency: receipt.action.currency })}</dd>
          <dt>Merchant</dt>
          <dd>
            {receipt.merchant.refs.map((ref) => `${ref.scheme}:${ref.value}`).join(", ") || "—"} (
            {receipt.merchant.trust})
          </dd>
          <dt>Idempotency key</dt>
          <dd className="mono">{receipt.idempotency_key ?? "—"}</dd>
          {receipt.step_up && (
            <>
              <dt>Step-up expires</dt>
              <dd>{formatDate(receipt.step_up.expires_at)}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{formatDate(receipt.created_at)}</dd>
          <dt>Decided</dt>
          <dd>{formatDate(receipt.decided_at)}</dd>
        </dl>
      </div>

      <h2>Reasons</h2>
      <ul className="reasons">
        {receipt.reasons.map((reason, i) => {
          const description = descriptionFor(reason.code);
          const detail = formatDetail(reason.detail);
          return (
            <li key={i}>
              <span className="mono">{reason.code}</span>
              {reason.policy_path && (
                <span className="mono" style={{ color: "var(--muted)" }}>
                  {" "}
                  · {reason.policy_path}
                </span>
              )}
              <br />
              <span style={{ color: "var(--muted)" }}>{reason.message}</span>
              {description && description !== reason.message && (
                <>
                  <br />
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{description}</span>
                </>
              )}
              {detail && (
                <>
                  <br />
                  <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
                    {detail}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
