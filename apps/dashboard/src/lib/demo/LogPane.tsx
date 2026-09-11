/**
 * D-42: the right pane's log renderer. Pure and dependency-free (no data
 * fetching, no timers) so it can be rendered directly in a test the same
 * way `actor-fields.test.tsx` already does for a different pure component --
 * `entries` is data the caller already fetched or is incrementally
 * revealing; this file only ever formats what it's given.
 */

import type { LogEntry } from "./log";

const KIND_LABEL: Record<LogEntry["kind"], string> = {
  http: "HTTP",
  chain: "CHAIN",
  info: "INFO",
  success: "OK",
  warn: "WARN",
  error: "ERR",
};

export function LogPane({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="demo-log" role="log" aria-label="Raw log">
      {entries.map((entry, i) => (
        <div className={`demo-log-line demo-log-line--${entry.kind}`} key={i}>
          <span className="demo-log-kind">{KIND_LABEL[entry.kind]}</span>
          <span className="demo-log-label">{entry.label}</span>
          {entry.detail ? <pre className="demo-log-detail">{entry.detail}</pre> : null}
          {entry.link ? (
            <a className="demo-log-link" href={entry.link.href} target="_blank" rel="noreferrer">
              {entry.link.text} ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
