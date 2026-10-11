ALTER TABLE "tournament_members" ADD COLUMN "refund_ledger_entry_id" UUID;
CREATE UNIQUE INDEX "tournament_members_refund_ledger_entry_id_key" ON "tournament_members"("refund_ledger_entry_id");
