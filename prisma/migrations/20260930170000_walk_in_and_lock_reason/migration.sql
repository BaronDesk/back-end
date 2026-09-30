ALTER TABLE "reservations"
ADD COLUMN "is_walk_in" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sessions"
ADD COLUMN "lock_reason" TEXT;
