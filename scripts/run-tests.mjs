/**
 * Runs both test passes and combines their exit codes -- D-77.
 *
 * Two passes exist because the seven Postgres-gated files share one database
 * and were flaky when run concurrently with the rest (see
 * `vitest.config.db.ts`). They therefore run serially, in their own pass.
 *
 * `vitest run && npm run test:db` would have been smaller, but `&&` skips the
 * second pass whenever the first fails -- and this repository has a standing
 * expected failure (the Amoy gas gap, D-42), so the database proofs would
 * never run. Both passes always run; the exit code is non-zero if either
 * failed.
 */

import { spawnSync } from "node:child_process";

const passes = [
  { name: "unit + offline", args: ["run"] },
  { name: "postgres (serial)", args: ["run", "--config", "vitest.config.db.ts"] },
];

let failed = false;
for (const pass of passes) {
  console.log(`\n=== test pass: ${pass.name} ===`);
  const result = spawnSync("npx", ["vitest", ...pass.args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    failed = true;
    console.log(`=== test pass FAILED: ${pass.name} (exit ${result.status}) ===`);
  }
}

process.exit(failed ? 1 : 0);
