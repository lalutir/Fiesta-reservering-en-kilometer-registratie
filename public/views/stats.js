// Statistics: the monthly totals of the household or of one person, one bar chart per metric, each with a sentence
// that says what it shows and a table with the same numbers. Reached from the Drives tab (it is not a tab itself).
//
// Nothing here works out a total, an average or a share: the server sends every number (GET /api/stats,
// docs/STATS-API.md), and this file only picks which one goes where, writes it in Dutch and scales the bars. The
// charts are inline SVG built with createElementNS: no library, no markup string, no style attribute (the CSP
// forbids it), no request but the one for the numbers. Colour is never the only cue: a bar that is not final is
// hatched, the kilometres driven together are dotted, an unknown month is a dash, and every month has its state in
// words in the table.
import { ApiError, get } from '../api.js';
import { addMonthKey, field, formatEuro, formatHundredths, formatKm, formatLitres, formatMonthKey, formatPrice, h, monthKeyOf } from '../dom.js';
import { S } from '../strings.js';
import { emptyState, segmented } from '../ui.js';

// A read-only page: nothing to rebuild in the background.
export const live = false;

/** The choices of the period, in months. A choice above what the server keeps is not offered. */
export const PERIODS = [6, 12, 24];
export const DEFAULT_PERIOD = 12;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {import('../api.js').StatsEntry} StatsEntry
 * @typedef {import('../api.js').StatsReport} StatsReport
 * @typedef {object} Metric
 * @property {string} id
 * @property {'drives' | 'fuel' | 'other'} group
 * @property {string} title
 * @property {boolean} householdOnly only the household has it (the server has no per-person number)
 * @property {(e: StatsEntry) => number | null} value
 * @property {((e: StatsEntry) => number) | null} together a second part, stacked on top and dotted (household only)
 * @property {boolean} ratio a month without anything is unknown for this metric, not zero
 * @property {(n: number) => string} text the number with its unit, for sentences and the table
 * @property {(n: number) => string} bare the number alone, written on the bar
 * @property {string} [note] a sentence under the chart
 */

/** The euro without its sign: the title of the chart says the unit, so a bar only carries the number. @param {number} cents */
const bareEuro = (cents) => formatEuro(cents).replace(/^€\s/u, '');
const bareCount = (/** @type {number} */ n) => String(n);

/** @type {Metric[]} */
export const METRICS = [
  { id: 'trips', group: 'drives', title: S.stats.metrics.trips, householdOnly: false, value: (e) => e.trips, together: null, ratio: false, text: S.stats.value.trips, bare: bareCount },
  { id: 'km', group: 'drives', title: S.stats.metrics.km, householdOnly: false, value: (e) => e.km, together: (e) => e.togetherKm, ratio: false, text: S.stats.value.km, bare: formatKm },
  { id: 'unaccounted', group: 'drives', title: S.stats.metrics.unaccounted, householdOnly: true, value: (e) => e.unaccountedKm, together: null, ratio: false, text: S.stats.value.km, bare: formatKm },
  { id: 'litres', group: 'fuel', title: S.stats.metrics.litres, householdOnly: false, value: (e) => e.millilitres, together: null, ratio: false, text: S.stats.value.litres, bare: formatLitres },
  { id: 'paid', group: 'fuel', title: S.stats.metrics.paid, householdOnly: false, value: (e) => e.paidCents, together: null, ratio: false, text: S.stats.value.euro, bare: bareEuro },
  { id: 'share', group: 'fuel', title: S.stats.metrics.share, householdOnly: false, value: (e) => e.shareCents, together: null, ratio: false, text: S.stats.value.euro, bare: bareEuro },
  { id: 'price', group: 'fuel', title: S.stats.metrics.price, householdOnly: false, value: (e) => e.pricePerLitreMillis, together: null, ratio: true, text: S.stats.value.price, bare: formatPrice },
  { id: 'costPerKm', group: 'fuel', title: S.stats.metrics.costPerKm, householdOnly: false, value: (e) => e.costPerKmMillis, together: null, ratio: true, text: S.stats.value.perKm, bare: formatPrice },
  {
    id: 'consumption',
    group: 'fuel',
    title: S.stats.metrics.consumption,
    householdOnly: true,
    value: (e) => e.consumptionHundredths,
    together: null,
    ratio: true,
    text: S.stats.value.consumption,
    bare: formatHundredths,
    note: S.stats.consumptionNote,
  },
  { id: 'tickets', group: 'other', title: S.stats.metrics.tickets, householdOnly: false, value: (e) => e.tickets, together: null, ratio: false, text: S.stats.value.tickets, bare: bareCount },
  { id: 'ticketCents', group: 'other', title: S.stats.metrics.ticketCents, householdOnly: false, value: (e) => e.ticketCents, together: null, ratio: false, text: S.stats.value.euro, bare: bareEuro },
  { id: 'damage', group: 'other', title: S.stats.metrics.damage, householdOnly: false, value: (e) => e.damageReports, together: null, ratio: false, text: S.stats.value.damage, bare: bareCount },
];

// ------------------------------------------------------------------ what the address says

/**
 * The choice of period and person lives in the address (#/stats?months=24&who=3), so a reload and the back button keep it.
 * Anything that is not a known choice falls back to the default instead of failing.
 * @param {URLSearchParams} query
 * @returns {{ months: number, who: string }}
 */
export function readState(query) {
  const months = Number(query.get('months'));
  const who = query.get('who') ?? 'household';
  return {
    months: PERIODS.includes(months) ? months : DEFAULT_PERIOD,
    who: who === 'household' || /^[1-9]\d{0,9}$/.test(who) ? who : 'household',
  };
}

/** @param {{ months: number, who: string }} state */
export function statsHash(state) {
  return state.months === DEFAULT_PERIOD && state.who === 'household' ? '#/stats' : `#/stats?months=${state.months}&who=${state.who}`;
}

// ------------------------------------------------------------------------- the numbers

/**
 * One month of one metric, ready to draw.
 * @typedef {object} Point
 * @property {string} month 'YYYY-MM'
 * @property {number | null} value null = unknown (an unavailable month, or a ratio without anything to divide)
 * @property {number | null} together the part driven together (kilometres, household only)
 * @property {boolean} provisional
 * @property {boolean} frozen
 * @property {boolean} incomplete
 * @property {boolean} unavailable
 */

/**
 * The series of one metric for the household (who = 'household') or for one person (who = their id). A person who has
 * nothing in an available month has zero of everything that is a count, and nothing for a ratio.
 * @param {StatsReport} report
 * @param {Metric} metric
 * @param {string} who
 * @returns {Point[]}
 */
export function seriesOf(report, metric, who) {
  const personId = who === 'household' ? null : Number(who);
  return report.months.map((m) => {
    /** @type {StatsEntry | null | undefined} */
    const entry = m.unavailable ? null : personId === null ? m.household : m.people.find((p) => p.userId === personId);
    /** @type {number | null} */
    let value = null;
    /** @type {number | null} */
    let together = null;
    if (entry) {
      value = metric.value(entry);
      together = personId === null && metric.together ? metric.together(entry) : null;
    } else if (entry === undefined && !metric.ratio) value = 0;
    return { month: m.month, value, together, provisional: m.provisional, frozen: m.frozen, incomplete: m.incomplete, unavailable: m.unavailable };
  });
}

/** @param {Point} p @param {Metric} metric */
function pointText(p, metric) {
  if (p.value === null) return S.stats.chart.unknown;
  return metric.text(p.value) + (p.together ? S.stats.chart.plusTogether(metric.text(p.together)) : '');
}

/**
 * The index of the highest month that has anything in it (the first one on a tie), or -1 when none has.
 * @param {Point[]} points
 */
function topIndex(points) {
  let top = -1;
  points.forEach((p, i) => {
    if (p.value !== null && p.value > 0 && (top < 0 || p.value > (points[top]?.value ?? 0))) top = i;
  });
  return top;
}

/**
 * One or two sentences: the latest month and the highest one. A comparison, not a calculation.
 * @param {Metric} metric
 * @param {Point[]} points
 */
export function summaryOf(metric, points) {
  const last = points[points.length - 1];
  const latest = last && last.value !== null ? last : null;
  const top = points[topIndex(points)] ?? null;
  if (!latest && !top) return S.stats.chart.none;
  if (latest && top && latest.month === top.month) return S.stats.chart.latestAndTop(formatMonthKey(latest.month), pointText(latest, metric));
  return [
    latest ? S.stats.chart.latest(formatMonthKey(latest.month), pointText(latest, metric)) : '',
    top ? S.stats.chart.top(formatMonthKey(top.month), pointText(top, metric)) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// -------------------------------------------------------------------------- the drawing

/**
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @param {string} [text]
 * @returns {SVGElement}
 */
function svg(tag, attrs, text) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** @param {number} n */
const round1 = (n) => Math.round(n * 10) / 10;

// The chart is drawn on a 320 x 172 sheet that is scaled to the width of the box (about 1:1 on a phone), so a font size
// here is in the same units as the sheet.
const W = 320;
const H = 172;
const PAD = 6;
const TOP = 24;
const BASE = 142;
const AXIS_Y = 162;
const PLOT = BASE - TOP;

/**
 * The two fills that are patterns, defined once for the whole page (a pattern needs an id, and an id must be unique).
 * The box has no size but is not hidden: a pattern in a box that is not rendered would not paint anywhere.
 */
function chartDefs() {
  const hatch = svg('pattern', { id: 'stats-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  hatch.appendChild(svg('rect', { class: 'stats-pattern-bg', width: 6, height: 6 }));
  hatch.appendChild(svg('line', { class: 'stats-pattern-ink', x1: 0, y1: 0, x2: 0, y2: 6 }));
  const dots = svg('pattern', { id: 'stats-dots', width: 5, height: 5, patternUnits: 'userSpaceOnUse' });
  dots.appendChild(svg('rect', { class: 'stats-pattern-bg', width: 5, height: 5 }));
  dots.appendChild(svg('circle', { class: 'stats-pattern-dot', cx: 2.5, cy: 2.5, r: 1.2 }));
  const defs = svg('defs', {});
  defs.appendChild(hatch);
  defs.appendChild(dots);
  const root = svg('svg', { class: 'chart-defs', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
  root.appendChild(defs);
  return root;
}

/** The three kinds of bar and what each is painted with. The chart and its legend draw them from this one table. */
const BAR = {
  solid: { class: 'chart-bar' },
  hatched: { class: 'chart-bar-hatched', fill: 'url(#stats-hatch)' },
  dotted: { class: 'chart-bar-dotted', fill: 'url(#stats-dots)' },
};

/** @param {'solid' | 'hatched' | 'dotted'} kind @param {number} x @param {number} y @param {number} width @param {number} height */
function bar(kind, x, y, width, height) {
  return svg('rect', { ...BAR[kind], x, y, width, height });
}

/**
 * A small sample of a bar for the legend, drawn like the bars themselves.
 * @param {'solid' | 'hatched' | 'dotted' | 'gap'} kind
 */
function swatch(kind) {
  const el = svg('svg', { class: 'chart-swatch', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' });
  el.appendChild(kind === 'gap' ? svg('line', { class: 'chart-gap', x1: 2, x2: 14, y1: 14, y2: 14 }) : bar(kind, 2, 2, 12, 12));
  return el;
}

/**
 * Which points get their number written on the bar: every one for a short period, and for a long one only the latest
 * month and the highest (when it is not right beside the latest, so the two labels never overlap).
 * @param {Point[]} points
 * @param {number} slot width of one month on the sheet
 * @returns {Set<number>} indexes
 */
function labelled(points, slot) {
  /** @type {Set<number>} */
  const shown = new Set();
  if (points.length <= 6) {
    points.forEach((p, i) => p.value !== null && shown.add(i));
    return shown;
  }
  const lastIndex = points.length - 1;
  const lastPoint = points[lastIndex];
  if (lastPoint && lastPoint.value !== null) shown.add(lastIndex);
  const top = topIndex(points);
  if (top >= 0 && (!shown.has(lastIndex) || (lastIndex - top) * slot >= 56)) shown.add(top);
  return shown;
}

/**
 * The text anchor and x of a label that is centred on a bar but must not leave the sheet.
 * @param {number} cx
 * @param {number} barX
 * @param {number} barW
 */
function anchored(cx, barX, barW) {
  if (cx < 40) return { x: barX, anchor: 'start' };
  if (cx > W - 40) return { x: barX + barW, anchor: 'end' };
  return { x: cx, anchor: 'middle' };
}

/**
 * The sheet of one chart.
 * @param {Metric} metric
 * @param {Point[]} points
 * @param {string} titleId
 * @param {string} summaryId
 */
function sheet(metric, points, titleId, summaryId) {
  const n = points.length;
  const slot = (W - 2 * PAD) / n;
  const barW = Math.max(4, round1(slot * 0.64));
  const top = Math.max(0, ...points.map((p) => (p.value ?? 0) + (p.together ?? 0)));
  /** Bar scaling: the one calculation in this file. A value above zero is always at least 2 high, so it can be seen. @param {number | null} v */
  const heightOf = (v) => (v === null || v <= 0 || top === 0 ? 0 : Math.max(2, Math.round((v / top) * PLOT)));
  const every = n <= 6 ? 1 : n <= 12 ? 2 : 4;
  const labels = labelled(points, slot);

  const root = svg('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': titleId, 'aria-describedby': summaryId, focusable: 'false' });
  root.appendChild(svg('line', { class: 'chart-base', x1: PAD, x2: W - PAD, y1: BASE, y2: BASE }));
  points.forEach((p, i) => {
    const barX = round1(PAD + i * slot + (slot - barW) / 2);
    const cx = round1(barX + barW / 2);
    const at = anchored(cx, barX, barW);
    const g = svg('g', { class: 'chart-month', 'data-month': p.month });
    if (p.value === null) {
      g.appendChild(svg('line', { class: 'chart-gap', x1: round1(cx - 4), x2: round1(cx + 4), y1: BASE - 5, y2: BASE - 5 }));
    } else {
      const own = heightOf(p.value);
      const extra = heightOf(p.together);
      if (own > 0) g.appendChild(bar(p.provisional || p.incomplete ? 'hatched' : 'solid', barX, BASE - own, barW, own));
      if (extra > 0) g.appendChild(bar('dotted', barX, BASE - own - extra, barW, extra));
      if (labels.has(i)) {
        const text = metric.bare(p.value) + (p.together ? `+${metric.bare(p.together)}` : '');
        g.appendChild(svg('text', { class: 'chart-value', x: at.x, y: Math.max(12, BASE - own - extra - 5), 'text-anchor': at.anchor }, text));
      }
    }
    if ((n - 1 - i) % every === 0) {
      g.appendChild(svg('text', { class: 'chart-axis', x: at.x, y: AXIS_Y, 'text-anchor': at.anchor }, formatMonthKey(p.month, 'short')));
    }
    root.appendChild(g);
  });
  return root;
}

/**
 * The same numbers as a table, for whoever cannot or does not want to read bars, with the state of each month in words.
 * @param {Metric} metric
 * @param {Point[]} points
 */
function dataTable(metric, points) {
  const withTogether = points.some((p) => p.together !== null);
  return h('table', { class: 'chart-table' }, [
    h('caption', { class: 'sr-only', text: S.stats.chart.caption(metric.title) }),
    h('thead', {}, [
      h('tr', {}, [
        h('th', { scope: 'col', text: S.stats.chart.colMonth }),
        h('th', { scope: 'col', text: metric.title }),
        withTogether ? h('th', { scope: 'col', text: S.stats.chart.colTogether }) : null,
        h('th', { scope: 'col', text: S.stats.chart.colStatus }),
      ]),
    ]),
    h(
      'tbody',
      {},
      // Newest first: the month people look for is the latest one.
      [...points].reverse().map((p) =>
        h('tr', { 'data-month': p.month }, [
          h('th', { scope: 'row', text: formatMonthKey(p.month) }),
          h('td', { text: p.value === null ? S.stats.chart.unknown : metric.text(p.value) }),
          withTogether ? h('td', { text: p.together === null ? '' : metric.text(p.together) }) : null,
          h('td', { text: S.stats.chart.state(p.provisional, p.frozen, p.incomplete, p.unavailable) }),
        ]),
      ),
    ),
  ]);
}

/**
 * One metric: a heading, one sentence, the bars and the table.
 * @param {Metric} metric
 * @param {Point[]} points
 */
export function chart(metric, points) {
  const titleId = `stats-${metric.id}-title`;
  const summaryId = `stats-${metric.id}-summary`;
  return h('figure', { class: 'card chart', 'data-chart': metric.id }, [
    h('h4', { class: 'chart-title', id: titleId, text: metric.title }),
    h('p', { class: 'chart-summary', id: summaryId, text: summaryOf(metric, points) }),
    sheet(metric, points, titleId, summaryId),
    metric.note ? h('p', { class: 'hint', text: metric.note }) : null,
    h('details', { class: 'chart-details' }, [
      tableToggle(metric),
      // A phone is narrower than some of these tables, so the box scrolls: a named region the keyboard can reach (as in the admin tables).
      h('div', { class: 'table-wrap', role: 'region', 'aria-label': S.stats.chart.caption(metric.title), tabindex: '0' }, dataTable(metric, points)),
    ]),
  ]);
}

/**
 * The button that opens the table of one chart. Twelve of them follow each other, so each one says whose table it opens
 * for whoever hears the buttons without the headings (the visible word stays "Tabel").
 * @param {Metric} metric
 */
function tableToggle(metric) {
  return h('summary', {}, [h('span', { text: S.stats.chart.table }), h('span', { class: 'sr-only', text: ` ${S.stats.chart.caption(metric.title)}` })]);
}

// ---------------------------------------------------------------------------- the screen

/** @param {string[]} months @returns {string} */
const monthList = (months) => months.map((m) => formatMonthKey(m)).join(', ');

/**
 * The months that are not plain numbers, in words: the current one, the incomplete ones, the unknown ones.
 * @param {StatsReport} report
 */
function monthNotes(report) {
  const provisional = report.months.filter((m) => m.provisional && !m.unavailable).map((m) => m.month);
  const incomplete = report.months.filter((m) => m.incomplete && !m.provisional && !m.unavailable).map((m) => m.month);
  const unavailable = report.months.filter((m) => m.unavailable).map((m) => m.month);
  return [
    provisional.length > 0 ? S.stats.notes.provisional(monthList(provisional)) : '',
    incomplete.length > 0 ? S.stats.notes.incomplete(monthList(incomplete)) : '',
    unavailable.length > 0 ? S.stats.notes.unavailable(monthList(unavailable)) : '',
  ].filter(Boolean);
}

function legend() {
  const items = /** @type {const} */ ([
    ['solid', S.stats.legend.solid],
    ['hatched', S.stats.legend.hatched],
    ['dotted', S.stats.legend.dotted],
    ['gap', S.stats.legend.gap],
  ]);
  return h('ul', { class: 'chart-legend' }, [
    ...items.map(([kind, text]) => h('li', {}, [swatch(kind), h('span', { text })])),
    h('li', {}, [h('span', { text: S.stats.legend.frozen })]),
  ]);
}

const WHO_ID = 'stats-who';

/**
 * The latest report: the default one, or one from a month on. A `from` the server will not take (this phone's clock
 * is off, or the server keeps fewer months than asked) falls back to the default instead of showing an error.
 * @param {import('../api.js').App} app
 * @param {number} months
 * @returns {Promise<StatsReport>}
 */
async function load(app, months) {
  if (months === DEFAULT_PERIOD) return get('/api/stats');
  const from = addMonthKey(monthKeyOf(new Date(), app.tz), -(months - 1));
  try {
    return await get(`/api/stats?from=${from}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) return get('/api/stats');
    throw err;
  }
}

/**
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const wanted = readState(route.query);
  // Choosing a person redraws the screen through the address, and the shell then puts the keyboard on the heading. A select
  // applies every arrow key at once, so a second press would land on the heading and not on the select. The old page is still
  // on screen while the answer is on its way, so whether the select had the keyboard is read now, before anything is drawn.
  const selectHadFocus = document.activeElement?.id === WHO_ID;
  const report = await load(app, wanted.months);

  const offered = PERIODS.filter((n) => n <= report.retentionMonths);
  const months = offered.includes(wanted.months) ? wanted.months : (offered[offered.length - 1] ?? DEFAULT_PERIOD);
  const who = wanted.who === 'household' || report.users.some((u) => String(u.id) === wanted.who) ? wanted.who : 'household';

  const period = segmented({
    label: S.stats.period,
    options: offered.map((n) => ({ value: String(n), label: S.stats.periodLabel(n), name: S.stats.periodName(n) })),
    value: String(months),
    onChange: (value) => app.navigate(statsHash({ months: Number(value), who })),
  });
  const select = h(
    'select',
    { id: WHO_ID, value: who, onchange: (/** @type {Event} */ e) => app.navigate(statsHash({ months, who: /** @type {HTMLSelectElement} */ (e.target).value })) },
    [
      h('option', { value: 'household', text: S.stats.household }),
      ...report.users.map((u) => h('option', { value: String(u.id), text: u.active ? u.name : S.stats.inactive(u.name) })),
    ],
  );
  const picker = field(S.stats.who, select);
  // After the shell has put the focus on the heading, which it does right after this view is drawn. A render that a newer one
  // overtook never gets its select into the page, so only the redraw that stays gives the keyboard back.
  if (selectHadFocus) setTimeout(() => select.isConnected && select.focus({ preventScroll: true }), 0);

  const shown = METRICS.filter((m) => who === 'household' || !m.householdOnly);
  const series = shown.map((m) => ({ metric: m, points: seriesOf(report, m, who) }));
  const hasData = series.some(({ points }) => points.some((p) => (p.value ?? 0) > 0 || (p.together ?? 0) > 0));

  const groups = /** @type {const} */ (['drives', 'fuel', 'other']).map((group) => {
    const members = series.filter(({ metric }) => metric.group === group);
    return members.length === 0
      ? null
      : h('section', { class: 'chart-group', 'data-group': group }, [
          h('h3', { text: S.stats.groups[group] }),
          h('div', { class: 'chart-grid' }, members.map(({ metric, points }) => chart(metric, points))),
        ]);
  });

  return h('div', { class: 'stats-view' }, [
    chartDefs(),
    h('div', { class: 'view-head' }, [h('h2', { text: S.stats.title })]),
    h('p', { class: 'hint', text: S.stats.intro }),
    h('section', { class: 'card stats-controls' }, [period.el, picker.row]),
    who !== 'household' ? h('p', { class: 'hint', text: S.stats.householdOnly }) : null,
    hasData
      ? [
          // What is true of these months comes first and stays in view; how to read the bars is one tap away, so the first chart
          // is not pushed a screen down for someone who has read it before.
          h('section', { class: 'card stats-notes' }, [
            monthNotes(report).map((line) => h('p', { class: 'hint', text: line })),
            h('details', { class: 'chart-details' }, [h('summary', { text: S.stats.legend.title }), legend()]),
          ]),
          groups,
        ]
      : emptyState(who === 'household' ? S.stats.empty : S.stats.emptyPerson),
  ]);
}
