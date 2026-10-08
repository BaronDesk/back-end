-- AlterTable
ALTER TABLE "gamer_profiles" ADD COLUMN     "avatar_url" TEXT;

-- AlterTable
ALTER TABLE "membership_plans" ADD COLUMN     "badge_url" TEXT;

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "badge_url" TEXT;

-- CreateTable
CREATE TABLE "ranks" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_xp" INTEGER NOT NULL,
    "badge_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ranks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ranks_name_key" ON "ranks"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ranks_min_xp_key" ON "ranks"("min_xp");

