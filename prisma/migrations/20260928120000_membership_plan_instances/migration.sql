-- Preserve the discount terms accepted at purchase time and support safe retries.
ALTER TABLE "memberships"
ADD COLUMN "discount_percent_snapshot" DECIMAL(5,2),
ADD COLUMN "idempotency_key" TEXT;

UPDATE "memberships" AS membership
SET "discount_percent_snapshot" = plan."discount_percent"
FROM "membership_plans" AS plan
WHERE membership."membership_plan_id" = plan.id;

ALTER TABLE "memberships"
ALTER COLUMN "discount_percent_snapshot" SET NOT NULL;

CREATE UNIQUE INDEX "memberships_gamer_profile_id_idempotency_key_key"
ON "memberships"("gamer_profile_id", "idempotency_key");
