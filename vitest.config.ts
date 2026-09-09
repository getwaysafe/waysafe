import { defineConfig } from "vitest/config";

// Optional: lets DATABASE_URL-gated tests (prisma-repository.test.ts) find a
// real database when one is configured. Absent .env, those tests self-skip.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // no .env file -- fine, DATABASE_URL-gated tests just skip themselves.
}

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
  },
});
