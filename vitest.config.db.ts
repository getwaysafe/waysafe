import { defineConfig } from "vitest/config";
import { POSTGRES_GATED_FILES } from "./vitest.config.js";

try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // no .env -- these suites self-skip, same as in the main config.
}

/**
 * The Postgres-gated pass -- D-77.
 *
 * `fileParallelism: false` is the whole point: these seven files share one
 * database, and running them concurrently against a cloud instance made
 * `budget.adversarial.test.ts` fail 3 of 9 full-suite runs. Serial is slower
 * and reliable, which is the right trade for a file that proves a ledger
 * invariant.
 */
export default defineConfig({
  test: {
    include: POSTGRES_GATED_FILES,
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
