-- AlterTable
ALTER TABLE "CommissionSettings" ALTER COLUMN "vendorReferralReward" SET DEFAULT 500;


-- The 1000 was a placeholder from the migration that introduced this column,
-- never a chosen figure, and never reached production. Move existing rows to
-- the agreed 500 — but only those still holding the placeholder, so a value
-- somebody deliberately set is left alone.
UPDATE "CommissionSettings" SET "vendorReferralReward" = 500 WHERE "vendorReferralReward" = 1000;
