ALTER TABLE "tournaments"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Tournament',
  ADD COLUMN "cover_image_url" TEXT,
  ADD COLUMN "event_starts_at" TIMESTAMPTZ,
  ADD COLUMN "event_ends_at" TIMESTAMPTZ;

UPDATE "tournaments"
SET "event_starts_at" = "check_in_closes_at",
    "event_ends_at" = "check_in_closes_at" + INTERVAL '2 hours';

ALTER TABLE "tournaments"
  ALTER COLUMN "name" DROP DEFAULT,
  ALTER COLUMN "event_starts_at" SET NOT NULL,
  ALTER COLUMN "event_ends_at" SET NOT NULL;

ALTER TABLE "tournament_entrants"
  ADD COLUMN "join_pin_hash" TEXT;

CREATE UNIQUE INDEX "tournament_entrants_join_pin_hash_key"
  ON "tournament_entrants"("join_pin_hash");
