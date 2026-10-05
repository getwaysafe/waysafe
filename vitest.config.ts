import { defineConfig } from "vitest/config";

// Optional: lets DATABASE_URL-gated tests (prisma-repository.test.ts) find a
// real database when one is configured. Absent .env, those tests self-skip.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // no .env file -- fine, DATABASE_URL-gated tests just skip themselves.
}

/**
 * Files that need a real Postgres. They run in their own serial pass
 * (`npm run test:db`, `vitest.config.db.ts`) rather than here -- D-77.
 *
 * Six of them share one database. Run in parallel against a cloud instance
 * that cold-starts, they intermittently failed: `budget.adversarial.test.ts`
 * failed 3 of 9 full-suite runs, always passing on retry. A flaky proof of a
 * money-path invariant is worth less than a slow one.
 */
export const POSTGRES_GATED_FILES = [
  "apps/api/src/authorization/prisma-repository.test.ts",
  "apps/api/src/authorization/budget.adversarial.test.ts",
  "apps/api/src/enforcement/decision-atomicity.test.ts",
  "apps/api/src/evidence/prisma-repository.test.ts",
  "apps/api/src/principals/prisma-repository.test.ts",
  "apps/api/src/agent-keys/prisma-repository.test.ts",
  "apps/api/src/webauthn/prisma-repository.test.ts",
];

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", ...POSTGRES_GATED_FILES],
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
