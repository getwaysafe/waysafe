import { requireSessionClient } from "../../../lib/bles";
import { formatDate, truncateId } from "../../../lib/format";

export default async function EvidencePage() {
  const bles = await requireSessionClient();
  const [events, chain, publicKey] = await Promise.all([
    bles.listEvidence(),
    bles.verifyEvidenceChain(),
    bles.getEvidencePublicKey(),
  ]);

  return (
    <>
      <h1>Evidence chain</h1>
      <p className="subtitle">
        Append-only, hash-chained, and signed (Ed25519) -- verifiable by a third party who checks the signature
        below, not just by us recomputing our own database.
      </p>

      {chain.ok && chain.signed ? (
        <div className="banner ok">
          Chain verifies and every signature checks out: independently verifiable, not just internally consistent.
        </div>
      ) : chain.ok ? (
        <div className="banner ok">Chain is internally consistent, but signatures were not checked.</div>
      ) : (
        <div className="banner broken">
          Chain verification failed at sequence {chain.brokenAtSequence} ({chain.reason}).
        </div>
      )}

      <div className="card">
        <dl className="field-grid">
          <dt>Signing algorithm</dt>
          <dd>{publicKey.algorithm}</dd>
          <dt>Public key</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>
            {publicKey.public_key}
          </dd>
        </dl>
        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          Also served, with no credential required, at <code>GET /v1/evidence/public-key</code> -- pin it yourself
          and verify a receipt without trusting this dashboard's judgment.
        </p>
      </div>

      {events.length === 0 ? (
        <p className="empty">No evidence recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Seq</th>
              <th>Type</th>
              <th>Subject</th>
              <th>Hash</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.sequence}</td>
                <td className="mono">{event.type}</td>
                <td className="mono">
                  {event.subject_type}:{truncateId(event.subject_id, 14)}
                </td>
                <td className="mono">{truncateId(event.hash, 14)}</td>
                <td>{formatDate(event.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
