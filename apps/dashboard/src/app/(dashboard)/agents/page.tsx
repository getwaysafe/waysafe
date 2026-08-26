import { requireSessionClient } from "../../../lib/bles";
import { Badge, formatDate, truncateId } from "../../../lib/format";

export default async function AgentsPage() {
  const bles = await requireSessionClient();
  const [agents, keys] = await Promise.all([bles.listAgents(), bles.listKeys()]);

  return (
    <>
      <h1>Agents &amp; Keys</h1>
      <p className="subtitle">Read-only. Mint or revoke keys with the SDK or the API directly.</p>

      <h2>Agents</h2>
      {agents.length === 0 ? (
        <p className="empty">No agents yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Name</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.agent_id}>
                <td className="mono">{truncateId(agent.agent_id)}</td>
                <td>{agent.name}</td>
                <td>
                  <Badge value={agent.status} />
                </td>
                <td>{formatDate(agent.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Keys</h2>
      {keys.length === 0 ? (
        <p className="empty">No keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Prefix</th>
              <th>Agent</th>
              <th>Last used</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.key_id}>
                <td className="mono">{truncateId(key.key_id)}</td>
                <td>{key.name}</td>
                <td className="mono">{key.prefix}…</td>
                <td className="mono">{key.agent_id ? truncateId(key.agent_id) : "org credential"}</td>
                <td>{key.last_used_at ? formatDate(key.last_used_at) : "never"}</td>
                <td>{key.revoked_at ? <Badge value="revoked" /> : <Badge value="active" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
