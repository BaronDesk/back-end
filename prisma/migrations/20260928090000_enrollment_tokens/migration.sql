-- CreateTable
CREATE TABLE "enrollment_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "machine_id" UUID,
    "issued_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_tokens_token_hash_key" ON "enrollment_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "enrollment_tokens_branch_id_idx" ON "enrollment_tokens"("branch_id");

-- CreateIndex
CREATE INDEX "enrollment_tokens_machine_id_idx" ON "enrollment_tokens"("machine_id");

-- CreateIndex
CREATE INDEX "enrollment_tokens_expires_at_idx" ON "enrollment_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
