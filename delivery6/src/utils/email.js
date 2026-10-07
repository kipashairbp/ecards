// Login (routes/auth.js) always lowercases what the user types before
// looking the account up, and SQLite string comparison is case-sensitive —
// so a users.email stored with ANY uppercase (e.g. a gabai_email typed as
// "Moshe@Gmail.com" on the shul application) was an account that could
// never be signed into and never received a password-reset email. Every
// write or lookup against users.email must go through this.
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// A free-text "email" field (owner/manager/gabai contact info) had no
// format enforcement anywhere in this app, which let multiple addresses
// get entered as one value (e.g. "a@x.com, b@x.com") — harmless-looking
// until something tries to actually mail or log in with it, at which point
// it's a broken login that's hard to diagnose from the admin side. Not a
// full RFC 5322 validator (nothing else in this app needs one either) —
// just rules out the concrete "two addresses crammed into one field" case.
// Blank is treated as valid here; required-ness is enforced separately
// wherever a field is actually mandatory.
export function looksLikeSingleEmail(email) {
  const s = String(email || '').trim();
  if (!s) return true;
  if (/[,;]/.test(s)) return false;
  if ((s.match(/@/g) || []).length !== 1) return false;
  if (/\s/.test(s)) return false;
  return true;
}
