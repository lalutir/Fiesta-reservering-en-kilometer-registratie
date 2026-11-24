// The admin data table: the same named, keyboard-focusable scrolling region as before (.table-wrap), now with
// sortable column headers and, for a long table, a text filter. Everything is client side over the rows the admin
// endpoints already return; nothing is asked of the server for it.
//
// Sorting compares plain keys: a number when the cell starts with one ("41.120 km", "12"), otherwise the text in lower
// case without accents. It never uses localeCompare or Intl.Collator: the result of those depends on the device's
// locale, and test/dutch.test.ts forbids them. A cell that is a date or a time can give its own key (withSort), because
// "ma 15 jun" does not sort in the order of the calendar.
import { field, h } from '../dom.js';
import { icon } from '../icons.js';
import { S } from '../strings.js';

/** Tables with at least this many rows get a filter. */
export const FILTER_FROM_ROWS = 8;

/**
 * A cell with its own sort key.
 * @param {unknown} content what the cell shows
 * @param {string | number} key what it sorts by (an ISO date, a plain number)
 * @returns {{ content: unknown, sort: string | number }}
 */
export function withSort(content, key) {
  return { content, sort: key };
}

/** A DOM node (anything with a textContent), as opposed to a plain value or a withSort() cell. @param {unknown} value @returns {value is Node} */
const isNode = (value) => typeof value === 'object' && value !== null && 'textContent' in value;

/** @param {unknown} cell @returns {cell is { content: unknown, sort: string | number }} */
const hasSortKey = (cell) => typeof cell === 'object' && cell !== null && !isNode(cell) && 'sort' in cell && 'content' in cell;

/** Lower case, accents taken off: "Éric" sorts and filters like "eric". @param {unknown} value */
export function normalise(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/** What a cell shows: the content of a withSort() cell, otherwise the cell itself. @param {unknown} cell */
const contentOf = (cell) => (hasSortKey(cell) ? cell.content : cell);

/** The text of a cell, for sorting and filtering: what its node says, or the value as a string. @param {unknown} cell @returns {string} */
const textOf = (cell) => {
  const content = contentOf(cell);
  return isNode(content) ? (content.textContent ?? '') : String(content ?? '');
};

/**
 * What a cell sorts by: its own key, or the number it starts with, or its normalised text.
 * @param {unknown} cell
 * @returns {number | string}
 */
export function sortKey(cell) {
  if (hasSortKey(cell)) return cell.sort;
  const text = textOf(cell);
  const number = /^(-?\d{1,3}(?:\.\d{3})+|-?\d+)(?:,(\d+))?(?!\d)/.exec(text.trim());
  if (number) {
    const value = Number(`${(number[1] ?? '').replace(/\./g, '')}${number[2] ? `.${number[2]}` : ''}`);
    if (Number.isFinite(value)) return value;
  }
  return normalise(text);
}

/**
 * Plain comparison of two keys (numbers before text; no locale involved).
 * @param {number | string} a
 * @param {number | string} b
 */
export function compareKeys(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What the person chose for each table, kept while the panel is rebuilt after an action. @type {Map<string, { column: number | null, descending: boolean, filter: string }>} */
const states = new Map();

/** Forget every choice (a new page load, and tests). */
export function resetTableStates() {
  states.clear();
}

/**
 * A data table. The wrapper scrolls sideways on a phone, so it is a named, keyboard-focusable region. An empty header
 * text stands for the actions column (named for a screen reader, and not sortable).
 * @param {string} label what the table lists (its accessible name)
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows a cell is a node, a text, a number or withSort(...)
 * @returns {HTMLElement}
 */
export function dataTable(label, headers, rows) {
  const state = states.get(label) ?? { column: null, descending: false, filter: '' };
  states.set(label, state);
  const filterable = rows.length >= FILTER_FROM_ROWS;
  if (!filterable) state.filter = '';

  const tbody = h('tbody', {});
  const count = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  /** The sortable columns: their header cell, their button and what it says. @type {Array<{ th: HTMLElement, button: HTMLElement, title: string } | undefined>} */
  const sortable = [];

  const paint = () => {
    const needle = normalise(state.filter);
    // An empty header is the actions column: the words on its buttons are not data, and would match every row.
    let visible = needle === '' ? [...rows] : rows.filter((cells) => cells.some((c, i) => headers[i] !== '' && normalise(textOf(c)).includes(needle)));
    const column = state.column;
    if (column !== null) {
      // Array.prototype.sort is stable: equal keys keep the order the server sent.
      visible = visible.sort((a, b) => (state.descending ? -1 : 1) * compareKeys(sortKey(a[column]), sortKey(b[column])));
    }
    tbody.replaceChildren(...visible.map((cells) => h('tr', {}, cells.map((c) => h('td', {}, [contentOf(c)])))));
    count.textContent = filterable ? (visible.length === 0 ? S.ui.noMatches : S.ui.rowCount(visible.length, rows.length)) : '';
    sortable.forEach((header, i) => {
      if (!header) return;
      if (state.column === i) header.th.setAttribute('aria-sort', state.descending ? 'descending' : 'ascending');
      else header.th.removeAttribute('aria-sort');
      header.button.replaceChildren(h('span', { text: header.title }), icon(state.column === i ? (state.descending ? 'sort-down' : 'sort-up') : 'sort'));
    });
  };

  const head = headers.map((t, i) => {
    if (t === '') return h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: S.admin.actions }));
    const button = h(
      'button',
      {
        class: 'sort',
        type: 'button',
        'aria-label': S.ui.sortBy(t),
        onclick: () => {
          if (state.column === i) state.descending = !state.descending;
          else {
            state.column = i;
            state.descending = false;
          }
          paint();
        },
      },
      [h('span', { text: t }), icon('sort')],
    );
    const th = h('th', { scope: 'col' }, button);
    sortable[i] = { th, button, title: t };
    return th;
  });

  const filterInput = h('input', { type: 'search', autocomplete: 'off', placeholder: S.ui.filterPlaceholder, value: state.filter });
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    paint();
  });
  const tools = filterable ? h('div', { class: 'table-tools' }, [field(S.ui.filter, filterInput).row, count]) : null;

  paint();
  return h('div', { class: 'data-table' }, [
    tools,
    h('div', { class: 'table-wrap', role: 'region', 'aria-label': label, tabindex: '0' }, [h('table', { class: 'data' }, [h('thead', {}, [h('tr', {}, head)]), tbody])]),
  ]);
}
