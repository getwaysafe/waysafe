export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.toLowerCase()}`}>{value.replaceAll("_", " ")}</span>;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function truncateId(id: string, length = 18): string {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

/** For an instrument's `external_ref` (D-35) -- a rail's own reference for a
 * spend instrument, e.g. a Stripe Issuing card id. Treat it the way a UI
 * treats a card number: last 4 characters only, everything before that
 * masked. Never render the raw `external_ref` in a dashboard page. */
export function maskExternalRef(externalRef: string): string {
  return `•••• ${externalRef.slice(-4)}`;
}
