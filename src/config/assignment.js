// ─── Order assignment/acceptance window ──
// Configurable via env; clamped to the 60-120s range the spec calls for.
const raw = Number(process.env.ACCEPT_WINDOW_SECONDS);
const ACCEPT_WINDOW_SECONDS = Number.isFinite(raw) ? Math.min(120, Math.max(60, raw)) : 90;

module.exports = { ACCEPT_WINDOW_SECONDS };
