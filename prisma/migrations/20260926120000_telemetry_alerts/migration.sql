-- CreateEnum
CREATE TYPE "AlertCategory" AS ENUM ('HARDWARE', 'ANTI_THEFT', 'SECURITY_VIOLATION');

-- node_telemetry: one-row-per-metric samples become one thinned row per
-- machine with a jsonb metrics map. Old per-metric rows have no mapping into
-- the new shape and the table was never written to, so they are dropped.
DELETE FROM "node_telemetry";

-- DropIndex
DROP INDEX "node_telemetry_metric_idx";

-- DropIndex
DROP INDEX "node_telemetry_sampled_at_idx";

-- AlterTable
ALTER TABLE "node_telemetry" DROP COLUMN "metric",
DROP COLUMN "sampled_at",
DROP COLUMN "value",
ADD COLUMN     "metrics" JSONB NOT NULL,
ADD COLUMN     "recorded_at" TIMESTAMPTZ NOT NULL;

-- AlterTable: keep any existing alert rows. The old enum type becomes free
-- text and they are filed under HARDWARE.
ALTER TABLE "telemetry_alerts" ADD COLUMN     "branch_id" UUID,
ADD COLUMN     "category" "AlertCategory" NOT NULL DEFAULT 'HARDWARE',
ADD COLUMN     "value" JSONB,
ALTER COLUMN "type" SET DATA TYPE TEXT USING "type"::text,
ALTER COLUMN "severity" SET DEFAULT 'MEDIUM';

ALTER TABLE "telemetry_alerts" ALTER COLUMN "category" DROP DEFAULT;

-- DropEnum
DROP TYPE "TelemetryAlertType";

-- CreateIndex
CREATE INDEX "node_telemetry_recorded_at_idx" ON "node_telemetry"("recorded_at");

-- CreateIndex
CREATE INDEX "telemetry_alerts_branch_id_idx" ON "telemetry_alerts"("branch_id");

-- CreateIndex
CREATE INDEX "telemetry_alerts_category_idx" ON "telemetry_alerts"("category");

-- AddForeignKey
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
