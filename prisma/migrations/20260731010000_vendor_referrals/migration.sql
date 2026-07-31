-- CreateEnum
CREATE TYPE "ReferralKind" AS ENUM ('CUSTOMER', 'VENDOR');

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'REFERRAL_BONUS';

-- AlterTable
ALTER TABLE "CommissionSettings" ADD COLUMN     "vendorReferralReward" DECIMAL(10,2) NOT NULL DEFAULT 1000;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "kind" "ReferralKind" NOT NULL DEFAULT 'CUSTOMER';

-- CreateIndex
CREATE INDEX "Referral_kind_status_idx" ON "Referral"("kind", "status");

