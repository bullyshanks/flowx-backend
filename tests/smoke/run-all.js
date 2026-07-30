// Runs every smoke suite in sequence against a live server.
//   npm run smoke
const { prisma } = require('./helpers');

const SUITES = [
  ['customer', require('./customer')],
  ['roles', require('./roles')],
  ['assignment', require('./assignment')],
  ['referral', require('./referral')],
  ['push', require('./push')],
  ['payment', require('./payment')],
  ['refund', require('./refund')],
];

(async () => {
  const health = await fetch((process.env.SMOKE_API_URL || 'http://localhost:4000/api') + '/health')
    .then((r) => r.ok)
    .catch(() => false);
  if (!health) {
    console.error('Backend is not responding. Start it with `npm start` before running the smoke suite.');
    process.exit(1);
  }

  const totals = { total: 0, failed: 0 };
  const failedSuites = [];

  for (const [name, suite] of SUITES) {
    console.log(`\n${'='.repeat(52)}\n${name}\n${'='.repeat(52)}`);
    try {
      const result = await suite.run();
      totals.total += result.total;
      totals.failed += result.failed;
      if (result.failed) failedSuites.push(name);
    } catch (err) {
      console.error(`${name} suite aborted: ${err.message}`);
      failedSuites.push(name);
      totals.failed += 1;
      // A 429 halts everything downstream too — no point continuing.
      if (err.message.includes('429')) break;
    }
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`TOTAL: ${totals.total - totals.failed}/${totals.total} passed`);
  if (failedSuites.length) console.log(`Failing suites: ${failedSuites.join(', ')}`);
  await prisma.$disconnect();
  process.exit(totals.failed ? 1 : 0);
})();
