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
