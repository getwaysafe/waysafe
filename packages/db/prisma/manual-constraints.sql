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
-- ONE VALUE IS EXCLUDED, and the exclusion is closed rather than open-ended.
-- Until D-74 the /film demo route minted `iauth_demo_<networkId>` per
-- scenario, and /proof's scenario list deliberately uses one networkId for two
-- different amounts -- so two distinct card authorizations in a single run
-- shared that id. Those rows cannot be deleted: each is the `subjectId` of an
-- evidence event, and two of them sit inside the contiguous, published chain
-- slice /proof displays (sequences 440 and 442 of org_demo), so removing them
-- would leave published provenance pointing at nothing.
--
-- Excluding the literal is safe *because it is unmintable*: D-74 changed the
-- route to include the per-run instrument id and the scenario index, so no
-- future row can carry this value. The exemption therefore covers a finite,
-- frozen set of six historical demo rows and nothing that will ever be
-- written again. A `createdAt` cutoff was considered and rejected --
-- `createdAt` is caller-supplied in the repository, so a test could write
-- beneath it, and the exemption would be invisible and open-ended.
DO $$
DECLARE
  conflicts int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'authorizations_one_decision_per_external_ref'
  ) THEN
    RETURN;
  END IF;

  -- Guard kept for an unexpected case: any OTHER duplicated pair would still
  -- refuse the index, and a NOTICE naming it beats a failed script.
  SELECT count(*) INTO conflicts FROM (
    SELECT 1 FROM "authorizations"
    WHERE "externalRef" IS NOT NULL
      AND "externalRef" <> 'iauth_demo_goodbeans_card_9001'
    GROUP BY "mandateId", "externalRef"
    HAVING count(*) > 1
  ) dupes;

  IF conflicts > 0 THEN
    RAISE NOTICE 'D-74: skipping authorizations_one_decision_per_external_ref -- % unexpected (mandateId, externalRef) pair(s) duplicated beyond the one known frozen demo literal. Investigate before clearing: the application-level replay check is active regardless, but the concurrent-delivery race is not closed without this index.', conflicts;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX authorizations_one_decision_per_external_ref
    ON "authorizations" ("mandateId", "externalRef")
    WHERE "externalRef" IS NOT NULL
      AND "externalRef" <> 'iauth_demo_goodbeans_card_9001';
END $$;
