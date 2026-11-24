// The fake DOM is test equipment, and the view tests lean on it for things a real browser does: a <dialog> that
// traps and returns focus, an event whose currentTarget is gone after the first await, storage that throws, a window
// whose media queries a test can flip. These tests keep the equipment honest, so a view test that passes does so
// because the view is right and not because the fake is too forgiving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../public/dom.js';
import { doc, installFakeDom, win, type FakeElement } from './fake-dom.ts';

function withDom(fn: (dom: ReturnType<typeof installFakeDom>) => Promise<void> | void) {
  return async () => {
    const dom = installFakeDom();
    try {
      await fn(dom);
    } finally {
      dom.uninstall();
    }
  };
}

test('createElementNS makes an element that keeps its namespace and takes its class through the attribute', withDom(() => {
  const svg = doc().createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as FakeElement;
  svg.setAttribute('class', 'icon big');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('class'), 'icon big');
  assert.equal(svg.className, 'icon big');
  assert.ok(svg.classList.contains('big'));
}));

test('an event handler loses event.currentTarget after its first await, as in a browser', withDom(async () => {
  const button = h('button', { type: 'button' }) as unknown as FakeElement;
  const seen: Array<unknown> = [];
  button.addEventListener('click', async (event) => {
    seen.push(event['currentTarget'] === button);
    await Promise.resolve();
    seen.push(event['currentTarget']);
  });
  await button.fire('click');
  assert.deepEqual(seen, [true, null], 'readable while the handler runs synchronously, null afterwards');
}));

test('a dialog opens with showModal, remembers what had focus and gives it back on close, and says it closed', withDom((dom) => {
  const opener = h('button', { type: 'button' }) as unknown as FakeElement;
  dom.mount(opener);
  opener.focus();
  const dialog = h('dialog', {}, h('p', { text: 'Hallo' })) as unknown as FakeElement;
  dom.mount(dialog);
  const events: string[] = [];
  dialog.addEventListener('close', () => events.push('close'));
  dialog.showModal();
  assert.equal(dialog.open, true);
  assert.deepEqual(dom.dialogs, [dialog]);
  const inside = dialog.querySelector('p') as FakeElement;
  inside.focus();
  dialog.close('klaar');
  assert.equal(dialog.open, false);
  assert.equal(dialog.returnValue, 'klaar');
  assert.equal(doc().activeElement, opener, 'focus returns to the element that had it before the dialog');
  return Promise.resolve().then(() => assert.deepEqual(events, ['close']));
}));

test('Escape on a dialog is a cancel event first, and the dialog stays open when that was prevented', withDom(async (dom) => {
  const dialog = h('dialog') as unknown as FakeElement;
  dom.mount(dialog);
  dialog.showModal();
  dialog.addEventListener('cancel', (event) => event['preventDefault']());
  await dom.escape(dialog);
  assert.equal(dialog.open, true);
  const second = h('dialog') as unknown as FakeElement;
  dom.mount(second);
  second.showModal();
  await dom.escape(second);
  assert.equal(second.open, false);
}));

test('a confirm sheet (a dialog with data-answer buttons) is answered by the test: yes by default, no on request, and the question is recorded', withDom(async (dom) => {
  const build = () => {
    const yes = h('button', { 'data-answer': 'yes', type: 'button', onclick: () => dialog.close('yes') }, 'Ja');
    const no = h('button', { 'data-answer': 'no', type: 'button', onclick: () => dialog.close('no') }, 'Nee');
    const dialog = h('dialog', {}, [h('p', { class: 'sheet-message', text: 'Verwijderen?' }), no, yes]) as unknown as FakeElement;
    dom.mount(dialog);
    return dialog;
  };
  const first = build();
  first.showModal();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(first.returnValue, 'yes');
  dom.answer = false;
  const second = build();
  second.showModal();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(second.returnValue, 'no');
  assert.deepEqual(dom.confirms, ['Verwijderen?', 'Verwijderen?']);
  dom.answer = true;
  dom.autoAnswer = false;
  const third = build();
  third.showModal();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(third.open, true, 'with autoAnswer off the sheet waits for the test to press a button');
}));

test('localStorage works, can be blocked (every access throws) and can be full (writes throw)', withDom((dom) => {
  localStorage.setItem('a', '1');
  assert.equal(localStorage.getItem('a'), '1');
  assert.equal(localStorage.length, 1);
  dom.storage.full = true;
  assert.throws(() => localStorage.setItem('b', '2'));
  assert.equal(localStorage.getItem('a'), '1', 'reading still works when full');
  dom.storage.full = false;
  dom.storage.blocked = true;
  assert.throws(() => localStorage.getItem('a'));
  assert.throws(() => localStorage.length);
}));

test('the window keeps listeners, answers media queries a test can flip, and tells a listener when one changes', withDom((dom) => {
  const seen: string[] = [];
  const onHide = () => seen.push('pagehide');
  win().addEventListener('pagehide', onHide);
  dom.window.emit('pagehide');
  win().removeEventListener('pagehide', onHide);
  dom.window.emit('pagehide');
  assert.deepEqual(seen, ['pagehide'], 'a removed listener is not called');
  const query = win().matchMedia('(prefers-color-scheme: dark)');
  assert.equal(query.matches, false);
  const changes: boolean[] = [];
  query.addEventListener('change', (event: { matches: boolean }) => changes.push(event.matches));
  dom.window.setMedia('(prefers-color-scheme: dark)', true);
  assert.equal(win().matchMedia('(prefers-color-scheme: dark)').matches, true);
  assert.deepEqual(changes, [true]);
}));

test('the document can be hidden and tells its listeners (the page going to the background)', withDom((dom) => {
  const seen: boolean[] = [];
  doc().addEventListener('visibilitychange', () => seen.push(doc().hidden));
  dom.setHidden(true);
  dom.emitDocument('visibilitychange');
  assert.deepEqual(seen, [true]);
}));

test('documentElement and head exist, so a theme can be put on <html> and in a <meta>', withDom(() => {
  assert.ok(doc().documentElement);
  doc().documentElement.setAttribute('data-theme', 'dark');
  assert.equal(doc().documentElement.getAttribute('data-theme'), 'dark');
  const meta = h('meta', { name: 'theme-color', content: '#fff' }) as unknown as FakeElement;
  doc().head.appendChild(meta);
  assert.equal(doc().querySelectorAll('meta[name="theme-color"]').length, 1);
}));
