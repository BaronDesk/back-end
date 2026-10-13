-- AlterEnum
ALTER TYPE "CommandStatus" ADD VALUE 'APPLIED_ON_RECONNECT';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "offline_billed_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offline_billed_for" TIMESTAMPTZ;
