import { notFound } from "next/navigation";
import { NotFoundError } from "@agentpay/sdk";
import { requireSessionClient } from "../../../../lib/agentpay";
import { Badge, formatDate } from "../../../../lib/format";

export default async function MandateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentpay = await requireSessionClient();

  const mandate = await agentpay.getMandate(id).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!mandate) notFound();

  return (
    <>
      <h1 className="mono">{mandate.mandate_id}</h1>
      <p className="subtitle">
        <Badge value={mandate.status} /> &nbsp; version {mandate.mandate_version_id}
      </p>

      <div className="card">
        <dl className="field-grid">
          <dt>Principal</dt>
          <dd className="mono">{mandate.principal_id}</dd>
          <dt>Summary</dt>
          <dd>{mandate.summary}</dd>
          <dt>Policy hash</dt>
          <dd className="mono">{mandate.policy_hash}</dd>
          <dt>Agents</dt>
          <dd className="mono">{mandate.agent_ids.join(", ") || "—"}</dd>
          <dt>Authenticated</dt>
          <dd>{mandate.authenticated_at ? formatDate(mandate.authenticated_at) : "not yet authenticated"}</dd>
          <dt>Created</dt>
          <dd>{formatDate(mandate.created_at)}</dd>
        </dl>
      </div>

      <h2>Original instruction</h2>
      <p>{mandate.intent_text}</p>

      {mandate.assumptions.length > 0 && (
        <>
          <h2>Compiler assumptions</h2>
          <ul>
            {mandate.assumptions.map((assumption, i) => (
              <li key={i}>{assumption}</li>
            ))}
          </ul>
        </>
      )}

      <h2>Compiled policy</h2>
      <pre>{JSON.stringify(mandate.policy, null, 2)}</pre>
    </>
  );
}
