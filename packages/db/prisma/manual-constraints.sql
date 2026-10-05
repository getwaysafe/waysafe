-- Manually-applied constraints the schema DSL can't express (D-35).
--
-- This project pushes schema.prisma with `prisma db push`, not
-- `prisma migrate` -- there is no migration history to fold a CHECK
-- constraint into automatically. `db push` only ever applies what
-- schema.prisma can declare (tables, columns, enums, unique/index), and
-- Prisma has no schema-level way to express a multi-column CHECK constraint.
-- Run this file by hand after `db push`, whenever `authorizations`' actor
-- columns change:
--
--   npm run db:push
--   npm run db:constraints
--
-- Idempotent (safe to re-run): each block only adds its constraint if it
-- doesn't already exist.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_actor_kind_check'
  ) THEN
    ALTER TABLE "authorizations"
      ADD CONSTRAINT authorizations_actor_kind_check
      CHECK (
        ("actorKind" = 'agent' AND "agentId" IS NOT NULL AND "instrumentId" IS NULL)
        OR
        ("actorKind" = 'instrument' AND "instrumentId" IS NOT NULL AND "agentId" IS NULL)
      );
  END IF;
END $$;

-- D-71: an authorization is captured once, against the mandate that issued
-- it. Partial unique indexes, which `db push` cannot express either (Prisma
-- has no `WHERE` clause on @@unique), so they live here alongside the CHECK.
--
-- Why partial rather than a plain unique on (mandate_id, authorization_id):
-- one authorization legitimately produces several rows on one mandate -- a
-- RESERVATION, its RELEASE, a CAPTURE, later CREDITs. What must be unique is
-- *one of each kind that can double-charge*.
--
-- The CAPTURE index is the real control behind `recordExecution`'s
-- already-EXECUTED early return: the status check keeps the common path
-- quiet, and this stops two concurrent callers that both read AUTHORIZED.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_one_capture_per_authorization
  ON "ledger_entries" ("mandateId", "authorizationId")
  WHERE type = 'CAPTURE';

-- The RESERVATION index makes `recordStepUpApprovalHold` safe under a race
-- the same way: its "does a hold already exist?" read cannot be trusted on
-- its own. Scoped per mandate on purpose -- since D-62 the approver's
-- mandate and the spending mandate each hold one row under a single
-- authorization id, which is legitimate (D-71) and must stay possible.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_one_reservation_per_authorization
  ON "ledger_entries" ("mandateId", "authorizationId")
  WHERE type = 'RESERVATION';
