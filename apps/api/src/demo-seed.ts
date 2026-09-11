#!/usr/bin/env -S npx tsx
/**
 * D-42: one-time setup for the /demo page. Run once, against real Postgres:
 *
 *   npm run demo:seed -w @waysafe/api
 *
 * There is no public route to create an Organization -- every other route
 * in server.ts assumes one already exists and is reached through a Bearer
 * credential (Phase 4's auth rule), the same reason `examples/demo.ts`
 * seeds one directly through Prisma for its own throwaway per-run org.
 * This script does the same thing but idempotently, against one fixed,
 * stable org id (`org_demo`), because the /demo page is meant to be
 * re-run many times while recording -- unlike examples/demo.ts, it should
 * not mint a fresh org (and a fresh org credential the dashboard would
 * have to be re-configured with) on every run.
 *
 * Writes the minted credential directly into apps/dashboard/.env.local
 * (`WAYSAFE_DEMO_ORG_API_KEY`) rather than printing it -- the same
 * secret-hygiene fix D-41 made to `deploy-x402-safe.ts` after this exact
 * mistake got made once already: a raw credential printed to stdout is
 * safe in a human's own terminal, but not when that terminal's output is
 * itself being read into a chat transcript (an agent running this on the
 * operator's behalf, for instance). Only the key's non-secret prefix is
 * logged, for confirmation. Safe to re-run: an existing `org_demo` is left
 * alone; re-running mints one additional credential and overwrites the
 * `.env.local` line with the newest one (org credentials, like agent keys,
 * are cheap and revocable).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaAgentKeyRepository } from "./agent-keys/prisma-repository.js";

const DEMO_ORG_ID = "org_demo";
const DEMO_ORG_NAME = "Waysafe Demo Org";

const DASHBOARD_ENV_PATH = fileURLToPath(
  new URL("../../dashboard/.env.local", import.meta.url),
);

function setEnvVar(path: string, key: string, value: string): void {
  const contents = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
  writeFileSync(path, next.replace(/^\n/, ""));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set -- the demo page needs persistent state across runs (see D-42).");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    await prisma.organization.upsert({
      where: { id: DEMO_ORG_ID },
      update: {},
      create: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME },
    });

    const agentKeys = new PrismaAgentKeyRepository(prisma);
    const created = await agentKeys.createKey(
      { organizationId: DEMO_ORG_ID, name: "demo page org credential" },
      new Date(),
    );

    setEnvVar(DASHBOARD_ENV_PATH, "WAYSAFE_DEMO_ORG_API_KEY", created.fullKey);

    console.log(`Organization ready: ${DEMO_ORG_ID}`);
    console.log(`Wrote WAYSAFE_DEMO_ORG_API_KEY (prefix ${created.prefix}) to ${DASHBOARD_ENV_PATH}`);
    console.log("The raw credential is never printed -- only its non-secret prefix, for confirmation.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
