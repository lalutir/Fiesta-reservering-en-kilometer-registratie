// The Statistics screen (public/views/stats.js) on the fake DOM and a stubbed API: the address that holds the choice, the
// series it draws, the SVG of a chart (built with createElementNS, patterns and words besides colour), the table beside
// it, the controls, the honest states (provisional, incomplete, unknown, empty) and what a failing request does. The
// server's numbers are in test/stats.test.ts; here they are fixtures, and the view must write them and not recompute them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { S } from '../public/strings.js';
import { DEFAULT_PERIOD, METRICS, PERIODS, chart, readState, render as renderStats, seriesOf, statsHash, summaryOf } from '../public/views/stats.js';
import { ADMIN, ANNA, BEN, NOW, all, makeApp, one, refuse, withClient, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '..');
const metric = (id: string) => METRICS.find((m) => m.id === id) as (typeof METRICS)[number];

// ---------------------------------------------------------------------- fixtures

const ZERO: Json = {
  trips: 0,
  km: 0,
  togetherKm: 0,
  fillUps: 0,
  millilitres: 0,
  paidCents: 0,
  shareCents: 0,
  costCents: 0,
  costKm: 0,
  poolKm: 0,
  consumptionMl: 0,
  consumptionKm: 0,
  tickets: 0,
  ticketCents: 0,
  damageReports: 0,
  unaccountedKm: 0,
  totalKm: 0,
  pricePerLitreMillis: null,
  costPerKmMillis: null,
  consumptionHundredths: null,
};
const entry = (over: Json = {}): Json => ({ ...ZERO, ...over });

/** The n months that end in the current one (2026-06), oldest first. */
function monthsBack(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const index = 2026 * 12 + 5 - (n - 1 - i);
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  });
}

const monthDto = (month: string, over: Json = {}): Json => ({ month, provisional: month === '2026-06', frozen: false, incomplete: false, unavailable: false, household: entry(), people: [], ...over });

const USERS = [
  { id: 1, name: 'Anna', active: true },
  { id: 2, name: 'Ben', active: true },
  { id: 3, name: 'Cor', active: false },
];

/** A report of `n` months in which every month is built by `per`. */
function report(n: number, per: (month: string, index: number) => Json = () => ({}), over: Json = {}): Json {
  const months = monthsBack(n);
  return { version: 1, timeZone: 'Europe/Amsterdam', windowMonths: 6, retentionMonths: 24, current: '2026-06', range: { from: months[0], to: months[n - 1] }, users: USERS, months: months.map((m, i) => monthDto(m, per(m, i))), ...over };
}

/** A household with something in every month: kilometres (some together), litres, euros, a ratio, a ticket, a report. */
const busy = (month: string, i: number): Json => ({
  household: entry({ trips: 3 + i, km: 100 + 10 * i, togetherKm: i % 2 === 0 ? 20 : 0, millilitres: 40_000, paidCents: 7_500, shareCents: 7_500, pricePerLitreMillis: 1_875, costPerKmMillis: 120, consumptionHundredths: 650, tickets: i === 2 ? 1 : 0, ticketCents: i === 2 ? 9_000 : 0, damageReports: i === 1 ? 1 : 0, unaccountedKm: i === 3 ? 12 : 0 }),
  people: [
    { userId: 1, ...entry({ trips: 2 + i, km: 60 + 10 * i, millilitres: 40_000, paidCents: 7_500, shareCents: 4_000, pricePerLitreMillis: 1_875, costPerKmMillis: 130 }) },
    { userId: 2, ...entry({ trips: 1, km: 40, shareCents: 3_500 }) },
  ],
});

/** GET /api/stats answered with `make(query)`; every call is kept in api.calls. */
const statsRoute = (make: (query: string) => Json | ReturnType<typeof refuse>): Routes => ({ 'GET /api/stats': (call) => make(call.query) });

const statsCalls = (api: { calls: Array<{ path: string; query: string }> }): string[] => api.calls.filter((c) => c.path === '/api/stats').map((c) => c.query);

// ------------------------------------------------------------------ the address

test('readState: the period and the person come from the address, and anything else falls back to the default', () => {
  const q = (s: string) => readState(new URLSearchParams(s));
  assert.deepEqual(q(''), { months: 12, who: 'household' });
  assert.deepEqual(q('months=6&who=3'), { months: 6, who: '3' });
  assert.deepEqual(q('months=24&who=household'), { months: 24, who: 'household' });
  for (const bad of ['months=7', 'months=abc', 'months=', 'months=-6', 'months=0']) assert.equal(q(bad).months, DEFAULT_PERIOD, bad);
  for (const bad of ['who=0', 'who=-1', 'who=1.5', 'who=abc', 'who=1;drop', 'who=01', 'who=12345678901']) assert.equal(q(bad).who, 'household', bad);
  assert.deepEqual(PERIODS, [6, 12, 24]);
});

test('statsHash: the default is the bare route, everything else says what it is', () => {
  assert.equal(statsHash({ months: 12, who: 'household' }), '#/stats');
  assert.equal(statsHash({ months: 24, who: 'household' }), '#/stats?months=24&who=household');
  assert.equal(statsHash({ months: 12, who: '2' }), '#/stats?months=12&who=2');
  // What a hash says reads back to the same state.
  for (const state of [{ months: 6, who: 'household' }, { months: 24, who: '7' }, { months: 12, who: '3' }]) {
    assert.deepEqual(readState(new URLSearchParams(statsHash(state).split('?')[1] ?? '')), state);
  }
});

// ------------------------------------------------------------------ the series

test('seriesOf: the household takes the household numbers, a person takes theirs, and a quiet person is zero where a ratio is unknown', () => {
  const r = report(3, (m, i) => (m === '2026-05' ? { unavailable: true, household: null, people: [] } : busy(m, i))) as never;
  const km = metric('km');
  const house = seriesOf(r, km, 'household');
  assert.deepEqual(house.map((p) => [p.month, p.value, p.together]), [['2026-04', 100, 20], ['2026-05', null, null], ['2026-06', 120, 20]], 'together km only for the household; an unavailable month is unknown');
  assert.deepEqual(seriesOf(r, km, '1').map((p) => [p.value, p.together]), [[60, null], [null, null], [80, null]], 'a person has no "together" part');
  // Ben has nothing at all in June of a report that does not list him: zero kilometres, no price.
  const noOne = report(1, () => ({ household: entry({ km: 5 }), people: [{ userId: 1, ...entry({ km: 5 }) }] })) as never;
  assert.equal(seriesOf(noOne, km, '2')[0]?.value, 0);
  assert.equal(seriesOf(noOne, metric('price'), '2')[0]?.value, null, 'a ratio of nothing is unknown, not zero');
  assert.equal(seriesOf(noOne, metric('trips'), 'household')[0]?.value, 0);
  // The state of the month rides along on every point.
  const flagged = report(2, (m) => (m === '2026-05' ? { frozen: true, incomplete: true } : {})) as never;
  assert.deepEqual(seriesOf(flagged, km, 'household').map((p) => [p.provisional, p.frozen, p.incomplete, p.unavailable]), [[false, true, true, false], [true, false, false, false]]);
});

test('every metric reads a field the server really sends (the field list of docs/STATS-API.md)', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'STATS-API.md'), 'utf8');
  const sample = entry();
  assert.equal(METRICS.length, 12);
  for (const m of METRICS) assert.ok(m.value(sample as never) !== undefined, `${m.id} reads a field that is not in the entry`);
  for (const field of Object.keys(ZERO)) assert.ok(doc.includes(`\`${field}\``), `${field} is not in docs/STATS-API.md`);
});

test('summaryOf: the latest month and the highest one, one sentence when they are the same month, a plain sentence when there is nothing', () => {
  const km = metric('km');
  const r = report(4, (m, i) => ({ household: entry({ km: [50, 200, 90, 70][i], togetherKm: i === 3 ? 30 : 0 }) })) as never;
  const text = summaryOf(km, seriesOf(r, km, 'household'));
  assert.match(text, /Laatste maand, juni 2026: 70 km, plus 30 km samen\./);
  assert.match(text, /Hoogste maand, april 2026: 200 km\./);
  const up = report(3, (m, i) => ({ household: entry({ km: [10, 20, 30][i] }) })) as never;
  assert.equal(summaryOf(km, seriesOf(up, km, 'household')), 'Laatste en hoogste maand, juni 2026: 30 km.');
  // Zero is a value: the latest month is known and quiet. Only a series with nothing known and nothing above zero has no sentence.
  assert.equal(summaryOf(km, seriesOf(report(3) as never, km, 'household')), 'Laatste maand, juni 2026: 0 km.');
  const unknown = report(3, () => ({ unavailable: true, household: null })) as never;
  assert.equal(summaryOf(km, seriesOf(unknown, km, 'household')), S.stats.chart.none);
  // The latest month is unknown: only the highest is named.
  const gap = report(3, (m, i) => (i === 2 ? { unavailable: true, household: null } : { household: entry({ km: [10, 40, 0][i] }) })) as never;
  assert.equal(summaryOf(km, seriesOf(gap, km, 'household')), 'Hoogste maand, mei 2026: 40 km.');
});

// ------------------------------------------------------------------ one chart

const svgOf = (fig: FakeElement): FakeElement => one(fig, 'svg.chart-svg');

test('a chart is a figure with a title, a sentence and an SVG that names itself through them, and a table with the same numbers', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const km = metric('km');
    const r = report(6, busy) as never;
    const fig = dom.mount(chart(km, seriesOf(r, km, 'household')));
    assert.equal(fig.tagName, 'figure');
    const title = one(fig, 'h4');
    const summary = one(fig, 'p.chart-summary');
    const sheet = svgOf(fig);
    assert.equal(title.textContent, S.stats.metrics.km);
    assert.equal(sheet.getAttribute('role'), 'img');
    assert.equal(sheet.getAttribute('aria-labelledby'), title.id);
    assert.equal(sheet.getAttribute('aria-describedby'), summary.id);
    assert.ok(title.id !== '' && summary.id !== '' && title.id !== summary.id);
    assert.ok(summary.textContent.length > 20, 'a sentence, not just a number');
    assert.equal(sheet.namespaceURI, 'http://www.w3.org/2000/svg', 'drawn with createElementNS');
    assert.ok(sheet.descendants().every((e) => e.namespaceURI === 'http://www.w3.org/2000/svg'), 'every part of the sheet is SVG');
    assert.equal(sheet.getAttribute('viewBox'), '0 0 320 172', 'it scales with its box');

    // The table beside it: one row per month, newest first, with the state in words.
    const rows = all(fig, 'tbody tr');
    assert.deepEqual(rows.map((r) => r.getAttribute('data-month')), ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01']);
    assert.equal(all(fig, 'th[scope="col"]').length, 4, 'month, kilometres, together, status');
    assert.deepEqual(all(rows[0] as FakeElement, 'td').map((c) => c.textContent), ['150 km', '0 km', 'Voorlopig'], 'the current month: 150 own kilometres, none together');
    assert.deepEqual(all(rows[1] as FakeElement, 'td').map((c) => c.textContent), ['140 km', '20 km', 'Berekend'], 'a month that is neither stored nor current is worked out');
    assert.equal(all(fig, 'caption')[0]?.textContent, S.stats.chart.caption(S.stats.metrics.km));
    assert.ok(one(fig, 'details.chart-details'), 'the table is one tap away');
  });
});

test('bars: one month one group; a bar that is not final is hatched, together kilometres are dotted, an unknown month is a dash', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const km = metric('km');
    const r = report(6, (m) => {
      if (m === '2026-02') return { unavailable: true, household: null };
      if (m === '2026-03') return { incomplete: true, frozen: true, household: entry({ km: 50 }) };
      return { household: entry({ km: 100, togetherKm: m === '2026-04' ? 40 : 0 }) };
    }) as never;
    const sheet = svgOf(dom.mount(chart(km, seriesOf(r, km, 'household'))));
    const month = (m: string): FakeElement => one(sheet, `g[data-month="${m}"]`);
    assert.equal(all(sheet, 'g.chart-month').length, 6);
    // Solid: complete months. Hatched: incomplete and the current (provisional) month. A pattern, so the cue is not the colour.
    assert.equal(all(month('2026-01'), 'rect.chart-bar').length, 1);
    assert.equal(all(month('2026-03'), 'rect.chart-bar').length, 0);
    assert.equal(one(month('2026-03'), 'rect.chart-bar-hatched').getAttribute('fill'), 'url(#stats-hatch)');
    assert.equal(one(month('2026-06'), 'rect.chart-bar-hatched').getAttribute('fill'), 'url(#stats-hatch)', 'the current month is provisional');
    // The together part is a second, dotted rectangle on top of the bar.
    const stacked = one(month('2026-04'), 'rect.chart-bar-dotted');
    assert.equal(stacked.getAttribute('fill'), 'url(#stats-dots)');
    assert.ok(Number(stacked.getAttribute('y')) < Number(one(month('2026-04'), 'rect.chart-bar').getAttribute('y')), 'above the bar');
    assert.equal(all(month('2026-05'), 'rect.chart-bar-dotted').length, 0);
    // An unknown month has no bar at all, only a dash.
    assert.equal(all(month('2026-02'), 'rect').length, 0);
    assert.equal(all(month('2026-02'), 'line.chart-gap').length, 1);
    // The highest bar fills the plot, the others are scaled to it (the one calculation of the screen).
    const heights = ['2026-01', '2026-03'].map((m) => Number(one(month(m), 'rect').getAttribute('height')));
    assert.ok((heights[0] as number) > (heights[1] as number) && (heights[1] as number) > 0);
    // No style attribute anywhere on the sheet: the CSP forbids it.
    assert.ok(sheet.descendants().every((e) => !e.hasAttribute('style')));
  });
});

test('bar height: a value above zero is always visible, a zero has no bar, and nothing leaves the plot', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const trips = metric('trips');
    const r = report(3, (m, i) => ({ household: entry({ trips: [0, 1, 100_000][i] }) })) as never;
    const sheet = svgOf(dom.mount(chart(trips, seriesOf(r, trips, 'household'))));
    const bar = (m: string): FakeElement | undefined => all(sheet, `g[data-month="${m}"] rect`)[0];
    assert.equal(bar('2026-04'), undefined, 'zero: no bar');
    assert.equal(Number(bar('2026-05')?.getAttribute('height')), 2, 'one against a hundred thousand is still two units high');
    const tall = Number(bar('2026-06')?.getAttribute('height'));
    assert.ok(tall > 0 && tall <= 118, `inside the plot: ${tall}`);
    for (const e of all(sheet, 'rect')) assert.ok(Number(e.getAttribute('y')) >= 24 && Number(e.getAttribute('y')) + Number(e.getAttribute('height')) <= 142 + 0.001);
  });
});

test('value labels: every bar of a short period, only the latest and the highest of a long one; month labels thin out but always name the latest', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const km = metric('km');
    const labelsOf = (n: number, per = busy): { values: string[]; axis: string[]; sheet: FakeElement } => {
      const r = report(n, per) as never;
      const sheet = svgOf(dom.mount(chart(km, seriesOf(r, km, 'household'))));
      return { values: all(sheet, 'text.chart-value').map((t) => t.textContent), axis: all(sheet, 'text.chart-axis').map((t) => t.textContent), sheet };
    };
    const six = labelsOf(6);
    assert.equal(six.values.length, 6, 'all six');
    assert.deepEqual(six.axis, ['jan 26', 'feb 26', 'mrt 26', 'apr 26', 'mei 26', 'jun 26']);
    assert.deepEqual(six.values, ['100+20', '110', '120+20', '130', '140+20', '150'], 'the number alone, the part driven together after a plus');
    const peak = (m: string, i: number): Json => ({ household: entry({ km: i === 3 ? 500 : 100 }) });
    const twelve = labelsOf(12, peak);
    assert.equal(twelve.values.length, 2, 'the latest and the highest, which sit a few months apart');
    assert.equal(twelve.axis.length, 6, 'every second month');
    assert.equal(twelve.axis[twelve.axis.length - 1], 'jun 26', 'the latest month is always labelled');
    const day = labelsOf(24, peak);
    assert.equal(day.values.length, 2);
    assert.equal(day.axis.length, 6, 'every fourth month');
    assert.equal(day.axis[day.axis.length - 1], 'jun 26');
    // A bar next to the highest one does not get a second label on top of it: the highest is the latest here.
    const rising = labelsOf(12, (m, i) => ({ household: entry({ km: 10 * (i + 1) }) }));
    assert.equal(rising.values.length, 1, 'the latest month is the highest: one label');
    // Labels near the edges are anchored inward, so they never leave the sheet.
    const anchors = all(six.sheet, 'text').map((t) => t.getAttribute('text-anchor'));
    assert.ok(anchors.includes('start') && anchors.includes('end') && anchors.includes('middle'));
  });
});

test('the table says the state of every month in words, so the look of a bar is never the only cue', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const trips = metric('trips');
    const r = report(4, (m) => {
      if (m === '2026-03') return { unavailable: true, household: null };
      if (m === '2026-04') return { frozen: true, incomplete: true, household: entry({ trips: 2 }) };
      if (m === '2026-05') return { frozen: true, household: entry({ trips: 1 }) };
      return { household: entry({ trips: 4 }) };
    }) as never;
    const fig = dom.mount(chart(trips, seriesOf(r, trips, 'household')));
    const rows = all(fig, 'tbody tr').map((row) => [row.getAttribute('data-month'), ...all(row, 'td').map((c) => c.textContent)]);
    assert.deepEqual(rows, [
      ['2026-06', '4 ritten', 'Voorlopig'],
      ['2026-05', '1 rit', 'Vastgelegd'],
      ['2026-04', '2 ritten', 'Vastgelegd (onvolledig)'],
      ['2026-03', 'onbekend', 'Onbekend'],
    ]);
    assert.deepEqual(all(fig, 'tbody th').map((c) => c.textContent), ['juni 2026', 'mei 2026', 'april 2026', 'maart 2026']);
  });
});

test('units: every metric writes its number the Dutch way (decimal comma, thousands dot, euro sign), in the text and the table', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const r = report(1, () => ({ household: entry({ trips: 1, km: 45_210, togetherKm: 0, millilitres: 40_500, paidCents: 123_456, shareCents: 5, pricePerLitreMillis: 1_859, costPerKmMillis: 120, consumptionHundredths: 650, tickets: 2, ticketCents: 9_000, damageReports: 1, unaccountedKm: 12 }) })) as never;
    const text = (id: string): string => summaryOf(metric(id), seriesOf(r, metric(id), 'household'));
    assert.match(text('km'), /45\.210 km/);
    assert.match(text('litres'), /40,50 L/);
    assert.match(text('paid'), /€\s1\.234,56/);
    assert.match(text('share'), /€\s0,05/);
    assert.match(text('price'), /€\s1,859 per liter/);
    assert.match(text('costPerKm'), /€\s0,120 per km/);
    assert.match(text('consumption'), /6,50 L per 100 km/);
    assert.match(text('tickets'), /2 verkeersboetes/);
    assert.match(text('ticketCents'), /€\s90,00/);
    assert.match(text('damage'), /1 schademelding\./);
    assert.match(text('unaccounted'), /12 km/);
    // On the bar the unit is left out: the title says it.
    const sheet = svgOf(dom.mount(chart(metric('paid'), seriesOf(r, metric('paid'), 'household'))));
    assert.deepEqual(all(sheet, 'text.chart-value').map((t) => t.textContent), ['1.234,56']);
    assert.match(S.stats.metrics.paid, /€/);
  });
});

test('the consumption chart says what it assumes: a full tank at every fill-up', async () => {
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const consumption = metric('consumption');
    const fig = dom.mount(chart(consumption, seriesOf(report(2, busy) as never, consumption, 'household')));
    assert.ok(all(fig, 'p.hint').some((p) => p.textContent === S.stats.consumptionNote && /vol tankt/.test(p.textContent)));
    const km = dom.mount(chart(metric('km'), seriesOf(report(2, busy) as never, metric('km'), 'household')));
    assert.equal(all(km, 'p.hint').length, 0, 'only the chart that needs the sentence has it');
  });
});

// ------------------------------------------------------------------ the screen

const mount = async (dom: { mount: (el: unknown) => FakeElement }, me = makeApp(ANNA), query = '') => dom.mount(await renderStats(me.app, { query: new URLSearchParams(query) }));

test('the default screen asks for the default range, draws one chart per metric in three groups, and explains how to read them', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom, api }) => {
    const page = await mount(dom);
    assert.deepEqual(statsCalls(api), [''], 'no from or to: the server picks the last twelve months');
    assert.equal(one(page, 'h2').textContent, 'Statistieken');
    assert.deepEqual(all(page, 'figure.chart').map((f) => f.getAttribute('data-chart')), METRICS.map((m) => m.id));
    assert.deepEqual(all(page, 'section.chart-group h3').map((h3) => h3.textContent), ['Ritten en kilometers', 'Brandstof', 'Verkeersboetes en schade']);
    assert.equal(all(page, 'section.chart-group').map((g) => all(g, 'figure.chart').length).join(','), '3,6,3');
    // The patterns the bars refer to exist once, in a box that is not hidden.
    const defs = one(page, 'svg.chart-defs');
    assert.deepEqual(all(defs, 'pattern').map((p) => p.id), ['stats-hatch', 'stats-dots']);
    assert.equal(defs.getAttribute('aria-hidden'), 'true');
    assert.equal(all(page, '[hidden]').filter((e) => e.classList.contains('chart-defs')).length, 0);
    // The legend names every cue, and the sentence about stored months is there.
    const legend = all(page, 'ul.chart-legend li').map((li) => li.textContent);
    assert.equal(legend.length, 5);
    assert.ok(legend.some((t) => /Gestreepte staaf/.test(t)) && legend.some((t) => /Gestippeld/.test(t)) && legend.some((t) => /verandert niet meer/.test(t)));
    assert.equal(all(page, 'ul.chart-legend svg.chart-swatch').length, 4, 'a sample of each bar, drawn with the same classes');
    // The household has no person hint.
    assert.ok(!all(page, 'p.hint').some((p) => p.textContent === S.stats.householdOnly));
  });
});

test('the period: six, twelve and twenty-four months, pressed by the address; the others ask for a month to start from', async () => {
  const route = statsRoute((query) => report(query.includes('from=2026-01') ? 6 : query.includes('from=2024-07') ? 24 : 12, busy));
  await withClient({ now: NOW, routes: route }, async ({ dom, api }) => {
    const pressed = (page: FakeElement): string[] => all(page, 'button.seg').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    assert.deepEqual(pressed(await mount(dom)), ['12 mnd']);
    dom.body.replaceChildren();
    const six = await mount(dom, makeApp(ANNA), 'months=6');
    assert.deepEqual(pressed(six), ['6 mnd']);
    assert.equal(all(six, 'g.chart-month').length / 12, 6, 'six months of bars in each of the twelve charts');
    dom.body.replaceChildren();
    const long = await mount(dom, makeApp(ANNA), 'months=24');
    assert.deepEqual(pressed(long), ['24 mnd']);
    assert.equal(all(long, 'figure.chart')[0] && all(all(long, 'figure.chart')[0] as FakeElement, 'tbody tr').length, 24);
    assert.deepEqual(statsCalls(api), ['', 'from=2026-01', 'from=2024-07'], 'six months from January, twenty-four from July two years back: the current month counts');
    // The names say what the short labels mean.
    assert.deepEqual(all(long, 'button.seg').map((b) => b.getAttribute('aria-label')), ['6 maanden', '12 maanden', '24 maanden']);
  });
});

test('pressing a period or choosing a person changes the address and nothing else', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const page = await mount(dom, me);
    const buttons = all(page, 'button.seg');
    await (buttons[2] as FakeElement).fire('click');
    await (buttons[2] as FakeElement).fire('click'); // pressing the pressed one again does nothing
    await (buttons[0] as FakeElement).fire('click');
    const select = one(page, 'select');
    select.value = '2';
    await select.fire('change');
    assert.deepEqual(me.navigated, ['#/stats?months=24&who=household', '#/stats?months=6&who=household', '#/stats?months=12&who=2']);
    assert.deepEqual(api.writes(), [], 'reading statistics writes nothing');
  });
});

test('a person: every user is in the list (a deactivated one is marked), household-only metrics are left out and say why', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom }) => {
    const page = await mount(dom, makeApp(ANNA), 'who=2');
    const select = one(page, 'select');
    assert.equal(select.value, '2');
    assert.deepEqual(all(select, 'option').map((o) => [o.value, o.textContent]), [['household', 'Hele huishouden'], ['1', 'Anna'], ['2', 'Ben'], ['3', 'Cor (niet actief)']]);
    assert.equal(one(page, 'label').getAttribute('for'), select.id, 'the select has its label');
    const shown = all(page, 'figure.chart').map((f) => f.getAttribute('data-chart'));
    assert.deepEqual(shown, METRICS.filter((m) => !m.householdOnly).map((m) => m.id));
    assert.ok(!shown.includes('consumption') && !shown.includes('unaccounted'));
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.stats.householdOnly));
    // Ben's numbers, not the household's: 40 km a month, and no together part.
    const km = one(page, 'figure[data-chart="km"]');
    assert.match(one(km, 'p.chart-summary').textContent, /40 km/);
    assert.equal(all(km, 'rect.chart-bar-dotted').length, 0);
    // A person that is not in the report is the household again, never a broken screen.
    dom.body.replaceChildren();
    const unknown = await mount(dom, makeApp(ANNA), 'who=99');
    assert.equal(one(unknown, 'select').value, 'household');
    assert.equal(all(unknown, 'figure.chart').length, 12);
  });
});

test('the months that are not plain numbers are named: the current one is provisional, some are incomplete, some are unknown', async () => {
  const r = report(12, (m, i) => {
    if (m === '2025-07' || m === '2025-08') return { unavailable: true, household: null };
    if (m === '2025-11') return { frozen: true, incomplete: true, household: entry({ km: 30 }) };
    return busy(m, i);
  });
  await withClient({ now: NOW, routes: statsRoute(() => r) }, async ({ dom }) => {
    const page = await mount(dom);
    const notes = all(one(page, 'section.stats-notes'), 'p.hint').map((p) => p.textContent);
    assert.deepEqual(notes, [
      'juni 2026 loopt nog: de getallen van die maand zijn voorlopig en veranderen nog.',
      'Onvolledig: november 2025. Een deel van de gegevens van deze maanden was al verwijderd voordat het maandtotaal werd vastgelegd, dus de getallen kunnen te laag zijn.',
      'Onbekend: juli 2025, augustus 2025. Daar zijn geen gegevens van.',
    ]);
    // An unknown month is a dash in every one of the twelve charts (24), and the three ratio charts have one more for the month
    // that has kilometres and nothing to divide them by (3).
    assert.equal(all(page, 'figure.chart').flatMap((f) => all(f, 'line.chart-gap')).length, 12 * 2 + 3);
    const first = one(page, 'figure[data-chart="trips"]');
    assert.ok(all(first, 'tbody tr').some((row) => row.getAttribute('data-month') === '2025-07' && all(row, 'td').map((c) => c.textContent).join('|') === 'onbekend|Onbekend'));
  });
});

test('a quiet screen says so: nothing to count (household), or nothing for this person, and the controls stay', async () => {
  const quiet = report(12, () => ({}));
  await withClient({ now: NOW, routes: statsRoute(() => quiet) }, async ({ dom }) => {
    const page = await mount(dom);
    assert.equal(all(page, 'figure.chart').length, 0);
    assert.equal(one(page, '.empty strong').textContent, S.stats.empty.title);
    assert.ok(one(page, '.stats-controls select') && all(page, 'button.seg').length === 3, 'the person and the period can still be changed');
    dom.body.replaceChildren();
    const person = await mount(dom, makeApp(ANNA), 'who=1');
    assert.equal(one(person, '.empty strong').textContent, S.stats.emptyPerson.title);
  });
  // A household with something, but not for this person: the person's screen is the quiet one.
  const onlyAnna = report(12, () => ({ household: entry({ km: 50 }), people: [{ userId: 1, ...entry({ km: 50 }) }] }));
  await withClient({ now: NOW, routes: statsRoute(() => onlyAnna) }, async ({ dom }) => {
    assert.equal(all(await mount(dom, makeApp(ANNA), 'who=2'), 'figure.chart').length, 0);
    dom.body.replaceChildren();
    assert.ok(all(await mount(dom, makeApp(ANNA), 'who=1'), 'figure.chart').length > 0);
  });
});

test('the periods on offer follow what the server keeps: with 12 months kept there is no 24, and a request for it shows 12', async () => {
  const route = statsRoute((query) => (query.includes('from=') ? refuse(422, 'validation_failed', { fields: { from: 'outside_retention' } }) : report(12, busy, { retentionMonths: 12 })));
  await withClient({ now: NOW, routes: route }, async ({ dom, api }) => {
    const page = await mount(dom, makeApp(ANNA), 'months=24');
    assert.deepEqual(statsCalls(api), ['from=2024-07', ''], 'the refused month is not an error screen: the default range is shown');
    assert.deepEqual(all(page, 'button.seg').map((b) => b.textContent), ['6 mnd', '12 mnd']);
    assert.deepEqual(all(page, 'button.seg').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent), ['12 mnd']);
  });
});

test('a failing request is an error for the shell to show with its retry button, never a half-drawn screen', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => refuse(500, 'internal')) }, async () => {
    await assert.rejects(() => renderStats(makeApp(ANNA).app, { query: new URLSearchParams('') }), (err: Json) => err.status === 500 && err.code === 'internal');
  });
  // A 422 on the default range has nothing to fall back to: it is an error too.
  await withClient({ now: NOW, routes: statsRoute(() => refuse(422, 'validation_failed')) }, async () => {
    await assert.rejects(() => renderStats(makeApp(ANNA).app, { query: new URLSearchParams('months=6') }), (err: Json) => err.status === 422);
  });
});

test('everyone sees the same screen: an admin and a member get the same charts', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom }) => {
    const member = (await mount(dom, makeApp(ANNA))).querySelectorAll('figure.chart').map((f) => f.getAttribute('data-chart'));
    dom.body.replaceChildren();
    const admin = (await mount(dom, makeApp(ADMIN))).querySelectorAll('figure.chart').map((f) => f.getAttribute('data-chart'));
    assert.deepEqual(member, admin);
    assert.ok(BEN.id !== ANNA.id);
  });
});

// ------------------------------------------------------------------ what the source may not do

test('the view has no innerHTML, no inline style, no markup strings, no external address and no arithmetic beyond bar scaling', () => {
  // The code without its comments: a comment may say what the code does not do.
  const source = fs
    .readFileSync(path.join(root, 'public', 'views', 'stats.js'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'DOM only');
  assert.doesNotMatch(source, /\.style\b|setAttribute\(\s*'style'|style:/, 'no inline style: the CSP forbids it');
  assert.doesNotMatch(source, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, 'no address but the SVG namespace');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|import\s*\(/, 'one request, through api.js');
  assert.match(source, /createElementNS\(SVG_NS/, 'the sheet is made with createElementNS');
  assert.doesNotMatch(source, /toFixed|toLocale|Intl\./, 'numbers and months are written by the shared formatters');
  assert.doesNotMatch(source, /\.reduce\(/, 'nothing is summed on the screen');
  // The only rounding of a number is the scaling of a bar (and the one-decimal coordinates of the sheet): a value is never rounded
  // for display here, the server's ratios are already whole numbers.
  const rounding = source.split('\n').filter((line) => /Math\.(round|floor|ceil|trunc)\(/.test(line));
  assert.equal(rounding.length, 2, rounding.join('\n'));
  assert.ok(rounding.some((line) => /const round1\b/.test(line)) && rounding.some((line) => /const heightOf\b/.test(line)), 'coordinates and bar height only');
  assert.doesNotMatch(source, /Math\.(sum|average)|\+= |\bsum\b|\baverage\b/i, 'no totals or averages on the screen');
});

test('the stylesheet gives the charts nothing but tokens: no colour of its own, no yellow, no shadow, no gradient', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  const block = css.slice(css.indexOf('/* ---- statistics'), css.indexOf('/* ---- Meer (more) and Account'));
  assert.ok(block.length > 500, 'the statistics block exists');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i, 'only var(--token) colours');
  assert.doesNotMatch(block, /var\(--accent\)|gradient|shadow|filter|blur|border-radius:\s*var\(--r-pill\)/);
  assert.match(block, /\.chart-defs\s*\{[^}]*position:\s*absolute[^}]*width:\s*0/, 'the pattern box has no size');
  assert.doesNotMatch(block, /\.chart-defs\s*\{[^}]*display:\s*none/, 'and is not display: none (a pattern in it would paint nowhere)');
});

// ------------------------------------------------------------------ reading and reaching the screen (UI and UX pass)

test('how to read the bars is a closed disclosure under the notes about the months, so the first chart is not pushed down', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom }) => {
    const page = await mount(dom);
    const card = one(page, 'section.stats-notes');
    const details = one(card, 'details.chart-details');
    assert.equal(one(details, 'summary').textContent, S.stats.legend.title);
    assert.equal(details.getAttribute('open'), null, 'closed until the person asks');
    assert.equal(all(details, 'ul.chart-legend li').length, 5, 'every cue is in it');
    assert.equal(all(details, 'p.hint').length, 0, 'what is true of the months is not hidden in it');
    assert.ok(all(card, 'p.hint').length >= 1, 'the current month is called provisional where it is seen at once');
  });
});

test('the button that opens a table says whose table it is (twelve of them follow each other), and the box that scrolls can be reached with the keyboard', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom }) => {
    const page = await mount(dom);
    for (const m of METRICS) {
      const fig = one(page, `figure[data-chart="${m.id}"]`);
      const toggle = one(fig, 'details.chart-details summary');
      const [word, rest] = all(toggle, 'span');
      assert.equal(word?.textContent, S.stats.chart.table, 'what is seen stays the one word');
      assert.ok(rest?.classList.contains('sr-only') && rest.textContent.includes(m.title), `${m.id}: the rest is for whoever hears the buttons`);
      assert.equal(toggle.textContent, `${S.stats.chart.table} ${S.stats.chart.caption(m.title)}`);
      const box = one(fig, '.table-wrap');
      assert.equal(box.getAttribute('role'), 'region', m.id);
      assert.equal(box.getAttribute('tabindex'), '0', `${m.id}: a phone scrolls this box sideways, so the keyboard must reach it`);
      assert.equal(box.getAttribute('aria-label'), S.stats.chart.caption(m.title));
    }
  });
});

test('after a person is chosen with the select the keyboard comes back to it, not to the heading the shell focuses (an arrow key applies each step at once)', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom, tick }) => {
    const me = makeApp(ANNA);
    const before = await mount(dom, me);
    const old = one(before, 'select');
    old.focus();
    old.value = '2';
    await old.fire('change');
    assert.deepEqual(me.navigated, ['#/stats?months=12&who=2']);
    // The shell draws the new address (the old page is still in place while the answer comes), then focuses the heading.
    const next = await renderStats(me.app, { query: new URLSearchParams('who=2') });
    dom.body.replaceChildren();
    const after = dom.mount(next);
    one(after, 'h2').focus();
    tick(1); // the timer of the redraw: after the shell's own focus
    // assert.ok, not equal: on a failure equal would try to print two whole fake pages.
    assert.ok(dom.focused() === one(after, 'select'), 'a second arrow key moves the select');
    assert.equal(one(after, 'select').value, '2');
  });
});

test('the select takes the keyboard only when it had it: a visit, a period button or a reload leaves the focus on the heading', async () => {
  await withClient({ now: NOW, routes: statsRoute(() => report(12, busy)) }, async ({ dom, tick }) => {
    const me = makeApp(ANNA);
    const first = await mount(dom, me);
    (all(first, 'button.seg')[2] as FakeElement).focus(); // the keyboard is on a period button, not on the select
    const next = await renderStats(me.app, { query: new URLSearchParams('months=24') });
    dom.body.replaceChildren();
    const page = dom.mount(next);
    one(page, 'h2').focus();
    tick(1);
    assert.ok(dom.focused() === one(page, 'h2'), 'the heading keeps the focus');
  });
});
