/**
 * Prints the gated-suite summary after every run -- D-77.
 *
 * Six suites skip themselves when an external resource is absent. Without
 * this, they vanish with no output at all, including the two that carry the
 * D-4 row-lock and D-72 window-key proofs. See
 * `apps/api/src/test-support/skip-report.ts` for why that is a correctness
 * problem and not a cosmetic one.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKIP_REPORT_PATH_ENV,
  clearGatedSuites,
  readGatedSuites,
} from "./apps/api/src/test-support/skip-report.js";

const reportPath = join(tmpdir(), `waysafe-gated-suites-${process.pid}.jsonl`);

export async function setup(): Promise<void> {
  process.env[SKIP_REPORT_PATH_ENV] = reportPath;
  clearGatedSuites(reportPath);
}

export async function teardown(): Promise<void> {
  const recorded = readGatedSuites(reportPath);
  clearGatedSuites(reportPath);
  if (recorded.length === 0) return;

  // Deduplicate: a suite can record once per worker.
  const bySuite = new Map<string, (typeof recorded)[number]>();
  for (const entry of recorded) bySuite.set(entry.suite, entry);
  const all = [...bySuite.values()].sort((a, b) => a.suite.localeCompare(b.suite));
  const skipped = all.filter((s) => !s.ran);

  const lines: string[] = [
    "",
    `Gated suites: ${all.length} total, ${all.length - skipped.length} ran, ${skipped.length} skipped.`,
  ];
  if (skipped.length === 0) {
    lines.push("  All externally-gated suites ran.");
  } else {
    for (const s of skipped) {
      lines.push(
        `  SKIPPED  ${s.suite}` +
          `\n           needs ${s.needs}` +
          (s.requireFlag ? `; set ${s.requireFlag} to make this a failure instead` : ""),
      );
    }
    lines.push(
      "  A skipped suite proves nothing. If any of these guard a claim you rely on,",
      "  configure the resource and re-run, or set the require flag in CI.",
    );
  }
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}
