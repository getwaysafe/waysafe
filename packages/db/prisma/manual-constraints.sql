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
