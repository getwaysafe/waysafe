import { requireSessionClient } from "../../../lib/bles";
import { formatDate, truncateId } from "../../../lib/format";

export default async function EvidencePage() {
  const bles = await requireSessionClient();
  const [events, chain] = await Promise.all([bles.listEvidence(), bles.verifyEvidenceChain()]);

  return (
    <>
      <h1>Evidence chain</h1>
      <p className="subtitle">
        Append-only, hash-chained event log. Tamper-evident, not tamper-proof -- see the docs before calling this
        "verifiable."
      </p>

      {chain.ok ? (
        <div className="banner ok">Chain verifies: every event's hash matches, in sequence, with no gaps.</div>
      ) : (
        <div className="banner broken">
          Chain verification failed at sequence {chain.brokenAtSequence} ({chain.reason}).
        </div>
      )}

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
