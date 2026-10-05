/**
 * A skipped suite has to say so in the final summary -- D-77.
 *
 * Six suites in this repository are gated on an external resource and
 * `describe.skipIf` themselves away when it is absent. That is the right
 * behaviour: `npm test` must stay green on a laptop with no database. The
 * problem is that it is *silent*. Six suites vanishing without a word
 * includes the two that carry the D-4 row-lock proof and the D-72 ledger
 * window-key proof, so a green run can mean "the money-path proofs passed"
 * or "the money-path proofs did not run", and nothing on screen distinguishes
 * them.
 *
 * That is D-64's lesson in a different costume: a suite that passes while
 * proving nothing. `WAYSAFE_REQUIRE_DB=1` and its siblings already turn a
 * skip into a failure for anyone who knows to set them, which is exactly the
 * wrong default for a fact a reader needs to notice without being told to
 * look.
 *
 * So each gate records itself here, and a global teardown prints one line per
 * skipped suite naming the variable that would enable it. The channel is a
 * temp file because vitest runs test files in worker processes: a module-level
 * array would be invisible to the reporter in the main process.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const PATH_ENV = "WAYSAFE_SKIP_REPORT_PATH";

export interface GatedSuite {
  /** The suite's own describe() name. */
  suite: string;
  /** The environment variable(s) that would make it run. */
  needs: string;
  /** The variable that turns a skip into a hard failure, if there is one. */
  requireFlag?: string;
}

/**
 * Called by every gate, whether or not the resource was reachable.
 *
 * Recording the reachable case too is deliberate: it lets the summary say
 * "6 gated suites, 4 ran, 2 skipped" rather than only listing absences,
 * which is the difference between a reader knowing the gates exist and a
 * reader having to already know.
 */
export function recordGatedSuite(suite: GatedSuite, ran: boolean): void {
  const path = process.env[PATH_ENV];
  if (!path) return; // not running under the global setup; nothing to do
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...suite, ran })}\n`, "utf8");
  } catch {
    // A failure to record must never fail a test run.
  }
}

/** Reads what the workers recorded. Main process only. */
export function readGatedSuites(path: string): Array<GatedSuite & { ran: boolean }> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as GatedSuite & { ran: boolean });
  } catch {
    return [];
  }
}

export function clearGatedSuites(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}

export const SKIP_REPORT_PATH_ENV = PATH_ENV;
