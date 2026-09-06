// Tiny scheduler so any place a disccardpromos write fails (approval,
// reject, delete, ...) can ask for the season to be re-matched shortly,
// without importing the enforcer itself — routes/applicants.js owns the
// enforcer (it needs that file's approval helpers) and registers it here at
// load, which keeps services/cardSync.js free of a circular import.
// Debounced per org: a burst of failures during a mass action collapses
// into one run. Single-instance in-process timer, same assumption as every
// other scheduled sweep in src/index.js.
let runner = null;
const pending = new Map();
const RETRY_DELAY_MS = Number(process.env.PROVIDER_ENFORCE_RETRY_MS) || 60 * 1000;

export function registerProviderEnforceRunner(fn) { runner = fn; }

export function scheduleProviderEnforceSoon(orgId, reason) {
  if (!runner || pending.has(orgId)) return;
  pending.set(orgId, setTimeout(() => {
    pending.delete(orgId);
    runner(orgId, `retry after: ${reason}`).catch(e => console.error('[providerEnforce] scheduled retry failed:', e.message));
  }, RETRY_DELAY_MS));
}
