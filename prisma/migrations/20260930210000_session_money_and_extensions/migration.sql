ALTER TABLE "sessions"
ADD COLUMN "accrued_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "next_rate_cents_per_minute" INTEGER,
ADD COLUMN "rate_switch_at" TIMESTAMPTZ,
ADD COLUMN "ending_notice_sent_at" TIMESTAMPTZ;
