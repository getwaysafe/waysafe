/**
 * One transaction, shared across repositories -- D-76.
 *
 * `PrismaAuthorizationRepository` and `PrismaEvidenceRepository` each used to
 * keep their own `AsyncLocalStorage`, so a transaction opened by one was
 * invisible to the other. That is why D-62 had to move the evidence write
 * *outside* the mandate lock: calling `evidence.withOrganizationLock` from
 * inside `authorization.withMandateLock` opened a second, independent
 * `$transaction` on the same pool, which starved the connection and blew the
 * 20s timeout (`P2028`, confirmed live).
 *
 * Moving the write outside the lock fixed the timeout and left a different
 * problem: the decision and its evidence event were two transactions, so a
 * failure between them could commit a decision and a ledger hold with no
 * evidence event at all. D-76 makes them atomic, which requires the two
 * repositories to be able to see one another's transaction. Hence one store,
 * here, rather than one per repository.
 *
 * Lock ordering is fixed and must stay that way: the mandate row first, then
 * the organization row. Both locks are only ever acquired in that order --
 * `withMandateLock` opens the transaction, and `withOrganizationLock` adds
 * the organization's row lock to it. Nothing acquires the organization lock
 * and then the mandate lock, so there is no cycle to deadlock on.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";

/**
 * The transaction currently open for this async context, if any.
 *
 * A repository method reads this to decide between "join the caller's
 * transaction" and "open my own". Never exported as a setter: only the two
 * `with*Lock` methods put a value in it, via `run`.
 */
export const activeTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();
