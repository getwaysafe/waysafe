/**
 * Shared gate for tests that need a real database.
 *
 * Two failure modes to avoid, for any suite that proves a Postgres-level
 * property (a row lock, a unique constraint) the in-memory fakes can't:
 *
 *  - Failing outright when no DATABASE_URL is configured, which would make
 *    `npm test` red for anyone without a local/dev database -- these tests
 *    should skip themselves instead.
 *  - Skipping *silently* when a database was supposed to be there and isn't
 *    -- a broken DATABASE_URL in CI or staging would make the single test
 *    suite guarding a money-losing race vanish, while everything else
 *    stays green. `AGENTPAY_REQUIRE_DB=1` turns that into a hard failure.
 *
 * Used identically by `authorization/prisma-repository.test.ts` and
 * `evidence/prisma-repository.test.ts`; kept in one place so the two don't
 * quietly drift apart on a security-relevant test mechanism.
 */

import { describe, it } from "vitest";

export async function probeDatabase(prisma: {
  $queryRaw: (strings: TemplateStringsArray) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Call at module scope, before the `describe.skipIf(!reachable)` block for
 * the same suite. If `AGENTPAY_REQUIRE_DB=1` and the database isn't
 * reachable, registers a single failing test explaining why, instead of
 * letting the whole suite disappear via `skipIf`. No-ops otherwise (database
 * reachable, or the flag isn't set -- in which case the normal `skipIf`
 * handles it).
 */
export function requireDbOrExplainSkip(suiteName: string, reachable: boolean): void {
  if (reachable) return;
  if (process.env.AGENTPAY_REQUIRE_DB !== "1") return;

  describe(suiteName, () => {
    it("requires a reachable database because AGENTPAY_REQUIRE_DB=1", () => {
      throw new Error(
        `AGENTPAY_REQUIRE_DB=1 but DATABASE_URL is unset or unreachable -- ` +
          `refusing to silently skip "${suiteName}". Fix the connection, or ` +
          `unset AGENTPAY_REQUIRE_DB to allow skipping.`,
      );
    });
  });
}
