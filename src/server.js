// ── Server entry point ──
require('dotenv').config();
const app = require('./app');
const prisma = require('./config/prisma');
const { processDueSubscriptions } = require('./services/subscription.service');
const { SUBSCRIPTION_CHECK_INTERVAL_MINUTES } = require('./config/subscription');

const PORT = process.env.PORT || 4000;

let subscriptionInterval = null;

function runSubscriptionSweep() {
  processDueSubscriptions()
    .then(({ processed, failed }) => {
      if (processed || failed) {
        console.log(`[subscriptions] processed ${processed}, failed ${failed}`);
      }
    })
    .catch((err) => console.error('[subscriptions] sweep error:', err));
}

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

    runSubscriptionSweep();
    subscriptionInterval = setInterval(runSubscriptionSweep, SUBSCRIPTION_CHECK_INTERVAL_MINUTES * 60 * 1000);
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (subscriptionInterval) clearInterval(subscriptionInterval);
  await prisma.$disconnect();
  process.exit(0);
});

start();
