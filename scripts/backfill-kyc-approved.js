// One-off migration: grandfather vendors/riders that were already
// account-approved before the KYC feature existed — otherwise they get
// locked out of their dashboard by requireApprovedVendor/requireApprovedRider
// despite having been live and trusted beforehand.
//
// Usage: node scripts/backfill-kyc-approved.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.user.updateMany({
    where: {
      role: { in: ['VENDOR', 'RIDER'] },
      vendorStatus: 'APPROVED',
      kycStatus: { not: 'APPROVED' },
    },
    data: { kycStatus: 'APPROVED' },
  });
  console.log(`Backfilled kycStatus=APPROVED for ${result.count} account(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
