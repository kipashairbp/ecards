// Normalizes any phone number input (dashes, dots, spaces, parens, an
// optional leading US country code "1") down to the canonical display
// format "123-456-7890" used everywhere in the system. Anything that isn't
// a recognizable 10-digit US number is left as the caller's trimmed input
// rather than corrupted/dropped, since not every phone field is required.
export function normalizePhone(raw) {
  if (raw === undefined || raw === null) return raw;
  const str = String(raw).trim();
  if (!str) return '';
  let digits = str.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return str;
}

// Strict format check, used everywhere a phone number is written (public
// forms, admin edit routes, bulk import) to reject anything normalizePhone
// couldn't turn into a clean 10-digit number — spaces/dashes/parens are
// still ignored (stripped before counting), but a number that's too short,
// too long, or 11 digits without a leading 1 no longer silently passes
// through unformatted. Blank is valid here — whether a phone field is
// required at all is a separate, per-field concern.
export function isValidPhone(raw) {
  if (raw === undefined || raw === null) return true;
  const str = String(raw).trim();
  if (!str) return true;
  const digits = str.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

// Last-10-digit, position-by-position difference count between two phone
// numbers — used to catch a home phone and a cell number that are the same
// real line retyped with a typo (identical, or off by only 1-2 digits),
// as opposed to two genuinely different numbers. Infinity if either side
// doesn't have exactly 10 digits to compare.
export function phoneDigitDistance(a, b) {
  const da = String(a || '').replace(/\D/g, '').slice(-10);
  const db_ = String(b || '').replace(/\D/g, '').slice(-10);
  if (da.length !== 10 || db_.length !== 10) return Infinity;
  let diff = 0;
  for (let i = 0; i < 10; i++) if (da[i] !== db_[i]) diff++;
  return diff;
}
