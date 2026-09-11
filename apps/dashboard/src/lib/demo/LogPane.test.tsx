/**
 * `LogPane` is a pure, dependency-free component (like `actor-fields.tsx`),
 * so this renders it directly with `renderToStaticMarkup` -- no jsdom, no
 * mocking of Next.js internals.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LogPane } from "./LogPane";
import { formatLogLine, maskExternalRef, polygonScanAddressUrl, polygonScanTxUrl, type LogEntry } from "./log";

describe("LogPane (D-42)", () => {
  it("renders label and detail for a plain info line", () => {
    const html = renderToStaticMarkup(
      <LogPane entries={[{ kind: "info", label: "compiling instruction", detail: "up to $20/day" }]} />,
    );
    expect(html).toContain("compiling instruction");
    expect(html).toContain("up to $20/day");
    expect(html).toContain("INFO");
  });

  it("renders an HTTP call line with its raw JSON detail unedited", () => {
    const entries: LogEntry[] = [
      { kind: "http", label: "POST /v1/enforcement/x402", detail: '{"decision":"ALLOW"}' },
    ];
    const html = renderToStaticMarkup(<LogPane entries={entries} />);
    expect(html).toContain("POST /v1/enforcement/x402");
    expect(html).toContain('{&quot;decision&quot;:&quot;ALLOW&quot;}');
  });

  it("renders a chain line with a clickable PolygonScan link", () => {
    const entries: LogEntry[] = [
      {
        kind: "chain",
        label: "execTransaction",
        detail: "0xabc123",
        link: { href: polygonScanTxUrl("0xabc123"), text: "view on PolygonScan" },
      },
    ];
    const html = renderToStaticMarkup(<LogPane entries={entries} />);
    expect(html).toContain('href="https://amoy.polygonscan.com/tx/0xabc123"');
    expect(html).toContain("view on PolygonScan");
    expect(html).toContain('target="_blank"');
  });

  it("renders nothing for entries with no detail and no link beyond the label", () => {
    const html = renderToStaticMarkup(<LogPane entries={[{ kind: "success", label: "mandate activated" }]} />);
    expect(html).toContain("mandate activated");
    expect(html).not.toContain("demo-log-detail");
    expect(html).not.toContain("demo-log-link");
  });

  it("renders every kind with a distinct badge", () => {
    const kinds: LogEntry["kind"][] = ["http", "chain", "info", "success", "warn", "error"];
    const html = renderToStaticMarkup(<LogPane entries={kinds.map((kind) => ({ kind, label: kind }))} />);
    for (const kind of kinds) {
      expect(html).toContain(`demo-log-line--${kind}`);
    }
  });
});

describe("log formatting helpers (D-42)", () => {
  it("formatLogLine joins kind, label, detail, and link into one line", () => {
    const line = formatLogLine({
      kind: "chain",
      label: "execTransaction",
      detail: "0xabc",
      link: { href: "https://amoy.polygonscan.com/tx/0xabc", text: "view" },
    });
    expect(line).toBe("[CHAIN] execTransaction -- 0xabc (view: https://amoy.polygonscan.com/tx/0xabc)");
  });

  it("formatLogLine omits missing detail/link cleanly", () => {
    expect(formatLogLine({ kind: "info", label: "hello" })).toBe("[INFO] hello");
  });

  it("polygonScanTxUrl and polygonScanAddressUrl point at Amoy's explorer", () => {
    expect(polygonScanTxUrl("0xdead")).toBe("https://amoy.polygonscan.com/tx/0xdead");
    expect(polygonScanAddressUrl("0xbeef")).toBe("https://amoy.polygonscan.com/address/0xbeef");
  });

  it("maskExternalRef keeps only the last 4 characters", () => {
    expect(maskExternalRef("0x1234567890abcdef")).toBe("••••cdef");
  });

  it("maskExternalRef leaves short values alone rather than over-masking", () => {
    expect(maskExternalRef("abcd")).toBe("abcd");
  });
});
