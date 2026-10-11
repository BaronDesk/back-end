CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TournamentEntrantKind" AS ENUM ('SOLO', 'TEAM');
CREATE TYPE "TournamentEntrantStatus" AS ENUM ('FORMING', 'CONFIRMED', 'CHECKED_IN', 'ELIMINATED', 'WINNER', 'WITHDRAWN', 'DISQUALIFIED');
CREATE TYPE "TournamentMemberRole" AS ENUM ('CAPTAIN', 'MEMBER');
CREATE TYPE "TournamentMemberStatus" AS ENUM ('INVITED', 'PAYMENT_PENDING', 'PAID', 'REFUNDED', 'REMOVED');
CREATE TYPE "TournamentMatchStatus" AS ENUM ('PENDING', 'READY', 'IN_PROGRESS', 'COMPLETED');

CREATE TABLE "tournaments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "branch_id" UUID NOT NULL, "game_id" UUID NOT NULL,
  "status" "TournamentStatus" NOT NULL DEFAULT 'DRAFT', "entry_fee_per_player" INTEGER NOT NULL,
  "team_size" INTEGER NOT NULL DEFAULT 1, "max_entrants" INTEGER NOT NULL,
  "registration_closes_at" TIMESTAMPTZ NOT NULL, "check_in_opens_at" TIMESTAMPTZ NOT NULL,
  "check_in_closes_at" TIMESTAMPTZ NOT NULL, "published_at" TIMESTAMPTZ,
  "prizes_json" JSONB NOT NULL DEFAULT '[]', "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL, CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "tournament_entrants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tournament_id" UUID NOT NULL,
  "kind" "TournamentEntrantKind" NOT NULL, "name" TEXT NOT NULL, "seed" INTEGER,
  "checked_in_at" TIMESTAMPTZ, "status" "TournamentEntrantStatus" NOT NULL DEFAULT 'FORMING',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tournament_entrants_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "tournament_members" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "entrant_id" UUID NOT NULL, "tournament_id" UUID NOT NULL,
  "gamer_profile_id" UUID NOT NULL, "role" "TournamentMemberRole" NOT NULL DEFAULT 'MEMBER',
  "status" "TournamentMemberStatus" NOT NULL DEFAULT 'INVITED', "amount_due" INTEGER NOT NULL,
  "amount_paid" INTEGER NOT NULL DEFAULT 0, "paid_at" TIMESTAMPTZ, "ledger_entry_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tournament_members_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "tournament_matches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tournament_id" UUID NOT NULL,
  "round" INTEGER NOT NULL, "position" INTEGER NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "status" "TournamentMatchStatus" NOT NULL DEFAULT 'PENDING', "entrant1_id" UUID, "entrant2_id" UUID,
  "winner_entrant_id" UUID, "scores_json" JSONB, "next_match_id" UUID, "next_match_slot" INTEGER,
  CONSTRAINT "tournament_matches_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reservations" ADD COLUMN "tournament_id" UUID, ADD COLUMN "tournament_match_id" UUID;
CREATE UNIQUE INDEX "tournament_entrants_tournament_id_id_key" ON "tournament_entrants"("tournament_id", "id");
CREATE UNIQUE INDEX "tournament_members_ledger_entry_id_key" ON "tournament_members"("ledger_entry_id");
CREATE UNIQUE INDEX "tournament_members_tournament_id_gamer_profile_id_key" ON "tournament_members"("tournament_id", "gamer_profile_id");
CREATE UNIQUE INDEX "tournament_matches_tournament_id_round_position_key" ON "tournament_matches"("tournament_id", "round", "position");
CREATE INDEX "tournaments_branch_id_status_idx" ON "tournaments"("branch_id", "status");
CREATE INDEX "tournaments_status_registration_closes_at_idx" ON "tournaments"("status", "registration_closes_at");
CREATE INDEX "tournament_entrants_tournament_id_status_idx" ON "tournament_entrants"("tournament_id", "status");
CREATE INDEX "tournament_members_entrant_id_status_idx" ON "tournament_members"("entrant_id", "status");
CREATE INDEX "tournament_matches_tournament_id_status_idx" ON "tournament_matches"("tournament_id", "status");

ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tournament_entrants" ADD CONSTRAINT "tournament_entrants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_members" ADD CONSTRAINT "tournament_members_tournament_id_entrant_id_fkey" FOREIGN KEY ("tournament_id", "entrant_id") REFERENCES "tournament_entrants"("tournament_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_members" ADD CONSTRAINT "tournament_members_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_members" ADD CONSTRAINT "tournament_members_gamer_profile_id_fkey" FOREIGN KEY ("gamer_profile_id") REFERENCES "gamer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_entrant1_id_fkey" FOREIGN KEY ("entrant1_id") REFERENCES "tournament_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_entrant2_id_fkey" FOREIGN KEY ("entrant2_id") REFERENCES "tournament_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winner_entrant_id_fkey" FOREIGN KEY ("winner_entrant_id") REFERENCES "tournament_entrants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tournament_match_id_fkey" FOREIGN KEY ("tournament_match_id") REFERENCES "tournament_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
