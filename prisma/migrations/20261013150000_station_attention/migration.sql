-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "needs_attention" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "attention_reason" TEXT,
ADD COLUMN     "attention_since" TIMESTAMPTZ;
