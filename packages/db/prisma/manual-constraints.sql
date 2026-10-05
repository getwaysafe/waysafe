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

-- D-74: a rail's own authorization reference identifies one decision.
--
-- `handleIssuingAuthorizationRequest` consults `findByExternalRef` first and
-- replays the recorded decision, but that lookup is only the fast path -- two
-- concurrent deliveries of the same event both read "not seen" and both
-- insert. This index is the control.
--
-- Scoped to (mandateId, externalRef) rather than externalRef alone. A replay
-- always resolves through the same card to the same instrument to the same
-- mandate, so this catches every redelivery; and `externalRef` carries no
-- rail qualifier (the rail lives on Instrument), so a second rail writing a
-- colliding reference format would trip a global unique index for reasons
-- that have nothing to do with idempotency.
--
-- Guarded rather than unconditional: this project's own /film demo route used
-- a fixed `iauth_demo_<networkId>` per scenario until D-74, so a database that
-- has recorded demo runs holds rows this index would refuse. Creating it is
-- therefore conditional, and reports what blocks it instead of failing the
-- whole script -- the same honesty rule the self-skipping bypass tests follow.
-- Clearing those rows is a judgment call about demo history, not something a
-- constraint script should do silently: /proof's committed capture cites two
-- of them by id.
DO $$
DECLARE
  conflicts int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'authorizations_one_decision_per_external_ref'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO conflicts FROM (
    SELECT 1 FROM "authorizations"
    WHERE "externalRef" IS NOT NULL
    GROUP BY "mandateId", "externalRef"
    HAVING count(*) > 1
  ) dupes;

  IF conflicts > 0 THEN
    RAISE NOTICE 'D-74: skipping authorizations_one_decision_per_external_ref -- % (mandateId, externalRef) pair(s) already duplicated. These are pre-D-74 rows (see the demo-route note above). The application-level replay check is active regardless; the index is what closes the concurrent-delivery race.', conflicts;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX authorizations_one_decision_per_external_ref
    ON "authorizations" ("mandateId", "externalRef")
    WHERE "externalRef" IS NOT NULL;
END $$;
