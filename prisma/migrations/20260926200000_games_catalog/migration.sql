-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'LAUNCH_GAME';
ALTER TYPE "CommandType" ADD VALUE 'END_SESSION';

-- Reshape the (so far unused) games table into the launch catalog.
-- DropIndex
DROP INDEX "games_genre_idx";
DROP INDEX "games_title_idx";
DROP INDEX "games_title_key";

-- AlterTable
ALTER TABLE "games" RENAME COLUMN "title" TO "name";
ALTER TABLE "games" RENAME COLUMN "executable_path" TO "launch_ref";
ALTER TABLE "games" DROP COLUMN "genre",
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "icon_url" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Backfill a unique slug for any pre-existing rows.
UPDATE "games"
SET "slug" = trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'))) || '-' || left("id"::text, 8);
ALTER TABLE "games" ALTER COLUMN "slug" SET NOT NULL;

-- AlterTable
ALTER TABLE "commands" ADD COLUMN     "game_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "games_slug_key" ON "games"("slug");

-- CreateIndex
CREATE INDEX "games_enabled_sort_order_idx" ON "games"("enabled", "sort_order");

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
