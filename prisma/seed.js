// ═══════════════════════════════════════════════════════════
//  Seed initial data: zones, products, admin user
//  Run with: npm run seed
// ═══════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const prisma = new PrismaClient();

const ZONES = [
  'North Karachi', 'Gulshan-e-Iqbal', 'DHA', 'Clifton', 'PECHS',
  'Saddar', 'Nazimabad', 'Korangi', 'Gulberg', 'Federal B Area',
];

const PRODUCTS = [
  {
    name: '19L Dispenser Bottle',
    slug: '19l-dispenser',
    description: 'Premium RO+UV purified 19-litre dispenser bottle. Minimum order 3 bottles.',
    price: 330,
    unit: 'bottle',
    minQuantity: 3,
    riderEarningPerUnit: 40,
    hasRiderDelivery: true,
  },
  {
    name: '19L Refill (4+ bottles)',
    slug: '19l-refill',
    description: 'Bulk refill pricing for existing customers. Minimum 4 bottles.',
    price: 90,
    unit: 'bottle',
    minQuantity: 4,
    riderEarningPerUnit: 40,
    hasRiderDelivery: true,
  },
  {
    name: '1.5L Bottle (Set of 6)',
    slug: '1500ml-set-of-6',
    description: '1.5-litre branded bottles. Pack of 6.',
    price: 300,
    unit: 'set of 6',
    minQuantity: 1,
    riderEarningPerUnit: 60, // Rs. 10/bottle x 6 bottles
    hasRiderDelivery: true,
  },
  {
    name: '500ml Bottle (Set of 12)',
    slug: '500ml-set-of-12',
    description: '500ml branded bottles. Pack of 12 — ideal for events.',
    price: 480,
    unit: 'set of 12',
    minQuantity: 1,
    riderEarningPerUnit: 60, // Rs. 5/bottle x 12 bottles
    hasRiderDelivery: true,
  },
  {
    name: '1000L Water Tank',
    slug: '1000l-tank',
    description: 'Industrial-grade IBC water tank. 1000 litres.',
    price: 1400,
    unit: 'tank',
    minQuantity: 1,
    riderEarningPerUnit: 0,
    hasRiderDelivery: false,
  },
];

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── Zones ──
  console.log('📍 Seeding zones...');
  for (const name of ZONES) {
    await prisma.zone.upsert({
      where: { name },
      update: {},
      create: { name, city: 'Karachi' },
    });
  }
  console.log(`   ✓ ${ZONES.length} zones ready\n`);

  // ─── Products ──
  console.log('🛒 Seeding products...');
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {
        price: p.price,
        description: p.description,
        riderEarningPerUnit: p.riderEarningPerUnit,
        hasRiderDelivery: p.hasRiderDelivery,
      },
      create: p,
    });
  }
  console.log(`   ✓ ${PRODUCTS.length} products ready\n`);

  // ─── Commission settings ──
  console.log('💰 Seeding commission settings...');
  const existingSettings = await prisma.commissionSettings.findFirst();
  if (!existingSettings) {
    await prisma.commissionSettings.create({
      data: { defaultCommissionPct: 20 },
    });
  }
  console.log('   ✓ Default commission: 20%\n');

  // ─── Admin user ──
  console.log('👤 Seeding admin user...');
  const adminPhone = process.env.ADMIN_PHONE || '03158374442';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const hashedPassword = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { phone: adminPhone },
    update: { role: 'ADMIN' },
    create: {
      name: 'FlowX Admin',
      phone: adminPhone,
      password: hashedPassword,
      role: 'ADMIN',
      isVerified: true,
    },
  });
  console.log(`   ✓ Admin: ${adminPhone} / ${adminPassword}\n`);

  console.log('✅ Done!');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
