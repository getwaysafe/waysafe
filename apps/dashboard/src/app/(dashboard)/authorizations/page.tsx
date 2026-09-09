import Link from "next/link";
import { formatMoney } from "@waysafe/core";
import { requireSessionClient } from "../../../lib/waysafe";
import { Badge, formatDate, truncateId } from "../../../lib/format";

export default async function AuthorizationsPage() {
  const waysafe = await requireSessionClient();
  const authorizations = await waysafe.listAuthorizations({ limit: 200 });

  return (
    <>
      <h1>Authorizations</h1>
      <p className="subtitle">The decision log -- every authorize() call, most recent first.</p>

      {authorizations.length === 0 ? (
        <p className="empty">No authorizations yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Authorization</th>
              <th>Decision</th>
              <th>Status</th>
              <th>Actor</th>
              <th>Amount</th>
              <th>Merchant</th>
              <th>Reason codes</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {authorizations.map((auth) => (
              <tr key={auth.authorization_id}>
                <td>
                  <Link href={`/authorizations/${auth.authorization_id}`} className="mono">
                    {truncateId(auth.authorization_id)}
                  </Link>
                </td>
                <td>
                  <Badge value={auth.decision} />
                </td>
                <td>
                  <Badge value={auth.status} />
                </td>
                <td>
                  {/* D-35: who acted. The rail and masked card ref are only
                      shown on the detail page (one extra lookup there is
                      cheap; doing it per row here would be N+1). */}
                  <Badge value={auth.actor_kind} />{" "}
                  <span className="mono" style={{ color: "var(--muted)" }}>
                    {truncateId(
                      (auth.actor_kind === "instrument" ? auth.instrument_id : auth.agent_id) ?? "",
                      12,
                    )}
                  </span>
                </td>
                <td>{formatMoney({ amount: auth.action.amount, currency: auth.action.currency })}</td>
                <td>{auth.merchant.refs[0]?.value ?? "—"}</td>
                <td className="mono">{auth.reason_codes.join(", ")}</td>
                <td>{formatDate(auth.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
