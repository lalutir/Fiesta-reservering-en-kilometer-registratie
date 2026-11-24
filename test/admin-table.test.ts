// The admin data table (public/admin/table.js): sortable headers, a filter for a long table, the choice kept while the
// panel is rebuilt, and a comparison that never depends on the device's locale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { h } from '../public/dom.js';
import { S } from '../public/strings.js';
import { FILTER_FROM_ROWS, compareKeys, dataTable, normalise, resetTableStates, sortKey, withSort } from '../public/admin/table.js';
import { all, byText, one, typeInto, withClient, NOW, type FakeElement } from './fake-dom.ts';

const NAMES = ['Éric', 'Zoë', 'anna', 'Ben', 'Cor', 'Dora', 'Emma', 'Femke', 'Gijs', 'Hanna'];
const column = (table: unknown, index: number): string[] => all(table, 'tbody tr').map((tr) => (all(tr, 'td')[index] as FakeElement).textContent);
const sortButton = (table: unknown, title: string): FakeElement => {
  const found = all(table, 'button.sort').find((b) => b.getAttribute('aria-label') === S.ui.sortBy(title));
  assert.ok(found, `no sort button for ${title}`);
  return found;
};
const th = (table: unknown, title: string): FakeElement => sortButton(table, title).parent as FakeElement;

test('sort keys: a number when the cell starts with one (also in the Dutch way of writing it), otherwise the text without case and accents', () => {
  assert.equal(sortKey('12'), 12);
  assert.equal(sortKey('41.120 km'), 41120);
  assert.equal(sortKey('1.234.567'), 1234567);
  assert.equal(sortKey('3,5 liter'), 3.5);
  assert.equal(sortKey('Éric'), 'eric');
  assert.equal(sortKey('–'), '–', 'a dash is text');
  assert.equal(sortKey(7), 7);
  assert.equal(sortKey(withSort('ma 15 jun', '2026-06-15T10:00:00.000Z')), '2026-06-15T10:00:00.000Z', 'a cell can give its own key');
  assert.equal(normalise('  Zoë Ünal '), 'zoe unal');
});

test('compareKeys: numbers by value (2 before 10), numbers before text, text by plain comparison; no locale is involved', () => {
  assert.ok(compareKeys(2, 10) < 0 && compareKeys(10, 2) > 0 && compareKeys(5, 5) === 0);
  assert.ok(compareKeys(99, 'a') < 0 && compareKeys('a', 99) > 0);
  assert.ok(compareKeys('anna', 'ben') < 0 && compareKeys('ben', 'anna') > 0 && compareKeys('x', 'x') === 0);
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'admin', 'table.js'), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /localeCompare|Intl\.Collator/);
});

test('a table keeps the named, focusable, scrolling region and one header cell per column; the actions column is named but cannot be sorted', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    const table = dom.mount(dataTable('Gebruikers', ['#', 'Naam', ''], [[1, 'Anna', h('div')], [2, 'Ben', h('div')]]));
    const wrap = one(table, '.table-wrap');
    assert.deepEqual([wrap.getAttribute('role'), wrap.getAttribute('aria-label'), wrap.getAttribute('tabindex')], ['region', 'Gebruikers', '0']);
    assert.ok(one(wrap, 'table.data'));
    assert.deepEqual(all(table, 'thead th').map((cell) => cell.getAttribute('scope')), ['col', 'col', 'col']);
    assert.equal(all(table, 'thead button.sort').length, 2, 'two sortable columns');
    assert.equal(one(all(table, 'thead th')[2], '.sr-only').textContent, S.admin.actions);
    assert.equal(all(table, 'p.hint').length, 0, 'a short table has no filter and no count');
  }));

test('pressing a header sorts that column ascending, again descending, and aria-sort says so on that header only', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    const rows = [[10, 'Ben'], [2, 'Éric'], [33, 'anna'], [4, 'Zoë']];
    const table = dom.mount(dataTable('Gebruikers', ['#', 'Naam'], rows));
    assert.deepEqual(column(table, 1), ['Ben', 'Éric', 'anna', 'Zoë'], 'the order the server sent');
    await sortButton(table, '#').fire('click');
    assert.deepEqual(column(table, 0), ['2', '4', '10', '33'], 'by value, not by text');
    assert.equal(th(table, '#').getAttribute('aria-sort'), 'ascending');
    assert.equal(th(table, 'Naam').getAttribute('aria-sort'), null);
    await sortButton(table, '#').fire('click');
    assert.deepEqual(column(table, 0), ['33', '10', '4', '2']);
    assert.equal(th(table, '#').getAttribute('aria-sort'), 'descending');
    await sortButton(table, 'Naam').fire('click');
    assert.deepEqual(column(table, 1), ['anna', 'Ben', 'Éric', 'Zoë'], 'without regard to case or accents');
    assert.equal(th(table, '#').getAttribute('aria-sort'), null, 'only the sorted column says so');
    assert.equal(th(table, 'Naam').getAttribute('aria-sort'), 'ascending');
    assert.equal(sortButton(table, 'Naam').textContent, 'Naam', 'the header text is what a person sees');
  }));

test('a date column sorts by its own key, not by the words that are shown; equal keys keep the order the server sent', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    const rows = [
      ['a', withSort('zo 3 mei', '2026-05-03')],
      ['b', withSort('ma 1 jun', '2026-06-01')],
      ['c', withSort('di 5 mei', '2026-05-05')],
      ['d', withSort('di 5 mei', '2026-05-05')],
    ];
    const table = dom.mount(dataTable('Ritten', ['Naam', 'Wanneer'], rows));
    await sortButton(table, 'Wanneer').fire('click');
    assert.deepEqual(column(table, 0), ['a', 'c', 'd', 'b'], 'in the order of the calendar, and c before d as they came');
    await sortButton(table, 'Wanneer').fire('click');
    assert.deepEqual(column(table, 0), ['b', 'c', 'd', 'a'], 'newest first, ties still in the order they came');
  }));

test('a long table has a filter and a count; typing filters on any column without regard to case and accents, and an empty answer says so', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    assert.equal(FILTER_FROM_ROWS, 8);
    const rows = NAMES.map((n, i) => [i + 1, n, h('div', { class: 'actions' })]);
    const table = dom.mount(dataTable('Gebruikers', ['#', 'Naam', ''], rows));
    const input = one(table, 'input[type="search"]');
    assert.equal(one(table, 'label').textContent, S.ui.filter);
    assert.equal(one(table, 'p.hint').textContent, S.ui.rowCount(10, 10));
    await typeInto(input, 'eric');
    assert.deepEqual(column(table, 1), ['Éric'], 'accents and case do not matter');
    assert.equal(one(table, 'p.hint').textContent, S.ui.rowCount(1, 10));
    await typeInto(input, 'ha');
    assert.deepEqual(column(table, 1), ['Hanna']);
    await typeInto(input, 'nobody');
    assert.equal(all(table, 'tbody tr').length, 0);
    assert.equal(one(table, 'p.hint').textContent, S.ui.noMatches);
    await typeInto(input, '');
    assert.equal(all(table, 'tbody tr').length, 10);
    assert.equal(one(table, 'p.hint').getAttribute('aria-live'), 'polite', 'the count is announced');
  }));

test('the filter does not search the actions column: the words on its buttons match no row, so a short query still narrows the table', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    // Every row carries real buttons, as the Users, Reservations and Drives tables do.
    const buttons = () => h('div', { class: 'actions' }, [h('button', { type: 'button', text: 'Wijzigen' }), h('button', { type: 'button', text: 'Reservering annuleren' })]);
    const rows = NAMES.map((n, i) => [i + 1, n, buttons()]);
    const table = dom.mount(dataTable('Reserveringen', ['#', 'Naam', ''], rows));
    const input = one(table, 'input[type="search"]');
    await typeInto(input, 'ann');
    assert.deepEqual(column(table, 1), ['anna', 'Hanna'], '"ann" is in two names, not in every "Reservering annuleren" button');
    await typeInto(input, 'wij');
    assert.equal(all(table, 'tbody tr').length, 0, 'the word on the Wijzigen button matches no row');
    assert.equal(one(table, 'p.hint').textContent, S.ui.noMatches);
    await typeInto(input, 'e');
    assert.deepEqual(column(table, 1), ['Éric', 'Zoë', 'Ben', 'Emma', 'Femke'], 'a one-letter query keeps only the names that have the letter, not all ten rows');
    await typeInto(input, '7');
    assert.deepEqual(column(table, 1), ['Emma'], 'the other columns are still searched, a number included');
  }));

test('the sort and the filter of a table are kept when the panel is rebuilt after an action, per table', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    resetTableStates();
    const rows = NAMES.map((n, i) => [i + 1, n]);
    const first = dom.mount(dataTable('Gebruikers', ['#', 'Naam'], rows));
    await sortButton(first, 'Naam').fire('click');
    await sortButton(first, 'Naam').fire('click');
    await typeInto(one(first, 'input[type="search"]'), 'a');
    const before = column(first, 1);
    dom.body.replaceChildren();
    const again = dom.mount(dataTable('Gebruikers', ['#', 'Naam'], rows));
    assert.deepEqual(column(again, 1), before, 'the same rows in the same order');
    assert.equal(one(again, 'input[type="search"]').value, 'a');
    assert.equal(th(again, 'Naam').getAttribute('aria-sort'), 'descending');
    dom.body.replaceChildren();
    const other = dom.mount(dataTable('Ritten', ['#', 'Naam'], rows));
    assert.equal(th(other, 'Naam').getAttribute('aria-sort'), null, 'another table starts fresh');
    assert.ok(byText(other, 'button', 'Naam'));
  }));
