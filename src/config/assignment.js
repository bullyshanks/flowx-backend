// ─── Order assignment/acceptance window ──
// Configurable via env; clamped to the 60-120s range the spec calls for.
const raw = Number(process.env.ACCEPT_WINDOW_SECONDS);
const ACCEPT_WINDOW_SECONDS = Number.isFinite(raw) ? Math.min(120, Math.max(60, raw)) : 90;

// ─── Background re-offer sweep ──
// Offers used to be retried only when someone happened to read a queue, so an
// order whose offer expired with no other vendor free fell out of every queue
// and waited for an admin to notice. This sweep is what picks those back up.
// Clamped to 30-600s; default 60.
const sweepRaw = Number(process.env.ASSIGNMENT_SWEEP_INTERVAL_SECONDS);
const ASSIGNMENT_SWEEP_INTERVAL_SECONDS = Number.isFinite(sweepRaw)
  ? Math.min(600, Math.max(30, sweepRaw))
  : 60;

module.exports = { ACCEPT_WINDOW_SECONDS, ASSIGNMENT_SWEEP_INTERVAL_SECONDS };
