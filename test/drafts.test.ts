// Unsent form input (public/drafts.js): kept per person and per form, only for what was changed, only for new
// records, never a password, gone after a save, a discard, sign-out or seven days, and harmless when storage fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../public/dom.js';
import { DRAFT_TTL_MS, clearAllDrafts, draftKey, persistForm, restoredNotice } from '../public/drafts.js';
import { S } from '../public/strings.js';
import { NOW, typeInto, withClient, type FakeElement } from './fake-dom.ts';

const input = (type: string, value = '') => h('input', { type, value }) as unknown as FakeElement;
const note = (value = '') => h('textarea', { value }) as unknown as FakeElement;

function threeControls() {
  return {
    odometer: input('number'),
    note: note(),
    who: h('select', { value: '1' }, [h('option', { value: '1' }, 'Anna'), h('option', { value: '2' }, 'Ben')]) as unknown as FakeElement,
  };
}

test('what the person changed comes back on the next visit, and only that', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const first = threeControls();
    const a = persistForm({ userId: 1, name: 'drive', controls: first });
    assert.equal(a.restored, false);
    await typeInto(first.odometer, '41200');
    await typeInto(first.note, 'Naar de bouwmarkt');
    const stored = JSON.parse(localStorage.getItem(draftKey(1, 'drive')) ?? 'null');
    assert.deepEqual(stored.values, { odometer: '41200', note: 'Naar de bouwmarkt' }, 'the select is still at its starting value, so it is not kept');
    const second = threeControls();
    const b = persistForm({ userId: 1, name: 'drive', controls: second });
    assert.equal(b.restored, true);
    assert.equal(second.odometer.value, '41200');
    assert.equal(second.note.value, 'Naar de bouwmarkt');
    assert.equal(second.who.value, '1');
  }));

test('a form that is back at its starting values keeps nothing', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const c = threeControls();
    persistForm({ userId: 1, name: 'fuel', controls: c });
    await typeInto(c.note, 'tijdelijk');
    assert.ok(localStorage.getItem(draftKey(1, 'fuel')));
    await typeInto(c.note, '');
    assert.equal(localStorage.getItem(draftKey(1, 'fuel')), null);
  }));

test('it is per person and per form: another user, or another form, sees nothing', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const c = threeControls();
    persistForm({ userId: 1, name: 'drive', controls: c });
    await typeInto(c.note, 'privé');
    const other = threeControls();
    assert.equal(persistForm({ userId: 2, name: 'drive', controls: other }).restored, false, "a shared phone does not show one person's text to another");
    assert.equal(other.note.value, '');
    const otherForm = threeControls();
    assert.equal(persistForm({ userId: 1, name: 'ticket', controls: otherForm }).restored, false);
  }));

test('a password field is never stored, whatever it is called', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const pw = input('password');
    const user = input('text');
    persistForm({ userId: 1, name: 'login', controls: { user, pw } });
    await typeInto(pw, 'geheim-wachtwoord');
    await typeInto(user, 'anna');
    const raw = localStorage.getItem(draftKey(1, 'login')) ?? '';
    assert.ok(!raw.includes('geheim'), 'the password is nowhere in storage');
    assert.deepEqual(JSON.parse(raw).values, { user: 'anna' });
  }));

test('a checkbox is kept as checked or not', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const box = input('checkbox');
    persistForm({ userId: 1, name: 'drive', controls: { box } });
    box.checked = true;
    await box.fire('change');
    const again = input('checkbox');
    assert.equal(persistForm({ userId: 1, name: 'drive', controls: { box: again } }).restored, true);
    assert.equal(again.checked, true);
  }));

test('clear (after a save) and discard (start over) both remove what is kept; discard also resets the fields', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const c = threeControls();
    const p = persistForm({ userId: 1, name: 'drive', controls: c });
    await typeInto(c.note, 'tekst');
    p.clear();
    assert.equal(localStorage.getItem(draftKey(1, 'drive')), null);
    await typeInto(c.note, 'weer tekst');
    p.discard();
    assert.equal(localStorage.getItem(draftKey(1, 'drive')), null);
    assert.equal(c.note.value, '', 'back to the starting value');
  }));

test('unsent input older than seven days is dropped, and a damaged entry is removed instead of breaking the form', () =>
  withClient({ now: NOW, routes: {} }, async ({ tick }) => {
    const c = threeControls();
    persistForm({ userId: 1, name: 'drive', controls: c });
    await typeInto(c.note, 'oud');
    tick(DRAFT_TTL_MS + 1000);
    const later = threeControls();
    assert.equal(persistForm({ userId: 1, name: 'drive', controls: later }).restored, false);
    assert.equal(later.note.value, '');
    assert.equal(localStorage.getItem(draftKey(1, 'drive')), null, 'the stale entry is removed');
    localStorage.setItem(draftKey(1, 'ticket'), '{not json');
    const t = threeControls();
    assert.doesNotThrow(() => persistForm({ userId: 1, name: 'ticket', controls: t }));
    assert.equal(localStorage.getItem(draftKey(1, 'ticket')), null);
  }));

test('a saved person who is no longer in the list does not break a select: it keeps its own value', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const c = threeControls();
    persistForm({ userId: 1, name: 'drive', controls: c });
    c.who.value = '2';
    await c.who.fire('change');
    const fewer = { who: h('select', { value: '1' }, [h('option', { value: '1' }, 'Anna')]) as unknown as FakeElement };
    persistForm({ userId: 1, name: 'drive', controls: fewer });
    assert.equal(fewer.who.value, '1');
  }));

test('blocked or full storage only means nothing is kept: the form works and typing never throws', () =>
  withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    dom.storage.blocked = true;
    const c = threeControls();
    const p = persistForm({ userId: 1, name: 'drive', controls: c });
    assert.equal(p.restored, false);
    await typeInto(c.note, 'tekst');
    assert.equal(c.note.value, 'tekst');
    assert.doesNotThrow(() => p.clear());
    assert.doesNotThrow(() => p.discard());
    dom.storage.blocked = false;
    dom.storage.full = true;
    const d = threeControls();
    persistForm({ userId: 1, name: 'drive', controls: d });
    await typeInto(d.note, 'weer');
    assert.equal(d.note.value, 'weer');
  }));

test('signing out forgets every unsent form on the device, and nothing else', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    for (const [user, name] of [[1, 'drive'], [2, 'fuel']] as const) {
      const c = threeControls();
      persistForm({ userId: user, name, controls: c });
      await typeInto(c.note, 'x');
    }
    localStorage.setItem('car:theme', 'dark');
    clearAllDrafts();
    assert.equal(localStorage.getItem(draftKey(1, 'drive')), null);
    assert.equal(localStorage.getItem(draftKey(2, 'fuel')), null);
    assert.equal(localStorage.getItem('car:theme'), 'dark', 'the theme is not an unsent form');
  }));

test('the notice above a restored form is Dutch and has a way to start over', () => {
  const notice = restoredNotice();
  assert.equal(notice.text, S.ui.unsaved);
  assert.equal(notice.clear, S.ui.unsavedClear);
});
