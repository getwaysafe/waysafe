/**
 * D-42: the raw log's data model and pure formatting helpers. The right
 * pane renders these entries verbatim -- real HTTP calls, real evaluate()
 * reasons, real tx hashes -- so this file only formats, it never decides
 * what happened.
 */

export type LogKind = "http" | "chain" | "info" | "success" | "warn" | "error";

export interface LogEntry {
  kind: LogKind;
  /** A short label, e.g. "POST /v1/enforcement/x402" or "eth_call". */
  label: string;
  /** The unedited detail -- a JSON body, a reason code list, a revert
   * reason, a tx hash. Rendered as-is, monospace. */
  detail?: string;
  /** Present when this line is about something checkable on-chain -- the
   * caller supplies the full PolygonScan URL (see `polygonScanTxUrl`/
   * `polygonScanAddressUrl`) so this module never has to know the
   * network's base URL itself. */
  link?: { href: string; text: string };
}

const POLYGONSCAN_BASE = "https://amoy.polygonscan.com";

export function polygonScanTxUrl(txHash: string): string {
  return `${POLYGONSCAN_BASE}/tx/${txHash}`;
}

export function polygonScanAddressUrl(address: string): string {
  return `${POLYGONSCAN_BASE}/address/${address}`;
}

/** last4-style mask for anything that reads like a card number or a raw
 * secret -- not used for Safe addresses (those are meant to be public and
 * checkable on PolygonScan), only kept here so callers building a log line
 * from a receipt don't have to reinvent it per D-35's own convention. */
export function maskExternalRef(value: string): string {
  if (value.length <= 4) return value;
  return `••••${value.slice(-4)}`;
}

/** One flat, monospace-friendly line -- used by the plain-text fallback and
 * by tests that want to assert on content without rendering React. */
export function formatLogLine(entry: LogEntry): string {
  const parts = [`[${entry.kind.toUpperCase()}]`, entry.label];
  if (entry.detail) parts.push(`-- ${entry.detail}`);
  if (entry.link) parts.push(`(${entry.link.text}: ${entry.link.href})`);
  return parts.join(" ");
}
