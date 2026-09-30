ALTER TABLE "gamer_profiles" ADD COLUMN "home_branch_id" UUID;

CREATE INDEX "gamer_profiles_home_branch_id_idx" ON "gamer_profiles"("home_branch_id");

ALTER TABLE "gamer_profiles" ADD CONSTRAINT "gamer_profiles_home_branch_id_fkey" FOREIGN KEY ("home_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
