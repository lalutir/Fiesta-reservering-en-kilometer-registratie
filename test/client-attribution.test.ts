// Pure client logic for kilometres that are not the driver's own and for what a fill-up asks of
// someone: what a drive sends, how ownership is worded, the carried-over lines, the states of a
// share and the "Fuel you owe" list on the History screen. The forms and screens that use them
// are in forms.test.ts and admin.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fuel, FuelShare, Reservation } from '../public/api.js';
import { driveBody, kmOwnerLabel } from '../public/dom.js';
import { S } from '../public/strings.js';
import { kmAction } from '../public/views/agenda.js';
import { carriedLines, changedLine, shareStatus } from '../public/views/fuel.js';
import { fuelOwed } from '../public/views/history.js';

type Json = Record<string, unknown>;

const START = '2026-06-15T10:00:00.000Z';
const END = '2026-06-15T12:00:00.000Z';
const iso = (offsetMinutes: number, from = START): string => new Date(Date.parse(from) + offsetMinutes * 60_000).toISOString();
const ANNA = 1;
const BEN = 2;

function res(over: Json = {}): Reservation {
  return {
    id: 7,
    userId: ANNA,
    userName: 'Anna',
    createdBy: ANNA,
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

// ------------------------------------------- kilometres that are not the driver's own

test('driveBody: kilometres that are not the driver\'s own need a note, and a person needs choosing; "mine" adds nothing to the request', () => {
  const base = { mode: 'new', start: START, end: END, odometerStart: 100, odometerEnd: 150, note: 'for Ben' } as const;
  const sent = (over: Json): Json => {
    const built = driveBody({ ...base, ...over } as never);
    assert.equal(built.ok, true);
    return built.ok ? built.body : {};
  };
  assert.equal('kmFor' in sent({}), false, 'nothing about it is sent when it is not said');
  assert.equal('kmFor' in sent({ owner: { kmFor: 'self', kmUserId: null } }), false, 'self is the default: left out');
  const person = sent({ owner: { kmFor: 'person', kmUserId: BEN } });
  assert.deepEqual([person['kmFor'], person['kmUserId']], ['person', BEN]);
  const together = sent({ owner: { kmFor: 'together', kmUserId: BEN } });
  assert.deepEqual([together['kmFor'], together['kmUserId']], ['together', null], 'together never carries a person');

  // The note is required for both, blank counts as empty, and nothing is sent: it is an error before any request.
  for (const owner of [{ kmFor: 'person', kmUserId: BEN }, { kmFor: 'together', kmUserId: null }] as const) {
    for (const note of ['', '   ']) assert.deepEqual(driveBody({ ...base, note, owner }), { ok: false, errors: { note: 'required' } }, JSON.stringify([owner, note]));
  }
  assert.deepEqual(driveBody({ ...base, owner: { kmFor: 'person', kmUserId: null } }), { ok: false, errors: { kmUserId: 'required' } }, 'the person must be chosen');
  assert.deepEqual(driveBody({ ...base, note: '', owner: { kmFor: 'person', kmUserId: null } }), { ok: false, errors: { note: 'required', kmUserId: 'required' } });
  assert.equal(driveBody({ ...base, note: '', owner: { kmFor: 'self', kmUserId: null } }).ok, true, 'the driver\'s own kilometres need no note');
  // It combines with the km obligation: a draft is still a draft.
  const draft = driveBody({ ...base, end: null, odometerEnd: null, owner: { kmFor: 'together', kmUserId: null } });
  assert.equal(draft.ok && draft.status, 'draft');
});

test('kmOwnerLabel: says whose kilometres a drive is, and nothing for the driver\'s own', () => {
  assert.equal(kmOwnerLabel({}, ANNA), null, 'older data without the field');
  assert.equal(kmOwnerLabel({ kmFor: 'self', kmUserId: null, kmUserName: null }, ANNA), null);
  assert.equal(kmOwnerLabel({ kmFor: 'together', kmUserId: null, kmUserName: null }, ANNA), S.usage.kmOwnerTogether);
  assert.equal(kmOwnerLabel({ kmFor: 'person', kmUserId: BEN, kmUserName: 'Ben' }, ANNA), S.usage.kmOwnerPerson('Ben'));
  assert.equal(kmOwnerLabel({ kmFor: 'person', kmUserId: ANNA, kmUserName: 'Anna' }, ANNA), S.usage.kmOwnerPerson(S.me), 'my own name reads as me');
});

test('kmAction: a registered reservation says when the kilometres count for someone else or for everybody', () => {
  const drive = (extra: Json) => ({ id: 3, userId: ANNA, userName: 'Anna', status: 'completed', odometerStart: 100, odometerEnd: 150, distanceKm: 50, linked: true, ...extra });
  const forBen = res({ kmState: 'registered', drive: drive({ kmFor: 'person', kmUserId: BEN, kmUserName: 'Ben' }) });
  assert.equal(kmAction(forBen, ANNA, false, iso(90)).line, `${S.agenda.kmRegistered(50, S.me)} · ${S.usage.kmOwnerPerson('Ben')}`);
  assert.equal(kmAction(forBen, BEN, false, iso(90)).line, `${S.agenda.kmRegistered(50, 'Anna')} · ${S.usage.kmOwnerPerson(S.me)}`);
  assert.equal(kmAction(res({ kmState: 'registered', drive: drive({ kmFor: 'together' }) }), ANNA, false, iso(90)).line, `${S.agenda.kmRegistered(50, S.me)} · ${S.usage.kmOwnerTogether}`);
  assert.equal(kmAction(res({ kmState: 'registered', drive: drive({ kmFor: 'self' }) }), ANNA, false, iso(90)).line, S.agenda.kmRegistered(50, S.me), 'unchanged for the driver\'s own kilometres');
});

// ------------------------------------------------ carried amounts and the History list

function owedShare(over: Json = {}): FuelShare {
  return { userId: BEN, userName: 'Ben', km: 50, cents: 1500, owes: true, carriedCents: 0, dueCents: 1500, settledBy: null, request: null, can: { request: false, markPaid: false, selfPaid: true }, ...over } as unknown as FuelShare;
}
const nameOf = (name: string, id: number): string => (id === BEN ? S.me : name);
const fuelOf = (id: number, userId: number, userName: string, shares: FuelShare[]): Fuel => ({ id, userId, userName, at: iso(-id * 60), shares }) as unknown as Fuel;

test('carriedLines: nothing when nothing is carried, otherwise what is open or taken off, and the total to pay', () => {
  const fuel = fuelOf(7, ANNA, 'Anna', []);
  assert.deepEqual(carriedLines(fuel, owedShare(), nameOf), []);
  assert.deepEqual(carriedLines(fuel, owedShare({ carriedCents: 1000, dueCents: 2500 }), nameOf), [S.fuel.carried('10.00'), S.fuel.due('25.00')]);
  assert.deepEqual(carriedLines(fuel, owedShare({ carriedCents: -400, dueCents: 1100 }), nameOf), [S.fuel.carriedBack('Anna', S.me, '4.00'), S.fuel.due('11.00')], 'names read as "me" for the viewer');
  assert.deepEqual(carriedLines(fuel, { ...owedShare(), carriedCents: undefined, dueCents: undefined } as unknown as FuelShare, nameOf), [], 'older answers without the fields');
});

test('shareStatus: a share a later payment settled is its own state, and paid still wins over it', () => {
  const settledBy = { fuelId: 8, at: iso(0) };
  assert.equal(shareStatus(owedShare({ settledBy })), 'settled');
  assert.equal(shareStatus(owedShare({ settledBy, request: { paidAt: null, changed: true } })), 'settled', 'its own unpaid request no longer matters');
  assert.equal(shareStatus(owedShare({ request: { paidAt: iso(0), changed: false } })), 'paid');
  assert.equal(shareStatus(owedShare()), 'none');
});

test('changedLine compares with what a request would ask now (the share plus what is carried), not with the share alone', () => {
  const share = owedShare({ cents: 1500, carriedCents: 1500, dueCents: 3000, request: { amountCents: 4500, paidAt: null, changed: true, currentCents: 3000 } });
  assert.equal(changedLine(share), S.fuel.changedAsked('45.00', '30.00', false, '15.00'));
  const paid = owedShare({ cents: 1500, carriedCents: 1500, dueCents: 3000, request: { amountCents: 2000, paidAt: iso(0), changed: true, currentCents: 3000 } });
  assert.equal(changedLine(paid), S.fuel.changedPaid('20.00', '30.00', true, '10.00'));
  const old = owedShare({ cents: 2000, request: { amountCents: 1500, paidAt: null, changed: true } });
  assert.equal(changedLine(old), S.fuel.changedAsked('15.00', '20.00', true, '5.00'), 'an answer without currentCents falls back to the share');
});

test('fuelOwed: my open shares first, then the latest few that are paid or settled; never my own fill-ups or shares that owe nothing', () => {
  const mine = (over: Json) => owedShare({ userId: ANNA, userName: 'Anna', ...over });
  const fuels = [
    fuelOf(9, BEN, 'Ben', [mine({}), owedShare({ userId: 3, userName: 'Carla' })]),
    fuelOf(8, BEN, 'Ben', [mine({ request: { paidAt: iso(0), changed: false } })]),
    fuelOf(7, ANNA, 'Anna', [owedShare()]),
    fuelOf(6, BEN, 'Ben', [mine({ settledBy: { fuelId: 9, at: iso(0) } })]),
    fuelOf(5, BEN, 'Ben', [mine({ owes: false, cents: 0 })]),
    fuelOf(4, BEN, 'Ben', [owedShare()]),
  ];
  assert.deepEqual(fuelOwed(fuels, ANNA).map((r) => [r.fuel.id, r.open]), [[9, true], [8, false], [6, false]], 'open first; fill-up 7 is my own, 5 owes nothing, 4 is not my share');
  assert.deepEqual(fuelOwed(fuels, 99), [], 'a person with no share has no section');
  const many = Array.from({ length: 12 }, (_, i) => fuelOf(100 + i, BEN, 'Ben', [mine({ request: { paidAt: iso(0), changed: false } })]));
  assert.equal(fuelOwed(many, ANNA).length, 5, 'only the latest few paid ones; the rest are on the Fuel screen');
});
