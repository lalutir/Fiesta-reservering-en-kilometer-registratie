import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_TOLERANCE_KM, deriveChain, itemKey, type Chain, type ChainItem, type DriveInput, type FuelInput } from '../src/odometer.ts';

// ------------------------------------------------------------ A. the pure derivation

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
/** An instant `min` minutes after a fixed base; `ms` adds milliseconds. */
const T = (min: number, ms = 0): string => new Date(BASE + min * 60_000 + ms).toISOString();
/** Every reading is inside the window in these tests unless one says otherwise. */
const FROM = T(-100_000);

const NAMES: Record<number, string> = { 1: 'Anna', 2: 'Ben', 3: 'Carla' };
const name = (userId: number): string => NAMES[userId] ?? `U${userId}`;

function drive(id: number, startMin: number, endMin: number, odometerStart: number | null, odometerEnd: number | null, userId = 1): DriveInput {
  return { id, userId, userName: name(userId), start: T(startMin), end: T(endMin), odometerStart, odometerEnd, draft: false };
}
function draft(id: number, startMin: number, odometerStart: number, userId = 1): DriveInput {
  return { id, userId, userName: name(userId), start: T(startMin), end: T(startMin), odometerStart, odometerEnd: null, draft: true };
}
function fuel(id: number, atMin: number, odometer: number | null, userId = 1): FuelInput {
  return { id, userId, userName: name(userId), at: T(atMin), odometer };
}

/** kind and km of every finding, in order. */
const summary = (chain: Chain): Array<[string, number]> => chain.items.map((i) => [i.kind, i.km]);
const names = (chain: Chain): string[] => chain.readings.map((r) => `${r.source}:${r.id}:${r.km}`);

test('readings that follow on from each other give no findings', () => {
  const chain = deriveChain([drive(1, 0, 60, 100, 160), drive(2, 120, 180, 160, 200, 2)], [fuel(1, 90, 160, 3)], FROM);
  assert.deepEqual(chain.items, []);
  assert.deepEqual(names(chain), ['drive-start:1:100', 'drive-end:1:160', 'fuel:1:160', 'drive-start:2:160', 'drive-end:2:200']);
});

test('the next reading higher is a gap of N km, lower is a mismatch of N km, equal is nothing', () => {
  assert.deepEqual(summary(deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 2)], [], FROM)), [['gap', 30]]);
  assert.deepEqual(summary(deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 120, 200, 2)], [], FROM)), [['mismatch', 30]]);
  assert.deepEqual(summary(deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 150, 200, 2)], [], FROM)), []);
  assert.equal(GAP_TOLERANCE_KM, 0, 'no tolerance: every difference is a finding');
  assert.deepEqual(summary(deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 151, 200, 2)], [], FROM)), [['gap', 1]], 'one kilometre is a finding');
});

test('a finding names both neighbours: who, when, how many km and what kind of reading', () => {
  const chain = deriveChain([drive(1, 0, 60, 100, 150, 1), drive(2, 120, 180, 180, 200, 2)], [], FROM);
  assert.equal(chain.items.length, 1);
  const [item] = chain.items as [ChainItem];
  assert.deepEqual(item.prev, { source: 'drive-end', id: 1, km: 150, at: T(60), userId: 1, userName: 'Anna', draft: false });
  assert.deepEqual(item.next, { source: 'drive-start', id: 2, km: 180, at: T(120), userId: 2, userName: 'Ben', draft: false });
  assert.equal(item.key, itemKey(item.prev, item.next));
});

test('a drive without readings is ignored, and a drive with one reading contributes that one', () => {
  // A legacy drive in the middle with no readings does not break the chain between its neighbours.
  const none = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 70, 100, null, null, 2), drive(3, 120, 180, 150, 200)], [fuel(1, 110, null)], FROM);
  assert.deepEqual(none.items, []);
  assert.deepEqual(names(none), ['drive-start:1:100', 'drive-end:1:150', 'drive-start:3:150', 'drive-end:3:200']);
  // Only a start reading, or only an end reading: that reading takes part, and nothing is its own trip.
  const startOnly = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 190, null)], [], FROM);
  assert.deepEqual(names(startOnly), ['drive-start:1:100', 'drive-end:1:150', 'drive-start:2:190']);
  assert.deepEqual(summary(startOnly), [['gap', 40]]);
  const endOnly = deriveChain([drive(1, 0, 60, null, 150), drive(2, 120, 180, 170, 200)], [], FROM);
  assert.deepEqual(names(endOnly), ['drive-end:1:150', 'drive-start:2:170', 'drive-end:2:200']);
  assert.deepEqual(summary(endOnly), [['gap', 20]]);
});

test('a drive is never a gap against itself, however long the trip', () => {
  assert.deepEqual(deriveChain([drive(1, 0, 60, 100, 9_100)], [], FROM).items, []);
});

test('an open draft takes part with its start reading only, and its placeholder end is not a reading', () => {
  const chain = deriveChain([drive(1, 0, 60, 100, 150), draft(2, 120, 200, 2)], [], FROM);
  assert.deepEqual(names(chain), ['drive-start:1:100', 'drive-end:1:150', 'draft-start:2:200']);
  assert.deepEqual(summary(chain), [['gap', 50]]);
  assert.equal(chain.items[0]?.next.draft, true, 'the later reading is marked as the start of a drive that has not ended');
  assert.equal(chain.items[0]?.prev.draft, false);
  // A reading after a draft is compared with the draft's start reading.
  const next = deriveChain([draft(1, 0, 100)], [fuel(1, 30, 130)], FROM);
  assert.deepEqual(summary(next), [['gap', 30]]);
  assert.equal(next.items[0]?.prev.source, 'draft-start');
});

test('a fill-up reading takes part in the chain, in time order', () => {
  // The pump is 10 km after the last drive ended: a gap of 10 before the fill-up, and the next drive starts where the pump was.
  const chain = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 160, 200)], [fuel(1, 90, 160, 3)], FROM);
  assert.deepEqual(summary(chain), [['gap', 10]]);
  assert.equal(chain.items[0]?.prev.source, 'drive-end');
  assert.equal(chain.items[0]?.next.source, 'fuel');
  assert.equal(chain.items[0]?.next.userName, 'Carla', 'the person of a fill-up reading is the fueler');
  // Fill-ups without a reading are not in the chain at all.
  assert.deepEqual(names(deriveChain([], [fuel(1, 0, null), fuel(2, 10, 500)], FROM)), ['fuel:2:500']);
});

test('a fill-up during a trip is not a gap against that drive, and is a mismatch only outside its readings', () => {
  const trip = [drive(1, 0, 120, 100, 160)];
  const inside = deriveChain(trip, [fuel(1, 60, 120)], FROM);
  assert.deepEqual(inside.items, [], 'inside the trip: nothing');
  assert.deepEqual(names(inside), ['drive-start:1:100', 'drive-end:1:160'], 'and it is not a link in the chain');
  assert.deepEqual(deriveChain(trip, [fuel(1, 60, 100)], FROM).items, [], 'exactly the start reading');
  assert.deepEqual(deriveChain(trip, [fuel(1, 60, 160)], FROM).items, [], 'exactly the end reading');

  const below = deriveChain(trip, [fuel(1, 60, 90)], FROM);
  assert.deepEqual(summary(below), [['mismatch', 10]]);
  assert.equal(below.items[0]?.prev.source, 'drive-start');
  assert.equal(below.items[0]?.next.source, 'fuel');
  const above = deriveChain(trip, [fuel(1, 60, 170)], FROM);
  assert.deepEqual(summary(above), [['mismatch', 10]]);
  assert.equal(above.items[0]?.prev.source, 'fuel');
  assert.equal(above.items[0]?.next.source, 'drive-end');
});

test('a fill-up at the exact start or end instant of a trip is part of the chain, not inside the trip', () => {
  // At the start instant the fill-up comes before the drive starts; at the end instant, after the drive ended.
  const atStart = deriveChain([drive(1, 0, 120, 100, 160)], [fuel(1, 0, 100)], FROM);
  assert.deepEqual(names(atStart), ['fuel:1:100', 'drive-start:1:100', 'drive-end:1:160']);
  assert.deepEqual(atStart.items, []);
  const atEnd = deriveChain([drive(1, 0, 120, 100, 160)], [fuel(1, 120, 160)], FROM);
  assert.deepEqual(names(atEnd), ['drive-start:1:100', 'drive-end:1:160', 'fuel:1:160']);
  assert.deepEqual(atEnd.items, []);
  assert.deepEqual(summary(deriveChain([drive(1, 0, 120, 100, 160)], [fuel(1, 120, 165)], FROM)), [['gap', 5]], 'after the trip a higher reading is a gap');
  assert.deepEqual(summary(deriveChain([drive(1, 0, 120, 100, 160)], [fuel(1, 0, 95)], FROM)), [['gap', 5]], 'before the trip, a lower one is a gap to its start');
});

test('a fill-up inside a drive that has only one reading is a normal link in the chain', () => {
  // The span of a legacy drive is unknown, so nothing swallows the fill-up.
  const chain = deriveChain([drive(1, 0, 120, 100, null)], [fuel(1, 60, 140)], FROM);
  assert.deepEqual(names(chain), ['drive-start:1:100', 'fuel:1:140']);
  assert.deepEqual(summary(chain), [['gap', 40]]);
});

test('back-to-back drives read end then start, whatever their ids', () => {
  // Drive 2 ends where drive 1 starts in time; the ids are the other way round on purpose.
  const first = drive(2, 0, 60, 100, 150);
  const second = drive(1, 60, 120, 150, 200, 2);
  const chain = deriveChain([second, first], [], FROM);
  assert.deepEqual(names(chain), ['drive-start:2:100', 'drive-end:2:150', 'drive-start:1:150', 'drive-end:1:200']);
  assert.deepEqual(chain.items, []);
  // With a wrong reading at the join it is flagged between exactly those two.
  const off = deriveChain([drive(2, 0, 60, 100, 150), drive(1, 60, 120, 155, 200, 2)], [], FROM);
  assert.deepEqual(summary(off), [['gap', 5]]);
  assert.deepEqual([off.items[0]?.prev.source, off.items[0]?.prev.id, off.items[0]?.next.source, off.items[0]?.next.id], ['drive-end', 2, 'drive-start', 1]);
});

test('a zero-length drive reads start then end, between the drive before and the drive after', () => {
  const chain = deriveChain([drive(3, 60, 120, 110, 160, 2), drive(2, 60, 60, 100, 110, 3), drive(1, 0, 60, 90, 100)], [], FROM);
  assert.deepEqual(names(chain), [
    'drive-start:1:90',
    'drive-end:1:100',
    'drive-start:2:100',
    'drive-end:2:110',
    'drive-start:3:110',
    'drive-end:3:160',
  ]);
  assert.deepEqual(chain.items, []);
  // A zero-length drive with equal readings is one position, and never flags itself.
  assert.deepEqual(deriveChain([drive(1, 0, 0, 100, 100)], [], FROM).items, []);
});

test('two fill-ups at the same instant are ordered by id, and a fill-up on a boundary falls between the two drives', () => {
  const same = deriveChain([], [fuel(2, 10, 120), fuel(1, 10, 110)], FROM);
  assert.deepEqual(names(same), ['fuel:1:110', 'fuel:2:120']);
  assert.deepEqual(summary(same), [['gap', 10]]);
  const boundary = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 60, 120, 150, 200, 2)], [fuel(1, 60, 150, 3)], FROM);
  assert.deepEqual(names(boundary), ['drive-start:1:100', 'drive-end:1:150', 'fuel:1:150', 'drive-start:2:150', 'drive-end:2:200']);
  assert.deepEqual(boundary.items, []);
  const off = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 60, 120, 150, 200, 2)], [fuel(1, 60, 155, 3)], FROM);
  assert.deepEqual(summary(off), [['gap', 5], ['mismatch', 5]]);
  assert.deepEqual(off.items.map((i) => [i.prev.source, i.next.source]), [['drive-end', 'fuel'], ['fuel', 'drive-start']]);
});

test('milliseconds count: a reading a millisecond later comes later', () => {
  const a = { ...drive(1, 0, 60, 100, 150), end: T(60, 1) };
  const b = drive(2, 60, 120, 150, 200, 2);
  assert.deepEqual(names(deriveChain([a, b], [], FROM)), ['drive-start:1:100', 'drive-start:2:150', 'drive-end:1:150', 'drive-end:2:200'], 'drive 2 starts before drive 1 ends');
});

// ------------------------------------------------------ window and purge boundary

test('only readings at or after the window start take part: the oldest has no predecessor', () => {
  const from = T(1000);
  // Exactly at the start is kept, a millisecond before is dropped.
  const edge = deriveChain([drive(1, 990, 1000, 100, 150), drive(2, 1000, 1010, 400, 450, 2)], [], from);
  assert.deepEqual(names(edge), ['drive-end:1:150', 'drive-start:2:400', 'drive-end:2:450'], 'the end at the cutoff is in; the start before it is out');
  assert.deepEqual(summary(edge), [['gap', 250]], 'and it is compared with its successor, there is nothing before it');
  const before = deriveChain([drive(1, 980, 999, 100, 150), drive(2, 1000, 1010, 400, 450, 2)], [fuel(1, 1010, 500)], from);
  assert.deepEqual(names(before), ['drive-start:2:400', 'drive-end:2:450', 'fuel:1:500']);
  assert.deepEqual(summary(before), [['gap', 50]], 'a drive that ended before the cutoff is not the predecessor of the first reading');
  const a = deriveChain([], [fuel(1, 1000, 100), fuel(2, 1001, 100)], from);
  const b = deriveChain([], [{ ...fuel(1, 1000, 100), at: T(1000, -1) }, fuel(2, 1001, 100)], from);
  assert.deepEqual(names(a), ['fuel:1:100', 'fuel:2:100']);
  assert.deepEqual(names(b), ['fuel:2:100'], 'one millisecond before the cutoff is out');
});

test('a drive that starts before the cutoff and ends after it keeps its end as the oldest reading', () => {
  const from = T(1000);
  const chain = deriveChain([drive(1, 900, 1100, 100, 300), drive(2, 1200, 1300, 350, 400, 2)], [], from);
  assert.deepEqual(names(chain), ['drive-end:1:300', 'drive-start:2:350', 'drive-end:2:400']);
  assert.deepEqual(summary(chain), [['gap', 50]]);
  // A fill-up inside such a trip, after the cutoff, is not checked against the start reading that dropped out.
  const inTrip = deriveChain([drive(1, 900, 1100, 100, 300)], [fuel(1, 1050, 50)], from);
  assert.deepEqual(inTrip.items, [], 'the start reading is outside the window, so the comparison with it is skipped');
  assert.deepEqual(summary(deriveChain([drive(1, 900, 1100, 100, 300)], [fuel(1, 1050, 350)], from)), [['mismatch', 50]], 'but the end reading is still there to contradict it');
});

// --------------------------------------------------------------- the dismissal key

test('the key changes when either reading changes, the driver changes, or another reading is inserted between them', () => {
  const keyOf = (drives: DriveInput[], fuels: FuelInput[] = []): string => {
    const chain = deriveChain(drives, fuels, FROM);
    assert.equal(chain.items.length, 1, 'one finding in every variant');
    return (chain.items[0] as ChainItem).key;
  };
  const base = keyOf([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 2)]);
  assert.equal(keyOf([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 2)]), base, 'the same data gives the same key');
  assert.notEqual(keyOf([drive(1, 0, 60, 100, 151), drive(2, 120, 180, 181, 200, 2)]), base, 'the earlier reading changes (and the later one with it, so the gap stays 30)');
  assert.notEqual(keyOf([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 182, 200, 2)]), base, 'the later reading changes');
  assert.notEqual(keyOf([drive(1, 0, 61, 100, 150), drive(2, 120, 180, 180, 200, 2)]), base, 'the earlier time changes');
  assert.notEqual(keyOf([drive(1, 0, 60, 100, 150), drive(2, 121, 180, 180, 200, 2)]), base, 'the later time changes');
  assert.notEqual(keyOf([drive(1, 0, 60, 100, 150, 3), drive(2, 120, 180, 180, 200, 2)]), base, 'the driver of the earlier reading changes');
  assert.notEqual(keyOf([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 3)]), base, 'the driver of the later reading changes');
  assert.notEqual(keyOf([drive(7, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 2)]), base, 'a different row');
  // The same pair but one reading is a fill-up instead of a drive: the source is part of the key.
  const asFuel = deriveChain([drive(1, 0, 60, 100, 150)], [fuel(2, 120, 180, 2)], FROM);
  assert.equal(asFuel.items.length, 1);
  assert.notEqual((asFuel.items[0] as ChainItem).key, base);
  // Another reading between them: the pair is no longer neighbours, the key of both new pairs differs.
  const between = deriveChain([drive(1, 0, 60, 100, 150), drive(2, 120, 180, 180, 200, 2)], [fuel(1, 90, 160, 3)], FROM);
  assert.deepEqual(summary(between), [['gap', 10], ['gap', 20]], 'the 30 km is now two gaps: end to fill-up (10) and fill-up to the next start (20)');
  assert.ok(between.items.every((i) => i.key !== base), 'neither of them carries the old key');
});

// ------------------------------------------------------------ property: order and shifts

/** A small seeded random generator (mulberry32): the same seed always makes the same household. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Built {
  drives: DriveInput[];
  fuels: FuelInput[];
  /** Index, in the event list, of every event; used to shift everything after one. */
  events: Array<{ kind: 'drive' | 'fuel'; id: number }>;
}

/**
 * A consistent household: events in time order on one odometer, so that every reading follows on from the
 * one before. Includes back-to-back drives, zero-length drives, a fill-up at a boundary and a fill-up in a
 * trip. `shiftAt` makes the event with that index start `shift` km further on (or back), as if km went
 * unregistered (or a reading was mistyped) just before it; everything after follows on from the shifted one.
 */
function build(seed: number, shiftAt = -1, shift = 0): Built {
  const rand = rng(seed);
  const pick = (n: number): number => Math.floor(rand() * n);
  const drives: DriveInput[] = [];
  const fuels: FuelInput[] = [];
  const events: Built['events'] = [];
  let minute = 1000;
  let pos = 500_000;
  let previous: 'drive' | 'fuel' | 'none' = 'none';
  const count = 3 + pick(8);
  for (let i = 0; i < count; i++) {
    const userId = 1 + pick(3);
    // The shift is added once, at one event: every later reading follows on from the shifted one.
    const add = i === shiftAt ? shift : 0;
    const isFuel = pick(3) === 0;
    // How long since the previous event: 0 means the same minute (back-to-back, or a fill-up on a boundary).
    let wait = [0, 0, 1, 5, 90][pick(5)] as number;
    if (isFuel) {
      if (wait === 0 && previous === 'none') wait = 1;
      minute += wait;
      pos += add;
      fuels.push({ id: fuels.length + 1, userId, userName: name(userId), at: T(minute), odometer: pos });
      events.push({ kind: 'fuel', id: fuels.length });
      previous = 'fuel';
      // Never two events at one instant after a fill-up unless it is the next drive's start (below): move on.
      continue;
    }
    const zero = pick(6) === 0;
    // A fill-up and a zero-length drive at one instant would be ambiguous (the fill-up ranks after the drive), so keep them apart.
    if (zero && previous === 'fuel' && wait === 0) wait = 1;
    minute += wait;
    pos += add;
    const length = zero ? 0 : 1 + pick(120);
    const km = pick(200);
    const inTrip = !zero && length > 2 && pick(3) === 0;
    const start = pos;
    pos += km;
    drives.push({ id: drives.length + 1, userId, userName: name(userId), start: T(minute), end: T(minute + length), odometerStart: start, odometerEnd: pos, draft: false });
    events.push({ kind: 'drive', id: drives.length });
    if (inTrip) {
      // A pump stop strictly inside the trip with a reading somewhere in the trip's own range.
      fuels.push({ id: fuels.length + 1, userId, userName: name(userId), at: T(minute + 1 + pick(length - 1)), odometer: start + pick(km + 1) });
    }
    minute += length;
    previous = 'drive';
  }
  return { drives, fuels, events };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

test('property: a consistent household has no findings, in any input order (200 seeded households)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const h = build(seed);
    const rand = rng(seed * 7919);
    const ordered = deriveChain(h.drives, h.fuels, FROM);
    assert.deepEqual(ordered.items, [], `seed ${seed}: nothing is flagged in a consistent household`);
    const mixed = deriveChain(shuffled(h.drives, rand), shuffled(h.fuels, rand), FROM);
    assert.deepEqual(mixed, ordered, `seed ${seed}: the input order does not change the result`);
  }
});

test('property: shifting every reading after one point by N km gives exactly one finding of N km (200 seeded households)', () => {
  let checked = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const plain = build(seed);
    if (plain.events.length < 2) continue;
    const rand = rng(seed * 104729);
    const at = 1 + Math.floor(rand() * (plain.events.length - 1));
    for (const shift of [37, -23]) {
      const h = build(seed, at, shift);
      const chain = deriveChain(shuffled(h.drives, rand), shuffled(h.fuels, rand), FROM);
      assert.equal(chain.items.length, 1, `seed ${seed}, shift ${shift}: exactly one finding, got ${JSON.stringify(summary(chain))}`);
      assert.deepEqual(summary(chain), [[shift > 0 ? 'gap' : 'mismatch', Math.abs(shift)]], `seed ${seed}, shift ${shift}`);
      checked++;
    }
  }
  assert.ok(checked > 300, `enough households were checked (${checked})`);
});

// ------------------------------------------------ property: window, purge and the stored explanations

/** Every instant in a household, plus a millisecond either side of each: the places a window edge can go wrong. */
function edges(h: Built): string[] {
  const out: string[] = [];
  for (const d of h.drives) for (const iso of [d.start, d.end]) out.push(iso, new Date(Date.parse(iso) - 1).toISOString(), new Date(Date.parse(iso) + 1).toISOString());
  for (const f of h.fuels) out.push(f.at, new Date(Date.parse(f.at) - 1).toISOString(), new Date(Date.parse(f.at) + 1).toISOString());
  return out;
}

test('property: the chain does not depend on whether the purge has run, wherever the window starts (200 seeded households, shifted and consistent)', () => {
  let cutsInside = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed * 15485863);
    // Half of the households have one reading shifted, so there is something to flag; the rest are consistent.
    const plain = build(seed);
    const h = seed % 2 === 0 && plain.events.length >= 2 ? build(seed, 1 + Math.floor(rand() * (plain.events.length - 1)), 41) : plain;
    // A forgotten draft at the end: the purge keeps it by its placeholder end, which is its start.
    const lastEnd = Math.max(...h.drives.map((d) => Date.parse(d.end)), ...h.fuels.map((f) => Date.parse(f.at)));
    const withDraft = seed % 3 === 0 ? [...h.drives, { ...draft(h.drives.length + 1, 0, 600_000 + seed, 2), start: new Date(lastEnd + 60_000).toISOString(), end: new Date(lastEnd + 60_000).toISOString() }] : h.drives;
    for (const from of edges(h)) {
      // What the purge keeps (retention.ts): rows that ended at or after the cutoff, fill-ups at or after it.
      const keptDrives = withDraft.filter((d) => d.end >= from);
      const keptFuels = h.fuels.filter((f) => f.at >= from);
      const full = deriveChain(withDraft, h.fuels, from);
      const purged = deriveChain(keptDrives, keptFuels, from);
      assert.deepEqual(purged, full, `seed ${seed}, window from ${from}: derive, purge, derive again gives the same chain`);
      // The purge deletes explanations whose earlier reading is before the cutoff: none of them can still apply.
      for (const item of full.items) assert.ok(item.prev.at >= from, `seed ${seed}: a finding never starts before the window (${item.prev.at} < ${from})`);
      for (const r of full.readings) assert.ok(r.at >= from, `seed ${seed}: no reading before the window takes part`);
      if (from > T(1000) && full.readings.length > 0) cutsInside++;
    }
  }
  assert.ok(cutsInside > 500, `the window edge really cut through households (${cutsInside} cuts)`);
});

test('a fill-up in a trip that began exactly at the window start is still checked against the start reading, one a millisecond earlier is not', () => {
  const from = T(1000);
  const trip = (startAt: string): DriveInput => ({ ...drive(1, 0, 1100, 100, 300), start: startAt });
  // The pump reads 50 km, under the start reading of 100.
  const atEdge = deriveChain([trip(from)], [fuel(1, 1050, 50)], from);
  assert.deepEqual(summary(atEdge), [['mismatch', 50]], 'the start reading is exactly at the window start: it takes part');
  assert.equal(atEdge.items[0]?.prev.source, 'drive-start');
  const before = deriveChain([trip(T(1000, -1))], [fuel(1, 1050, 50)], from);
  assert.deepEqual(before.items, [], 'one millisecond before the window start: the comparison is skipped');
});
