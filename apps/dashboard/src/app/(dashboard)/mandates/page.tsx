import Link from "next/link";
import { requireSessionClient } from "../../../lib/bles";
import { Badge, formatDate, truncateId } from "../../../lib/format";

export default async function MandatesPage() {
  const bles = await requireSessionClient();
  const mandates = await bles.listMandates({ limit: 100 });

  return (
    <>
      <h1>Mandates</h1>
      <p className="subtitle">Every mandate and its current version, most recent first.</p>

      {mandates.length === 0 ? (
        <p className="empty">No mandates yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Mandate</th>
              <th>Principal</th>
              <th>Status</th>
              <th>Summary</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {mandates.map((mandate) => (
              <tr key={mandate.mandate_id}>
                <td>
                  <Link href={`/mandates/${mandate.mandate_id}`} className="mono">
                    {truncateId(mandate.mandate_id)}
                  </Link>
                </td>
                <td className="mono">{truncateId(mandate.principal_id)}</td>
                <td>
                  <Badge value={mandate.status} />
                </td>
                <td>{mandate.summary}</td>
                <td>{formatDate(mandate.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
