/*
  Warnings:

  - You are about to drop the column `currency` on the `pricing` table. All the data in the column will be lost.
  - You are about to alter the column `payg_rate` on the `pricing` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.
  - You are about to alter the column `booking_rate` on the `pricing` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.

*/
-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'POLICY_UPDATE';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "station_policy" JSONB;

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "policy" JSONB;

-- AlterTable
ALTER TABLE "pricing" DROP COLUMN "currency",
ALTER COLUMN "payg_rate" SET DATA TYPE INTEGER,
ALTER COLUMN "booking_rate" SET DATA TYPE INTEGER;
