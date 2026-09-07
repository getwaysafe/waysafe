/**
 * The step-up TTL expiry worker's process entrypoint (D-31/OQ-6).
 *
 * A pending step-up is expired lazily today, the moment something happens
 * to look at it -- `server.ts`'s `expireIfNeeded`, called from GET, execute,
 * and approve/decline. That's sufficient to guarantee an expired step-up can
 * never be executed. It is not sufficient to guarantee its RESERVATION ever
 * gets released: if nobody ever asks about that specific authorization
 * again, the reservation sits on the ledger forever, and `getSpendSnapshot`'s
 * mandate-lifetime window (D-4) sums every RESERVATION unconditionally --
 * an abandoned step-up permanently eats into that mandate's budget. This
 * process is the fix: it polls `sweepExpiredStepUps` (authorization/
 * service.ts) on a timer instead of waiting for a request to trigger it.
 *
 * A separate long-lived process from the API, not an in-process
 * `setInterval` bolted onto `index.ts`: a sweep holds a mandate row lock
 * (D-4) for its duration, and that must never share an event loop with
 * request handling. The two processes deploy, restart, and scale
 * independently -- see DECISIONS.md D-31 for the full reasoning and the
 * production deployment shape (a second Render service next to the API,
 * both reading the same DATABASE_URL).
 *
 * No in-memory mode: unlike `index.ts`, which falls back to the in-memory
 * repositories so `npm run dev` works with no database, this process only
 * makes sense against real, shared persistence -- there is nothing for a
 * clock-driven sweep to do against a store no request handler can also see.
 */

import { PrismaClient } from "@prisma/client";
import { EMPTY_DIRECTORY } from "@waysafe/core";
import { PrismaAuthorizationRepository } from "./authorization/prisma-repository.js";
import { sweepExpiredStepUps } from "./authorization/service.js";

const POLL_INTERVAL_MS = Number(process.env.WAYSAFE_WORKER_POLL_MS ?? 60_000);

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "the step-up expiry worker requires DATABASE_URL -- there is no in-memory mode for a " +
        "process meant to run independently of, and share persistence with, the API.",
    );
  }

  const prisma = new PrismaClient();
  const repo = new PrismaAuthorizationRepository(prisma, EMPTY_DIRECTORY);

  console.log(`waysafe step-up expiry worker started, polling every ${POLL_INTERVAL_MS}ms`);

  for (;;) {
    try {
      const count = await sweepExpiredStepUps(repo, new Date());
      if (count > 0) console.log(`expired ${count} pending step-up(s)`);
    } catch (err) {
      console.error("sweep failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
