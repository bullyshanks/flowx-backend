// ─── Subscription due-check interval ──
// How often to scan for ACTIVE subscriptions whose nextDeliveryDate has
// arrived and turn them into orders. Configurable via env; clamped to
// 5-1440 minutes (5 min floor to avoid hammering the DB, 24h ceiling).
const raw = Number(process.env.SUBSCRIPTION_CHECK_INTERVAL_MINUTES);
const SUBSCRIPTION_CHECK_INTERVAL_MINUTES = Number.isFinite(raw) ? Math.min(1440, Math.max(5, raw)) : 15;

module.exports = { SUBSCRIPTION_CHECK_INTERVAL_MINUTES };
