-- CreateEnum
CREATE TYPE "GameLaunchType" AS ENUM ('exe', 'steam', 'epic');

-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'CATALOG_UPDATE';

-- games: slug becomes the wire gameId, launch_ref becomes target. Renamed,
-- not dropped, so existing rows keep their values.
ALTER TABLE "games" RENAME COLUMN "slug" TO "game_id";
ALTER INDEX "games_slug_key" RENAME TO "games_game_id_key";
ALTER TABLE "games" RENAME COLUMN "launch_ref" TO "target";

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "arguments" TEXT,
ADD COLUMN     "launch_type" "GameLaunchType" NOT NULL DEFAULT 'exe',
ADD COLUMN     "process_name" TEXT,
ADD COLUMN     "working_directory" TEXT;

-- machine_games: the guessed `installed` flag is replaced by the agent-reported
-- station_game_status; rows now mean "assigned to this machine" + overrides.
ALTER TABLE "machine_games" DROP COLUMN "installed",
ADD COLUMN     "arguments" TEXT,
ADD COLUMN     "target" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "working_directory" TEXT;

-- CreateTable
CREATE TABLE "game_branches" (
    "game_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_branches_pkey" PRIMARY KEY ("game_id","branch_id")
);

-- CreateTable
CREATE TABLE "station_game_status" (
    "machine_id" UUID NOT NULL,
    "game_id" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "reported_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "station_game_status_pkey" PRIMARY KEY ("machine_id","game_id")
);

-- CreateIndex
CREATE INDEX "game_branches_branch_id_idx" ON "game_branches"("branch_id");

-- AddForeignKey
ALTER TABLE "game_branches" ADD CONSTRAINT "game_branches_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_branches" ADD CONSTRAINT "game_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_game_status" ADD CONSTRAINT "station_game_status_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
