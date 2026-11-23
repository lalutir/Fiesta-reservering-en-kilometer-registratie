// Number and money formatting, written once for the server (push texts, payment requests) and the browser
// (/shared/format.js, the same file). Dutch conventions: a decimal comma, a thousands dot, and the euro sign
// in front of the amount with a non-breaking space so the sign never wraps away from the number.
//
// Everything here is integer arithmetic on strings: money is whole cents and volume whole millilitres in this
// app, and no float ever decides or prints an amount. `Intl` is deliberately not used for numbers (the tests
// use it only as an oracle). The functions never throw: a value that is not a safe integer comes out as an
// en dash, so a bad value shows up as a gap in the text and not as a crash.
//
// The parsing side (comma or dot accepted) is `parseDecimal` in public/views/fuel.js; `formatCentsInput`,
// `formatLitres` and `formatPrice` are written so their output parses back to the same integer.

/** A non-breaking space, written as an escape: a literal one in source is invisible in review and trips the linter. */
export const NBSP = '\u00a0';

const MISSING = '–';

/** @param {string} digits */
function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * An integer split into sign and magnitude.
 * @param {number} value
 * @returns {{ sign: string, abs: number } | null}
 */
function split(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return { sign: value < 0 ? '-' : '', abs: Math.abs(value) };
}

/**
 * Money as people read it: 1250 -> "€ 12,50", 123456700 -> "€ 1.234.567,00", -1250 -> "€ -12,50".
 * @param {number} cents
 * @returns {string}
 */
export function formatEuro(cents) {
  const s = split(cents);
  if (!s) return `€${NBSP}${MISSING}`;
  return `€${NBSP}${s.sign}${group(String(Math.floor(s.abs / 100)))},${String(s.abs % 100).padStart(2, '0')}`;
}

/**
 * Money for an input field: a comma, two decimals and no grouping, so it parses back to the same cents.
 * 1250 -> "12,50", 5 -> "0,05".
 * @param {number} cents
 * @returns {string}
 */
export function formatCentsInput(cents) {
  const s = split(cents);
  if (!s) return MISSING;
  return `${s.sign}${Math.floor(s.abs / 100)},${String(s.abs % 100).padStart(2, '0')}`;
}

/**
 * Litres from millilitres, with a comma: 40500 -> "40,50", 40123 -> "40,123", 500 -> "0,50". Two decimals when
 * that is exact, three otherwise. Never grouped (a tank is far below 1000 litres) so it also fills an input.
 * @param {number} millilitres
 * @returns {string}
 */
export function formatLitres(millilitres) {
  const s = split(millilitres);
  if (!s) return MISSING;
  const whole = Math.floor(s.abs / 1000);
  const rest = String(s.abs % 1000).padStart(3, '0');
  return `${s.sign}${whole},${s.abs % 10 === 0 ? rest.slice(0, 2) : rest}`;
}

/**
 * The price per litre from thousandths of a euro, three decimals: 1859 -> "1,859", 2000 -> "2,000".
 * @param {number} thousandths
 * @returns {string}
 */
export function formatPrice(thousandths) {
  const s = split(thousandths);
  if (!s) return MISSING;
  return `${s.sign}${Math.floor(s.abs / 1000)},${String(s.abs % 1000).padStart(3, '0')}`;
}

/**
 * Kilometres with a thousands dot, not locale dependent: 45210 -> "45.210".
 * @param {number} km
 * @returns {string}
 */
export function formatKm(km) {
  const s = split(km);
  if (!s) return MISSING;
  return `${s.sign}${group(String(s.abs))}`;
}
