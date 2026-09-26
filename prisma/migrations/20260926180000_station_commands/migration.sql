-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('LOCK', 'UNLOCK', 'SHUTDOWN');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKED', 'NACKED', 'TIMEOUT', 'FAILED');

-- CreateTable
CREATE TABLE "commands" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "type" "CommandType" NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "nack_code" TEXT,
    "nack_reason" TEXT,
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commands_machine_id_status_idx" ON "commands"("machine_id", "status");

-- CreateIndex
CREATE INDEX "commands_machine_id_issued_at_idx" ON "commands"("machine_id", "issued_at");

-- CreateIndex
CREATE INDEX "commands_branch_id_idx" ON "commands"("branch_id");

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

