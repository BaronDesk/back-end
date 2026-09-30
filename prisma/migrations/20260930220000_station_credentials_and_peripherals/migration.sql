ALTER TABLE "machines"
ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "peripherals" JSONB,
ADD COLUMN "peripherals_reported_at" TIMESTAMPTZ;
