import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NBSP, formatCentsInput, formatEuro, formatHundredths, formatKm, formatLitres, formatPrice } from '../shared/format.js';
import { splitCents } from '../src/fuel.ts';
import { S, fieldErrorText } from '../public/strings.js';
import { deriveFuel, parseDecimal } from '../public/views/fuel.js';
import { readAmount } from '../public/views/tickets.js';

// The oracle: Intl with nl-NL. It is only used to check the integer-built strings, never to build them.
const intlEuro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

test('the euro is written "€ 12,50": non-breaking space, comma, thousands dot', () => {
  assert.equal(NBSP, '\u00a0');
  assert.equal(formatEuro(0), `€${NBSP}0,00`);
  assert.equal(formatEuro(5), `€${NBSP}0,05`);
  assert.equal(formatEuro(100), `€${NBSP}1,00`);
  assert.equal(formatEuro(1250), `€${NBSP}12,50`);
  assert.equal(formatEuro(1234567), `€${NBSP}12.345,67`);
  assert.equal(formatEuro(100_000_000), `€${NBSP}1.000.000,00`);
  assert.equal(formatEuro(-1250), `€${NBSP}-12,50`, 'negative amounts follow the pattern of Intl nl-NL');
  assert.equal(formatEuro(-5), `€${NBSP}-0,05`);
  assert.ok(!formatEuro(1250).includes(' '), 'the only space is the non-breaking one');
});

test('formatEuro agrees with Intl nl-NL over a sweep of amounts (Intl is only the oracle)', () => {
  for (const cents of [0, 1, 5, 9, 10, 99, 100, 101, 999, 1000, 1250, 99_999, 100_000, 123_456, 1_000_000, 1_234_567, -1, -250, -123_456]) {
    assert.equal(formatEuro(cents), intlEuro.format(cents / 100), `${cents} cents`);
  }
});

test('euro and numbers never throw: a value that is not a safe integer gives an en dash', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 60, Number.MAX_SAFE_INTEGER + 2, '12' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    assert.equal(formatEuro(bad), `€${NBSP}–`);
    assert.equal(formatCentsInput(bad), '–');
    assert.equal(formatLitres(bad), '–');
    assert.equal(formatPrice(bad), '–');
    assert.equal(formatKm(bad), '–');
  }
  assert.equal(formatEuro(Number.MAX_SAFE_INTEGER), `€${NBSP}90.071.992.547.409,91`);
});

test('input form: a comma, two decimals, no grouping', () => {
  assert.equal(formatCentsInput(0), '0,00');
  assert.equal(formatCentsInput(5), '0,05');
  assert.equal(formatCentsInput(1500), '15,00');
  assert.equal(formatCentsInput(7560), '75,60');
  assert.equal(formatCentsInput(100), '1,00');
  assert.equal(formatCentsInput(1_000_000), '10000,00', 'the largest amount of a fill-up is not grouped, so it parses back');
  assert.equal(formatCentsInput(-250), '-2,50');
});

test('litres: two decimals when that is exact, else three, with a comma', () => {
  assert.equal(formatLitres(40_000), '40,00');
  assert.equal(formatLitres(40_500), '40,50');
  assert.equal(formatLitres(40_123), '40,123');
  assert.equal(formatLitres(500), '0,50');
  assert.equal(formatLitres(1), '0,001');
  assert.equal(formatLitres(10), '0,01');
  assert.equal(formatLitres(200_000), '200,00');
});

test('price per litre: three decimals with a comma', () => {
  assert.equal(formatPrice(1859), '1,859');
  assert.equal(formatPrice(2000), '2,000');
  assert.equal(formatPrice(5), '0,005');
  assert.equal(formatPrice(0), '0,000');
});

test('kilometres: a thousands dot, no locale involved', () => {
  assert.equal(formatKm(0), '0');
  assert.equal(formatKm(999), '999');
  assert.equal(formatKm(1000), '1.000');
  assert.equal(formatKm(45_210), '45.210');
  assert.equal(formatKm(10_000_000), '10.000.000');
  assert.equal(formatKm(-1500), '-1.500');
  assert.equal(formatKm(45_210), new Intl.NumberFormat('nl-NL').format(45_210), 'the same as Intl, which writes 5 digits with a dot');
});

test('parseDecimal accepts comma and dot, and refuses everything else', () => {
  const ok: Array<[string, number, number]> = [
    ['40,5', 2, 4050],
    ['40.5', 2, 4050],
    ['1,859', 3, 1859],
    ['1.859', 3, 1859],
    ['.5', 2, 50],
    [',5', 2, 50],
    ['12,', 2, 1200],
    [' 7 ', 2, 700],
    ['0', 2, 0],
    ['75,60', 2, 7560],
  ];
  for (const [text, decimals, value] of ok) assert.equal(parseDecimal(text, decimals), value, `"${text}"`);
  const refused: Array<[string, number]> = [
    ['', 2],
    ['abc', 2],
    ['-1', 2],
    ['+1', 2],
    ['1e3', 2],
    ['12,345', 2],
    ['1.234,56', 2],
    ['1,234.56', 2],
    ['1 234', 2],
    ['12,3,4', 2],
    [',', 2],
    ['.', 2],
  ];
  for (const [text, decimals] of refused) assert.equal(parseDecimal(text, decimals), null, `"${text}"`);
});

test('formatting then parsing is the identity over every cent of a fill-up and every millilitre', () => {
  for (let cents = 0; cents <= 1_000_000; cents += 1) {
    if (parseDecimal(formatCentsInput(cents), 2) !== cents) assert.fail(`cents ${cents} -> ${formatCentsInput(cents)}`);
  }
  for (let ml = 0; ml <= 200_000; ml += 1) {
    if (parseDecimal(formatLitres(ml), 3) !== ml) assert.fail(`millilitres ${ml} -> ${formatLitres(ml)}`);
  }
  for (let thousandths = 0; thousandths <= 9999; thousandths += 1) {
    if (parseDecimal(formatPrice(thousandths), 3) !== thousandths) assert.fail(`price ${thousandths} -> ${formatPrice(thousandths)}`);
  }
});

test('deriveFuel gives the same result for comma and dot spellings', () => {
  const pairs: Array<[{ litres: string; total: string; price: string }, { litres: string; total: string; price: string }]> = [
    [{ litres: '40.5', total: '75.60', price: '' }, { litres: '40,5', total: '75,60', price: '' }],
    [{ litres: '12.345', total: '', price: '1.859' }, { litres: '12,345', total: '', price: '1,859' }],
    [{ litres: '', total: '50.00', price: '1.859' }, { litres: '', total: '50,00', price: '1,859' }],
    [{ litres: '40', total: '75.6', price: '9.999' }, { litres: '40', total: '75,6', price: '9,999' }],
  ];
  for (const [dot, comma] of pairs) {
    const a = deriveFuel(dot);
    assert.equal(a.ok, true);
    assert.deepEqual(deriveFuel(comma), a);
  }
  assert.deepEqual(deriveFuel({ litres: '40,5', total: '75,60', price: '' }), { ok: true, millilitres: 40_500, totalCents: 7560, pricePerLitreMillis: 1867 });
});

test('a derived fill-up prints and parses back to the same integers, and its shares still sum to the cent', () => {
  for (const [litres, total] of [['40,5', '75,60'], ['12,345', '22,95'], ['0,001', '0,01'], ['200', '10000'], ['39,99', '70,31']] as const) {
    const d = deriveFuel({ litres, total, price: '' });
    assert.equal(d.ok, true, `${litres} L ${total}`);
    if (!d.ok) continue;
    assert.equal(parseDecimal(formatLitres(d.millilitres), 3), d.millilitres);
    assert.equal(parseDecimal(formatCentsInput(d.totalCents), 2), d.totalCents);
    assert.equal(parseDecimal(formatPrice(d.pricePerLitreMillis), 3), d.pricePerLitreMillis);
    const shares = splitCents(d.totalCents, [
      { userId: 1, weight: 7 },
      { userId: 2, weight: 5 },
      { userId: 3, weight: 1 },
    ]);
    assert.equal(
      shares.reduce((sum, s) => sum + s.cents, 0),
      d.totalCents,
      'the shares add up to the total to the cent',
    );
  }
});

// ----------------------------------------------------------------- added by the test stage

test('typed thousands grouping is refused in the fuel form and the ticket form, with a Dutch hint that shows a comma', () => {
  for (const grouped of ['1.234,56', '1,234.56', '10.000,00', '1 234,56', '1.234']) {
    assert.deepEqual(readAmount(grouped), { ok: false, code: 'invalid_amount' }, `ticket price "${grouped}"`);
    const derived = deriveFuel({ litres: '', total: grouped, price: '1,859' });
    assert.equal(derived.ok, false, `fuel total "${grouped}"`);
    if (!derived.ok) assert.deepEqual(derived.errors, { total: 'invalid_amount' });
  }
  // What a person is told: a sentence in Dutch, with the way to write it.
  assert.equal(fieldErrorText('invalid_amount'), S.fieldErrors.invalid_amount);
  assert.match(S.fieldErrors.invalid_amount, /^Vul .*bijvoorbeeld 40,5\.$/);
  // The plain spellings of the same amounts are fine.
  assert.deepEqual(readAmount('1234,56'), { ok: true, cents: 123_456 });
  assert.deepEqual(readAmount('1234.56'), { ok: true, cents: 123_456 });
});

test('parseDecimal edge cases: at most nine whole digits, ASCII digits only, space only around the number, a zero beyond the decimals is still refused', () => {
  const ok: Array<[string, number, number]> = [
    ['000,5', 2, 50],
    ['007', 2, 700],
    ['0,5', 2, 50],
    ['123456789', 2, 12_345_678_900],
    ['123456789,99', 2, 12_345_678_999],
    ['123456789,999', 3, 123_456_789_999],
    ['\u00a07\u00a0', 2, 700], // a non-breaking space from a paste or a keyboard
    ['\t7\n', 2, 700],
    ['40,50', 3, 40_500],
    ['40,', 3, 40_000],
    ['0,001', 3, 1],
  ];
  for (const [text, decimals, value] of ok) assert.equal(parseDecimal(text, decimals), value, JSON.stringify(text));
  const refused: Array<[string, number]> = [
    ['1234567890', 2], // ten digits: would not stay a safe integer once scaled
    ['1234567890,5', 3],
    ['٤٠,٥', 2], // Arabic-Indic digits
    ['４０', 2], // full-width digits
    ['4 0', 2],
    ['40, 5', 2],
    ['40 ,5', 2],
    ['1,,5', 2],
    ['1.5.', 2],
    ['1;5', 2],
    ["1'5", 2],
    ['1٫5', 2], // the Arabic decimal separator
    ['40,500', 2], // a third decimal is refused even when it is a zero: nothing is rounded away
    ['40,5000', 3],
    ['0,001', 2],
    ['€5', 2],
    ['5 L', 3],
    ['5%', 2],
    ['Infinity', 2],
    ['NaN', 2],
    ['0x10', 2],
    ['--5', 2],
  ];
  for (const [text, decimals] of refused) assert.equal(parseDecimal(text, decimals), null, JSON.stringify(text));
});

test('a comma and a dot are the same decimal separator: the spelling never changes a number', () => {
  for (const decimals of [2, 3]) {
    for (let whole = 0; whole <= 3000; whole += 1) {
      for (const fraction of ['', '5', '05', '50', '99']) {
        const comma = parseDecimal(`${whole},${fraction}`, decimals);
        const dot = parseDecimal(`${whole}.${fraction}`, decimals);
        const expected = whole * 10 ** decimals + Number(fraction.padEnd(decimals, '0') || '0');
        if (comma !== expected || dot !== expected) assert.fail(`${whole} / "${fraction}" with ${decimals} decimals: comma ${comma}, dot ${dot}, expected ${expected}`);
      }
    }
  }
});

test('the formatters agree with a BigInt reference over every magnitude up to the largest safe integer: no float rounding anywhere', () => {
  let seed = 20_261_123;
  // mulberry32: every bit is usable (the low bits of a plain LCG cycle, and never reached the 16-digit numbers).
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const dots = (digits: string): string => {
    const parts: string[] = [];
    for (let end = digits.length; end > 0; end -= 3) parts.unshift(digits.slice(Math.max(0, end - 3), end));
    return parts.join('.');
  };
  for (let i = 0; i < 4000; i += 1) {
    // Every length from 1 to 16 digits, equally often. A 16-digit number starts with 1 to 8, so it is always a safe integer.
    const length = 1 + (i % 16);
    let digits = String(length === 16 ? 1 + (next() % 8) : length === 1 ? next() % 10 : 1 + (next() % 9));
    for (let d = length - 1; d > 0; d -= 1) digits += String(next() % 10);
    let value = Number(digits);
    assert.ok(Number.isSafeInteger(value) && String(Math.abs(value)).length === length, `a ${length}-digit safe integer: ${digits}`);
    if (next() % 2 === 0) value = -value;
    const abs = BigInt(Math.abs(value));
    const sign = value < 0 ? '-' : '';
    const hundredths = String(abs % 100n).padStart(2, '0');
    const thousandths = String(abs % 1000n).padStart(3, '0');
    assert.equal(formatEuro(value), `€${NBSP}${sign}${dots(String(abs / 100n))},${hundredths}`, `euro ${value}`);
    assert.equal(formatCentsInput(value), `${sign}${abs / 100n},${hundredths}`, `input ${value}`);
    assert.equal(formatKm(value), `${sign}${dots(String(abs))}`, `km ${value}`);
    assert.equal(formatLitres(value), `${sign}${abs / 1000n},${abs % 10n === 0n ? thousandths.slice(0, 2) : thousandths}`, `litres ${value}`);
    assert.equal(formatPrice(value), `${sign}${abs / 1000n},${thousandths}`, `price ${value}`);
    assert.equal(formatHundredths(value), `${sign}${dots(String(abs / 100n))},${hundredths}`, `hundredths ${value}`);
  }
});

test('hundredths are written with a decimal comma and two decimals (litres per 100 km)', () => {
  assert.equal(formatHundredths(0), '0,00');
  assert.equal(formatHundredths(5), '0,05');
  assert.equal(formatHundredths(650), '6,50');
  assert.equal(formatHundredths(1234), '12,34');
  assert.equal(formatHundredths(123_456), '1.234,56');
  assert.equal(formatHundredths(-250), '-2,50');
  assert.equal(formatHundredths(1.5), '–', 'not an integer: a dash, never a crash');
  assert.equal(formatHundredths(Number.NaN), '–');
});
