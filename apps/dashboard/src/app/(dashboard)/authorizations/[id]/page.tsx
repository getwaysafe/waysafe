import { notFound } from "next/navigation";
import { formatMoney } from "@agentpay/core";
import { NotFoundError } from "@agentpay/sdk";
import { requireSessionClient } from "../../../../lib/agentpay";
import { Badge, formatDate } from "../../../../lib/format";

export default async function AuthorizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentpay = await requireSessionClient();

  const [receipt, reasonCodes] = await Promise.all([
    agentpay.verify(id).catch((error) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    }),
    agentpay.listReasonCodes(),
  ]);
  if (!receipt) notFound();

  const descriptionFor = (code: string) => reasonCodes.find((r) => r.code === code)?.description;

  return (
    <>
      <h1 className="mono">{receipt.authorization_id}</h1>
      <p className="subtitle">
        <Badge value={receipt.decision} /> &nbsp; <Badge value={receipt.status} />
      </p>

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
          return (
            <li key={i}>
              <span className="mono">{reason.code}</span>
              <br />
              <span style={{ color: "var(--muted)" }}>{reason.message}</span>
              {description && description !== reason.message && (
                <>
                  <br />
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{description}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
