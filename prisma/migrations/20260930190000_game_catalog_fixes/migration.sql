ALTER TABLE "machine_games"
ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "station_installed_games" (
    "machine_id" UUID NOT NULL,
    "launch_type" "GameLaunchType" NOT NULL,
    "target" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "process_name" TEXT,
    "reported_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "station_installed_games_pkey" PRIMARY KEY ("machine_id", "launch_type", "target")
);

CREATE INDEX "station_installed_games_launch_type_target_idx" ON "station_installed_games"("launch_type", "target");

ALTER TABLE "station_installed_games" ADD CONSTRAINT "station_installed_games_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
