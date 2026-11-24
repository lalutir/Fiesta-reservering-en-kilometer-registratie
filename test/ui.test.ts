// The shared components (public/ui.js and public/icons.js): what they render, what they refuse, how they behave.
// The views are tested through their own screens; this is about the parts they are made of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../public/dom.js';
import { ICON_NAMES, icon } from '../public/icons.js';
import { S } from '../public/strings.js';
import { banner, button, confirmSheet, emptyState, errorState, iconButton, linkButton, listRow, overlayOpen, segmented, sheet, skeleton } from '../public/ui.js';
import { doc, withDom, type FakeElement } from './fake-dom.ts';

const el = (node: unknown) => node as FakeElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ icons

test('every icon is a 24-unit stroke drawing that takes the text colour, is hidden from screen readers and has shapes', () =>
  withDom(() => {
    assert.ok(ICON_NAMES.length >= 20, 'the set covers the app');
    for (const name of ICON_NAMES) {
      const svg = el(icon(name));
      assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg', name);
      assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
      assert.equal(svg.getAttribute('stroke'), 'currentColor');
      assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name} is decoration`);
      assert.equal(svg.getAttribute('focusable'), 'false');
      assert.ok(svg.children.length > 0, `${name} draws something`);
      assert.match(svg.getAttribute('class') ?? '', /^icon\b/);
    }
    assert.equal(el(icon('plus', 'big')).getAttribute('class'), 'icon big');
    assert.throws(() => icon('no-such-icon'), /unknown icon/);
  }));

// ------------------------------------------------------------------ buttons

test('a button has its label as text, a type, a variant class and runs its handler; an icon goes in front of the label', () =>
  withDom(async () => {
    let pressed = 0;
    const plain = el(button({ label: 'Opslaan', onclick: () => void pressed++ }));
    assert.equal(plain.tagName, 'button');
    assert.equal(plain.getAttribute('type'), 'button');
    assert.equal(plain.textContent, 'Opslaan');
    await plain.fire('click');
    assert.equal(pressed, 1);
    const primary = el(button({ label: 'Opslaan', variant: 'primary', type: 'submit', block: true, small: true }));
    assert.equal(primary.getAttribute('type'), 'submit');
    for (const c of ['btn', 'primary', 'block', 'small']) assert.ok(primary.classList.contains(c), c);
    const withIcon = el(button({ label: 'Boeken', icon: 'plus' }));
    assert.equal(withIcon.children.length, 2);
    assert.equal(el(withIcon.children[0]).tagName, 'svg');
    assert.equal(withIcon.textContent, 'Boeken');
    assert.equal(el(button({ label: 'x', disabled: true })).disabled, true);
  }));

test('a link button is a link with the look of a button', () =>
  withDom(() => {
    const link = el(linkButton({ label: 'Naar rit', href: '#/usage', variant: 'primary' }));
    assert.equal(link.tagName, 'a');
    assert.equal(link.getAttribute('href'), '#/usage');
    assert.ok(link.classList.contains('btn') && link.classList.contains('primary'));
  }));

test('an icon button cannot be made without a label: the label is its accessible name', () =>
  withDom(() => {
    assert.throws(() => iconButton({ label: '', icon: 'close' }), /needs a label/);
    assert.throws(() => iconButton({ label: '   ', icon: 'close' }), /needs a label/);
    const b = el(iconButton({ label: S.ui.close, icon: 'close' }));
    assert.equal(b.getAttribute('aria-label'), 'Sluiten');
    assert.equal(b.textContent, '', 'no text of its own, only the drawing');
    assert.ok(b.classList.contains('icon-btn'));
  }));

// ------------------------------------------------------------------ list row

test('a list row is a link, a button or plain, by what it was given, and shows a chevron only when it goes somewhere', () =>
  withDom(() => {
    const link = el(listRow({ title: 'Historie', sub: '12 ritten', href: '#/history', icon: 'history' }));
    assert.equal(link.tagName, 'a');
    assert.equal(link.getAttribute('href'), '#/history');
    assert.ok(link.querySelector('.row-chevron'));
    assert.equal(link.querySelector('.row-title')?.textContent, 'Historie');
    assert.equal(link.querySelector('.row-sub')?.textContent, '12 ritten');
    const act = el(listRow({ title: 'Uitloggen', onclick: () => {} }));
    assert.equal(act.tagName, 'button');
    assert.equal(act.getAttribute('type'), 'button');
    const plain = el(listRow({ title: 'Anna', sub: 'Rit', tone: 'warn' }));
    assert.equal(plain.tagName, 'div');
    assert.equal(plain.querySelector('.row-chevron'), null);
    assert.ok(plain.classList.contains('warn'));
  }));

// ------------------------------------------------------------------ sheet and confirm

test('a sheet is a dialog named by its title, in the page only while it is open, and onClose runs once however it closed', () =>
  withDom(async (dom) => {
    let closed = 0;
    const panel = sheet({ title: 'Nieuwe gebruiker', body: h('p', { text: 'Inhoud' }), footer: h('button', { type: 'button' }, 'Klaar'), onClose: () => void closed++ });
    assert.equal(overlayOpen(), false, 'not in the page before it is opened');
    panel.open();
    const dialog = el(panel.dialog);
    assert.equal(dialog.open, true);
    assert.equal(overlayOpen(), true);
    assert.equal(dialog.getAttribute('aria-labelledby'), dialog.querySelector('h2')?.id);
    assert.equal(dialog.querySelector('h2')?.textContent, 'Nieuwe gebruiker');
    assert.ok(dialog.querySelector('.sheet-foot'));
    const x = dialog.querySelector('.icon-btn');
    assert.equal(x?.getAttribute('aria-label'), 'Sluiten');
    await x?.fire('click');
    await tick();
    assert.equal(overlayOpen(), false, 'gone from the page when closed');
    assert.equal(closed, 1);
    panel.close();
    assert.equal(closed, 1, 'closing twice does not run onClose twice');
    // Escape and a tap on the backdrop are ways of closing too.
    const second = sheet({ title: 'Nog een', body: 'x', onClose: () => void closed++ });
    second.open();
    await dom.escape(el(second.dialog));
    await tick();
    assert.equal(closed, 2);
    const third = sheet({ title: 'En nog een', body: 'x', onClose: () => void closed++ });
    third.open();
    await el(third.dialog).fire('click', { target: third.dialog });
    await tick();
    assert.equal(closed, 3);
    const fourth = sheet({ title: 'Binnen', body: h('p', { id: 'inner' }, 'x'), onClose: () => void closed++ });
    fourth.open();
    await el(fourth.dialog).fire('click', { target: el(fourth.dialog).querySelector('#inner') });
    assert.equal(el(fourth.dialog).open, true, 'a tap inside the panel does not close it');
    fourth.close();
  }));

test('a drawer is a sheet with the drawer class, and the focus choice is honoured when it opens', () =>
  withDom(() => {
    const input = h('input', { type: 'text' }) as unknown as FakeElement;
    const panel = sheet({ title: 'Gebruiker', kind: 'drawer', body: input, focus: () => input });
    panel.open();
    assert.ok(el(panel.dialog).classList.contains('drawer'));
    assert.equal(doc().activeElement, input);
    panel.close();
  }));

test('a confirm sheet resolves true only on yes, false on no, on Escape and on closing, and puts focus on the safe answer', () =>
  withDom(async (dom) => {
    dom.autoAnswer = false;
    const ask = async (press: (dialog: FakeElement) => Promise<void> | void) => {
      const answer = confirmSheet('Reservering annuleren?', { confirmLabel: 'Ja, annuleren' });
      const dialog = dom.dialogs[dom.dialogs.length - 1] as FakeElement;
      assert.equal(dialog.querySelector('.sheet-message')?.textContent, 'Reservering annuleren?');
      assert.equal(dialog.querySelector('[data-answer="yes"]')?.textContent, 'Ja, annuleren');
      assert.equal(dialog.querySelector('[data-answer="no"]')?.textContent, S.cancel);
      assert.equal(doc().activeElement, dialog.querySelector('[data-answer="no"]'), 'the safe answer has focus');
      await press(dialog);
      return answer;
    };
    assert.equal(await ask((d) => d.querySelector('[data-answer="yes"]')?.fire('click') as unknown as void), true);
    assert.equal(await ask((d) => d.querySelector('[data-answer="no"]')?.fire('click') as unknown as void), false);
    assert.equal(await ask((d) => dom.escape(d)), false);
    assert.equal(await ask((d) => d.querySelector('.icon-btn')?.fire('click') as unknown as void), false);
    assert.equal(overlayOpen(), false);
  }));

test('a confirm sheet makes the yes button red unless danger is switched off, and records its question for the tests', () =>
  withDom(async (dom) => {
    const yes = confirmSheet('Verwijderen?');
    assert.ok(el(dom.dialogs[0]).querySelector('[data-answer="yes"]')?.className.includes('danger'));
    assert.equal(await yes, true, 'the fake page answers yes by default');
    const calm = confirmSheet('Doorgaan?', { danger: false });
    assert.ok(!el(dom.dialogs[1]).querySelector('[data-answer="yes"]')?.className.includes('danger'));
    await calm;
    assert.deepEqual(dom.confirms, ['Verwijderen?', 'Doorgaan?']);
  }));

test('the button that was pressed must be read BEFORE awaiting a confirm sheet: afterwards the event has no currentTarget', () =>
  withDom(async () => {
    const trigger = el(h('button', { type: 'button' }));
    const read: Array<string | null> = [];
    trigger.addEventListener('click', async (event) => {
      const before = event['currentTarget'] as FakeElement | null;
      await confirmSheet('Zeker?');
      read.push(before?.tagName ?? null, (event['currentTarget'] as FakeElement | null)?.tagName ?? null);
    });
    await trigger.fire('click');
    assert.deepEqual(read, ['button', null]);
  }));

// ------------------------------------------------------------------ segmented control

test('a segmented control presses exactly one button, reports a change once and can be set without reporting', () =>
  withDom(async () => {
    const changes: string[] = [];
    const control = segmented({
      label: 'Weergave',
      value: 'list',
      options: [
        { value: 'list', label: 'Lijst' },
        { value: 'day', label: 'Dag', name: 'Dagweergave' },
      ],
      onChange: (v) => void changes.push(v),
    });
    const root = el(control.el);
    assert.equal(root.getAttribute('role'), 'group');
    assert.equal(root.getAttribute('aria-label'), 'Weergave');
    const [list, day] = control.buttons as FakeElement[];
    assert.deepEqual([list?.getAttribute('aria-pressed'), day?.getAttribute('aria-pressed')], ['true', 'false']);
    assert.equal(day?.getAttribute('aria-label'), 'Dagweergave');
    await day?.fire('click');
    assert.deepEqual(changes, ['day']);
    assert.deepEqual([list?.getAttribute('aria-pressed'), day?.getAttribute('aria-pressed')], ['false', 'true']);
    await day?.fire('click');
    assert.deepEqual(changes, ['day'], 'pressing the pressed one again changes nothing');
    control.set('list');
    assert.equal(list?.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(changes, ['day']);
  }));

// ------------------------------------------------------------------ banner, empty, error, skeleton

test('a banner shows its tone by an icon and words, is an alert only when bad, and carries actions', () =>
  withDom(() => {
    const warn = el(banner({ tone: 'warn', title: 'Kilometers invullen', text: 'Twee ritten wachten.', actions: h('a', { href: '#/usage' }, 'Naar Ritten') }));
    assert.equal(warn.getAttribute('role'), 'status');
    assert.ok(warn.classList.contains('banner') && warn.classList.contains('warn'));
    assert.ok(warn.querySelector('.banner-icon'));
    assert.equal(warn.querySelector('h3')?.textContent, 'Kilometers invullen');
    assert.ok(warn.querySelector('.actions a'));
    assert.equal(el(banner({ tone: 'bad', text: 'Mislukt' })).getAttribute('role'), 'alert');
    assert.ok(el(banner({ text: 'Standaard' })).classList.contains('warn'), 'warn is the default tone');
  }));

test('an empty state says why it is empty and offers what to do; an error state says what failed and retries', () =>
  withDom(async () => {
    const empty = el(emptyState({ title: 'Nog niets', text: 'Je hebt nog geen ritten.', action: linkButton({ label: 'Rit toevoegen', href: '#/usage' }) }));
    assert.equal(empty.textContent, 'Nog nietsJe hebt nog geen ritten.Rit toevoegen');
    let retried = 0;
    const failed = el(errorState('Laden is niet gelukt.', () => void retried++));
    assert.equal(failed.getAttribute('role'), 'alert');
    const retry = failed.querySelector('button');
    assert.equal(retry?.textContent, S.retry);
    await retry?.fire('click');
    assert.equal(retried, 1);
  }));

test('a skeleton says "Laden…" to a screen reader and draws the requested number of hidden rows', () =>
  withDom(() => {
    const s = el(skeleton(4));
    assert.equal(s.querySelector('.sr-only')?.textContent, S.loading);
    const rows = s.querySelectorAll('.skel-row');
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.getAttribute('aria-hidden') === 'true'));
    assert.equal(el(skeleton()).querySelectorAll('.skel-row').length, 3);
  }));
