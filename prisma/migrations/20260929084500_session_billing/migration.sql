ALTER TABLE "sessions"
ADD COLUMN "locked_at" TIMESTAMPTZ,
ADD COLUMN "metering_started_at" TIMESTAMPTZ,
ADD COLUMN "metered_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rate_cents_per_minute" INTEGER,
ADD COLUMN "billing_breakdown" JSONB,
ADD COLUMN "settled_at" TIMESTAMPTZ;
