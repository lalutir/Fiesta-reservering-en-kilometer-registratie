// Pure client logic that decides what the person sees and sends: the km button on a
// reservation card, which reservation the drive form offers and preselects, what a
// draft or finished drive sends, the fuel arithmetic and the reminder helpers.
// The modules run in Node as they are (they only touch the DOM when rendering).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FuelShare, OdometerReading, Reservation } from '../public/api.js';
import { driveBody, fmtDriveRange, formatCentsInput, formatEuro, formatLitres, formatPrice } from '../public/dom.js';
import { S } from '../public/strings.js';
import { keyBytes, reminderSupport } from '../public/views/account.js';
import { kmAction } from '../public/views/agenda.js';
import { changedLine, deriveFuel, parseDecimal, shareLinks, shareStatus } from '../public/views/fuel.js';
import { defaultsFor, offeredReservations, submitLabel, suggestReservation } from '../public/views/usage.js';

type Json = Record<string, unknown>;

const START = '2026-06-15T10:00:00.000Z';
const END = '2026-06-15T12:00:00.000Z';
const iso = (offsetMinutes: number, from = START): string => new Date(Date.parse(from) + offsetMinutes * 60_000).toISOString();

/** A confirmed reservation of user 1 (Anna) from 10:00 to 12:00 with nothing registered. */
function res(over: Json = {}): Reservation {
  return {
    id: 7,
    userId: 1,
    userName: 'Anna',
    createdBy: 1,
    createdByName: 'Anna',
    status: 'confirmed',
    suggestion: false,
    start: START,
    end: END,
    note: '',
    can: { edit: true, cancel: true, approve: false, decline: false },
    drive: null,
    kmState: 'missing',
    ...over,
  } as unknown as Reservation;
}

const ANNA = 1;
const BEN = 2;

test('kmAction: nothing before the 30 minute lead time, then Register km for the owner', () => {
  const r = res();
  for (const [who, admin] of [[ANNA, false], [BEN, true]] as const) {
    const early = kmAction(r, who, admin, iso(-31));
    assert.deepEqual(early, { line: null, state: 'missing', action: null }, `${who} sees nothing 31 minutes before`);
    const lead = kmAction(r, who, admin, iso(-30));
    assert.deepEqual(lead.action, { label: S.agenda.registerKm, href: '#/usage?res=7' }, 'exactly at the lead time');
    assert.equal(lead.line, S.agenda.kmMissing);
    assert.deepEqual(kmAction(r, who, admin, iso(30)).action, { label: S.agenda.registerKm, href: '#/usage?res=7' }, 'still offered while it runs');
    assert.deepEqual(kmAction(r, who, admin, iso(600)).action, { label: S.agenda.registerKm, href: '#/usage?res=7' }, 'and long after it ended');
  }
});

test('kmAction: another member sees "I drove this" only once it started and only while nobody registered it', () => {
  const r = res();
  assert.deepEqual(kmAction(r, BEN, false, iso(-30)), { line: null, state: 'missing', action: null }, 'not at the lead time');
  assert.deepEqual(kmAction(r, BEN, false, iso(-1)).action, null, 'not one minute before the start');
  assert.deepEqual(kmAction(r, BEN, false, iso(0)).action, { label: S.agenda.iDroveThis, href: '#/usage?res=7' }, 'at the start');
  assert.equal(kmAction(r, BEN, false, iso(90)).line, S.agenda.kmMissing);
  assert.deepEqual(kmAction(r, BEN, false, iso(300)).action, { label: S.agenda.iDroveThis, href: '#/usage?res=7' });

  const done = res({ kmState: 'registered', drive: { id: 3, userId: ANNA, userName: 'Anna', status: 'completed', odometerStart: 100, odometerEnd: 150, distanceKm: 50, linked: true } });
  assert.equal(kmAction(done, BEN, false, iso(90)).action, null, 'registered: no button for anybody else');
  assert.equal(kmAction(done, BEN, false, iso(90)).line, S.agenda.kmRegistered(50, 'Anna'));
});

test('kmAction: registered shows who and how far, draft offers Finish drive to its driver and an admin only', () => {
  const done = res({ kmState: 'registered', drive: { id: 3, userId: BEN, userName: 'Ben', status: 'completed', odometerStart: 100, odometerEnd: 142, distanceKm: 42, linked: false } });
  const registered = kmAction(done, ANNA, false, iso(-600));
  assert.deepEqual(registered, { line: 'Km geregistreerd: 42 km (Ben)', state: 'registered', action: null }, 'also long before the lead time: it is a fact, not a nag');
  assert.equal(kmAction(done, BEN, false, iso(90)).line, 'Km geregistreerd: 42 km (jij)');

  const draftDrive = { id: 9, userId: ANNA, userName: 'Anna', status: 'draft', odometerStart: 100, odometerEnd: null, distanceKm: null, linked: true };
  const draft = res({ kmState: 'draft', drive: draftDrive });
  assert.deepEqual(kmAction(draft, ANNA, false, iso(30)), {
    line: S.agenda.kmDraft,
    state: 'draft',
    action: { label: S.agenda.finishDrive, href: '#/usage?edit=9' },
  });
  const byBen = kmAction(draft, BEN, false, iso(30));
  assert.equal(byBen.line, S.agenda.kmDraftBy('Anna'));
  assert.equal(byBen.action, null, 'another member cannot finish somebody else\'s drive');
  assert.deepEqual(kmAction(draft, BEN, true, iso(30)).action, { label: S.agenda.finishDrive, href: '#/usage?edit=9' }, 'an admin can');
});

test('kmAction: only confirmed reservations carry km actions', () => {
  for (const status of ['pending', 'declined', 'expired']) {
    assert.deepEqual(kmAction(res({ status }), ANNA, false, iso(30)), { line: null, state: 'missing', action: null }, status);
  }
});

test('offeredReservations: confirmed only, newest first, upcoming included, no cut-off by count', () => {
  const many = Array.from({ length: 30 }, (_, i) => res({ id: 100 + i, start: iso(i * 60, '2026-06-01T08:00:00.000Z'), end: iso(i * 60 + 30, '2026-06-01T08:00:00.000Z') }));
  const mixed = [...many, res({ id: 1, status: 'pending' }), res({ id: 2, status: 'declined' }), res({ id: 3, start: iso(60 * 24 * 3), end: iso(60 * 24 * 3 + 60) })];
  const offered = offeredReservations(mixed);
  assert.equal(offered.length, 31, 'all 30 old ones plus the upcoming one: the old slice(-20) cut-off is gone');
  assert.equal(offered[0]?.id, 3, 'the upcoming reservation is first');
  assert.ok(offered.some((r) => r.id === 100), 'the oldest of 30 is still selectable');
  assert.deepEqual(offered.map((r) => r.start), [...offered.map((r) => r.start)].sort().reverse());

  // The reservation a drive is linked to is added even when it lies outside the fetched range, once.
  const far = res({ id: 55, start: iso(-60 * 24 * 90), end: iso(-60 * 24 * 90 + 60) });
  assert.equal(offeredReservations(mixed, far).at(-1)?.id, 55);
  assert.equal(offeredReservations([far], far).length, 1);
  assert.equal(offeredReservations([], res({ id: 56, status: 'pending' })).length, 0, 'a link to a non-confirmed reservation is not offered');
});

test('suggestReservation: the link wins, then my running one, then my latest ended one within two weeks', () => {
  const now = iso(30); // 10:30, inside the reservation
  const running = res({ id: 10, userId: ANNA });
  const ended = res({ id: 11, userId: ANNA, start: iso(-60 * 24 * 3), end: iso(-60 * 24 * 3 + 120) });
  const registered = res({ id: 12, userId: ANNA, start: iso(-60 * 5), end: iso(-60 * 4), kmState: 'registered' });
  const others = res({ id: 13, userId: BEN, userName: 'Ben', start: iso(-30), end: iso(60) });
  const longAgo = res({ id: 14, userId: ANNA, start: iso(-60 * 24 * 20), end: iso(-60 * 24 * 20 + 120) });
  const offered = offeredReservations([running, ended, registered, others, longAgo]);
  const pick = (presetId: number | null, offeredList = offered) => suggestReservation(offeredList, { meId: ANNA, nowIso: now, presetId })?.id ?? null;

  assert.equal(pick(13), 13, 'a link to somebody else\'s reservation is honoured (I drove this)');
  assert.equal(pick(12), 12, 'even one that is already registered');
  assert.equal(pick(null), 10, 'my running reservation');
  assert.equal(pick(999), 10, 'an unknown link falls back to the suggestion');
  assert.equal(pick(null, offeredReservations([ended, registered, others, longAgo])), 11, 'else my latest ended one that is not registered');
  assert.equal(pick(null, offeredReservations([registered, others, longAgo])), null, 'registered, somebody else\'s and older than 14 days are not suggested');
});

test('defaultsFor: a running or upcoming reservation starts the drive now, an ended one fills in its own times, the start reading is the latest known one before the start', () => {
  const now = '2026-06-15T10:30:45.123Z';
  const reading = (km: number): OdometerReading => ({ source: 'drive-end', id: 1, km, at: iso(-600), userId: 2, userName: 'Ben', draft: false });
  /** What the lookup was asked for, and what it answers. */
  const asked: string[] = [];
  const lookup = (km: number | null) => (at: string) => {
    asked.push(at);
    return km === null ? null : reading(km);
  };
  const upcoming = res({ start: iso(600), end: iso(700), note: 'Weekend away' });
  assert.deepEqual(defaultsFor(upcoming, now, lookup(41_200)), { start: '2026-06-15T10:30:00.000Z', end: null, odometerStart: 41_200, note: 'Weekend away' });
  assert.deepEqual(asked, ['2026-06-15T10:30:00.000Z'], 'a drive that starts now asks for the reading at the start minute');
  assert.deepEqual(defaultsFor(res(), now, lookup(null)), { start: '2026-06-15T10:30:00.000Z', end: null, odometerStart: null, note: '' }, 'running, nothing known');
  assert.deepEqual(defaultsFor(null, now, lookup(7)), { start: '2026-06-15T10:30:00.000Z', end: null, odometerStart: 7, note: '' }, 'no reservation');
  const past = res({ note: 'Groceries' });
  asked.length = 0;
  assert.deepEqual(defaultsFor(past, '2026-06-15T13:00:00.000Z', lookup(99)), { start: START, end: END, odometerStart: 99, note: 'Groceries' }, 'ended: its times, the reading before them, the end left to the person');
  assert.deepEqual(asked, [START], 'an ended reservation asks for the reading before its own start, not before now');
});

test('submitLabel follows what the form holds', () => {
  assert.equal(submitLabel('new', false, false), S.usage.submitDraft);
  assert.equal(submitLabel('draft', false, false), S.usage.submitDraft, 'an unfinished draft is saved as a draft again');
  assert.equal(submitLabel('draft', true, true), S.usage.submitFinish);
  assert.equal(submitLabel('new', true, true), S.usage.submit);
  assert.equal(submitLabel('completed', true, true), S.usage.submit);
  assert.equal(submitLabel('completed', false, false), S.usage.submit, 'a finished drive never becomes a draft');
});

test('driveBody: both end fields filled is a finished drive, both empty is a draft, one of them is an error', () => {
  const base = { mode: 'new', start: START, end: null, odometerStart: 100, odometerEnd: null, note: 'x' } as const;

  const draft = driveBody(base);
  assert.deepEqual(draft, { ok: true, status: 'draft', body: { status: 'draft', start: START, end: null, odometerStart: 100, odometerEnd: null, note: 'x' } });

  const done = driveBody({ ...base, end: END, odometerEnd: 150 });
  assert.deepEqual(done, { ok: true, status: 'completed', body: { status: 'completed', start: START, end: END, odometerStart: 100, odometerEnd: 150, note: 'x' } });

  assert.deepEqual(driveBody({ ...base, odometerStart: null }), { ok: false, errors: { odometerStart: 'required' } }, 'the start reading is always needed');
  assert.deepEqual(driveBody({ ...base, end: END }), { ok: false, errors: { odometerEnd: 'required' } }, 'an end time without an end reading');
  assert.deepEqual(driveBody({ ...base, odometerEnd: 150 }), { ok: false, errors: { end: 'required' } }, 'an end reading without an end time');
  assert.deepEqual(driveBody({ ...base, odometerStart: null, end: END }), { ok: false, errors: { odometerStart: 'required', odometerEnd: 'required' } });

  // A drive that is already finished cannot be saved as a draft.
  assert.deepEqual(driveBody({ ...base, mode: 'completed' }), { ok: false, errors: { end: 'required', odometerEnd: 'required' } });
  assert.equal(driveBody({ ...base, mode: 'completed', end: END, odometerEnd: 150 }).ok, true);
  assert.equal(driveBody({ ...base, mode: 'draft', end: END, odometerEnd: 150 }).ok, true, 'finishing a draft');
});

test('fmtDriveRange: an open drive says when it started instead of showing an end', () => {
  const tz = 'Europe/Amsterdam';
  assert.match(fmtDriveRange(START, END, tz), /12:00 – 14:00/);
  const open = fmtDriveRange(START, null, tz);
  assert.match(open, /^Gestart .*12:00, nog open$/);
  assert.ok(!open.includes('–'));
});

test('parseDecimal: integers scaled by 10^decimals, no floats, no rounding away of extra digits', () => {
  assert.equal(parseDecimal('40,5', 2), 4050);
  assert.equal(parseDecimal('40.50', 2), 4050);
  assert.equal(parseDecimal(' 1.859 ', 3), 1859);
  assert.equal(parseDecimal('2', 3), 2000);
  assert.equal(parseDecimal('.5', 2), 50);
  assert.equal(parseDecimal('0,07', 2), 7);
  assert.equal(parseDecimal('12.', 2), 1200);
  assert.equal(parseDecimal('0.1', 2) , 10);
  assert.equal(parseDecimal('1.005', 2), null, 'a third decimal is refused, not rounded');
  for (const bad of ['', ' ', '.', ',', '-1', '+1', '1e3', 'abc', '1,2,3', '1 000', '1234567890', '0x10', 'NaN', '1.2.3']) {
    assert.equal(parseDecimal(bad, 2), null, JSON.stringify(bad));
  }
});

test('deriveFuel: any two of litres, total and price give the third, with integer arithmetic', () => {
  assert.deepEqual(deriveFuel({ litres: '40', total: '75.60', price: '' }), { ok: true, millilitres: 40_000, totalCents: 7560, pricePerLitreMillis: 1890 });
  assert.deepEqual(deriveFuel({ litres: '40', total: '', price: '1.890' }), { ok: true, millilitres: 40_000, totalCents: 7560, pricePerLitreMillis: 1890 });
  assert.deepEqual(deriveFuel({ litres: '', total: '75.60', price: '1.89' }), { ok: true, millilitres: 40_000, totalCents: 7560, pricePerLitreMillis: 1890 });
  // litres and total win over a price that does not fit; the price shown is derived from them.
  assert.deepEqual(deriveFuel({ litres: '40', total: '75.60', price: '9.999' }), { ok: true, millilitres: 40_000, totalCents: 7560, pricePerLitreMillis: 1890 });
  // Rounded half up: 12.345 L at 1.859/L = 22.9494... -> 22.95
  assert.deepEqual(deriveFuel({ litres: '12.345', total: '', price: '1.859' }), { ok: true, millilitres: 12_345, totalCents: 2295, pricePerLitreMillis: 1859 });

  assert.deepEqual(deriveFuel({ litres: '40', total: '', price: '' }), { ok: false, errors: { total: 'needs_two', price: 'needs_two' } });
  assert.deepEqual(deriveFuel({ litres: '', total: '', price: '' }), { ok: false, errors: { litres: 'needs_two', total: 'needs_two', price: 'needs_two' } });
  assert.deepEqual(deriveFuel({ litres: 'abc', total: '10', price: '' }), { ok: false, errors: { litres: 'invalid_amount' } });
  assert.deepEqual(deriveFuel({ litres: '0', total: '10', price: '' }), { ok: false, errors: { litres: 'too_small' } });
  assert.deepEqual(deriveFuel({ litres: '40', total: '0', price: '' }), { ok: false, errors: { total: 'too_small' } });
  assert.deepEqual(deriveFuel({ litres: '201', total: '10', price: '' }), { ok: false, errors: { litres: 'too_large' } });
  assert.deepEqual(deriveFuel({ litres: '40', total: '10001', price: '' }), { ok: false, errors: { total: 'too_large' } });
  assert.equal(deriveFuel({ litres: '', total: '10', price: '0' }).ok, false, 'a zero price cannot give litres');
});

test('fuel formatting: whole cents, litres and thousandths of a euro', () => {
  assert.equal(formatCentsInput(5), '0,05');
  assert.equal(formatCentsInput(7560), '75,60');
  assert.equal(formatCentsInput(100), '1,00');
  assert.equal(formatLitres(40_000), '40,00');
  assert.equal(formatLitres(40_123), '40,123');
  assert.equal(formatLitres(500), '0,50');
  assert.equal(formatPrice(1859), '1,859');
  assert.equal(formatPrice(2000), '2,000');
  assert.equal(formatPrice(5), '0,005');
});

test('shareLinks encode the message; shareStatus names the state of a share', () => {
  const links = shareLinks('Hi & hello: EUR 20.00?');
  assert.equal(links.sms, 'sms:?&body=Hi%20%26%20hello%3A%20EUR%2020.00%3F');
  assert.equal(links.whatsapp, 'https://wa.me/?text=Hi%20%26%20hello%3A%20EUR%2020.00%3F');

  const share = (request: Json | null) => ({ userId: 2, userName: 'Ben', km: 10, cents: 100, owes: true, request, can: { request: true, markPaid: true } }) as unknown as FuelShare;
  assert.equal(shareStatus(share(null)), 'none');
  assert.equal(shareStatus(share({ paidAt: null, changed: false })), 'requested');
  assert.equal(shareStatus(share({ paidAt: null, changed: true })), 'changed');
  assert.equal(shareStatus(share({ paidAt: '2026-06-15T10:00:00.000Z', changed: false })), 'paid');
  assert.equal(shareStatus(share({ paidAt: '2026-06-15T10:00:00.000Z', changed: true })), 'paidChanged', 'a paid request whose share moved afterwards is not shown as plain paid');
});

test('changedLine says by how much a share moved after its request, and stays silent when it did not', () => {
  const share = (cents: number, request: Json | null) => ({ userId: 2, userName: 'Ben', km: 10, cents, owes: true, request, can: { request: true, markPaid: true } }) as unknown as FuelShare;
  const paidAt = '2026-06-15T10:00:00.000Z';
  assert.equal(changedLine(share(1500, null)), null);
  assert.equal(changedLine(share(1500, { amountCents: 1500, paidAt: null, changed: false })), null);
  assert.equal(changedLine(share(2000, { amountCents: 1500, paidAt: null, changed: true })), S.fuel.changedAsked(formatEuro(1500), formatEuro(2000), true, formatEuro(500)));
  assert.equal(changedLine(share(0, { amountCents: 1500, paidAt: null, changed: true })), S.fuel.changedAsked(formatEuro(1500), formatEuro(0), false, formatEuro(1500)), 'a share that dropped to nothing');
  assert.equal(changedLine(share(3000, { amountCents: 1500, paidAt, changed: true })), S.fuel.changedPaid(formatEuro(1500), formatEuro(3000), true, formatEuro(1500)));
  assert.equal(changedLine(share(0, { amountCents: 1500, paidAt, changed: true })), S.fuel.changedPaid(formatEuro(1500), formatEuro(0), false, formatEuro(1500)));
  assert.match(S.fuel.changedPaid(formatEuro(1500), formatEuro(3000), true, formatEuro(1500)), /nog te betalen/);
  assert.match(S.fuel.changedPaid(formatEuro(1500), formatEuro(0), false, formatEuro(1500)), /te veel betaald/);
});

test('keyBytes decodes the server key; reminderSupport tells apart ready, iOS-in-a-tab and unsupported', () => {
  assert.deepEqual([...keyBytes('AAEC_-4')], [0, 1, 2, 255, 238], 'base64url without padding');
  assert.equal(keyBytes('').length, 0);
  const key = Buffer.alloc(65, 7);
  key[0] = 4;
  assert.deepEqual([...keyBytes(key.toString('base64url'))], [...key]);

  const full = { serviceWorker: true, pushManager: true, notification: true, ios: false };
  assert.equal(reminderSupport(full), 'ready');
  assert.equal(reminderSupport({ ...full, ios: true }), 'ready', 'an installed iOS app has all three');
  assert.equal(reminderSupport({ ...full, pushManager: false, ios: true }), 'ios-install', 'iOS Safari tab: install first');
  assert.equal(reminderSupport({ ...full, notification: false, ios: true }), 'ios-install');
  assert.equal(reminderSupport({ ...full, pushManager: false }), 'unsupported');
  assert.equal(reminderSupport({ ...full, serviceWorker: false }), 'unsupported');
});
