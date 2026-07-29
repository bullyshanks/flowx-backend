// ── Server entry point ──
require('dotenv').config();
// Must come before ./app — Sentry instruments express and prisma at
// require-time. See the note at the top of instrument.js.
const { Sentry } = require('./instrument');
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
    .catch((err) => {
      // This sweep runs on a timer with nobody watching. Without reporting it,
      // recurring orders could quietly stop being created and the first signal
      // would be a customer complaining their delivery never came.
      console.error('[subscriptions] sweep error:', err);
      Sentry?.captureException(err, { tags: { job: 'subscription-sweep' } });
    });
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
    // Boot failures are exactly the ones worth knowing about — this is the
    // P1001 that took production down. Flush before exiting, or the event is
    // still sitting in the queue when the process dies.
    Sentry?.captureException(err, { tags: { phase: 'startup' } });
    if (Sentry) await Sentry.flush(2000);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (subscriptionInterval) clearInterval(subscriptionInterval);
  if (Sentry) await Sentry.flush(2000);
  await prisma.$disconnect();
  process.exit(0);
});

start();
