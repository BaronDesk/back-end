ALTER TABLE "subscriptions"
ADD COLUMN "benefits_snapshot" JSONB,
ADD COLUMN "idempotency_key" TEXT;

UPDATE "subscriptions" AS subscription
SET "benefits_snapshot" = plan."benefits"
FROM "subscription_plans" AS plan
WHERE subscription."subscription_plan_id" = plan.id;

ALTER TABLE "subscriptions"
ALTER COLUMN "benefits_snapshot" SET NOT NULL;

CREATE UNIQUE INDEX "subscriptions_gamer_profile_id_idempotency_key_key"
ON "subscriptions"("gamer_profile_id", "idempotency_key");
