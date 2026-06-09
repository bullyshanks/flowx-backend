// ── Server entry point ──
require('dotenv').config();
const app = require('./app');
const prisma = require('./config/prisma');

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    // Test DB connection
    await prisma.$connect();
    console.log('✓ Connected to PostgreSQL');

    app.listen(PORT, () => {
      console.log('\n╔════════════════════════════════════════════╗');
      console.log(`║  🚀 FlowX API running on port ${PORT}        ║`);
      console.log(`║  📍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(24)}║`);
      console.log(`║  🌐 http://localhost:${PORT}/api/health      ║`);
      console.log('╚════════════════════════════════════════════╝\n');
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

start();
