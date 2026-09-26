-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('ONLINE', 'OFFLINE');

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "ip_address" TEXT,
ADD COLUMN     "last_seen" TIMESTAMPTZ,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "status" "MachineStatus" NOT NULL DEFAULT 'OFFLINE';

-- CreateIndex
CREATE INDEX "machines_status_idx" ON "machines"("status");
