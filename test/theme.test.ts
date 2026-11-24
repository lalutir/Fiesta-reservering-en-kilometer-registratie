// The theme choice (Systeem, Licht, Donker): what is stored, what is put on <html> and in the theme-color meta,
// what happens when storage is blocked, and that the tiny first-paint script agrees with the module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { h } from '../public/dom.js';
import { storageGet, storageKeys, storageRemove, storageSet } from '../public/storage.js';
import { THEME_CHOICES, THEME_COLORS, THEME_KEY, applyTheme, initTheme, readTheme, saveTheme } from '../public/theme.js';
import { doc, withDom, type FakeElement } from './fake-dom.ts';

const publicDir = path.join(import.meta.dirname, '..', 'public');

/** The two theme-color metas the page ships: one per colour scheme. */
function addMetas(): FakeElement[] {
  const metas = [
    h('meta', { name: 'theme-color', content: '#f6f3ee', media: '(prefers-color-scheme: light)' }),
    h('meta', { name: 'theme-color', content: '#14130f', media: '(prefers-color-scheme: dark)' }),
  ] as unknown as FakeElement[];
  for (const m of metas) doc().head.appendChild(m);
  return metas;
}

test('there are three choices and the system theme is the default', () =>
  withDom(() => {
    assert.deepEqual(THEME_CHOICES, ['system', 'light', 'dark']);
    assert.equal(readTheme(), 'system');
  }));

test('a stored choice is read back; anything else is the system theme', () =>
  withDom(() => {
    localStorage.setItem(THEME_KEY, 'dark');
    assert.equal(readTheme(), 'dark');
    localStorage.setItem(THEME_KEY, 'light');
    assert.equal(readTheme(), 'light');
    localStorage.setItem(THEME_KEY, 'purple');
    assert.equal(readTheme(), 'system');
  }));

test('Licht and Donker put data-theme on <html> and their colour in both theme-color metas; Systeem takes both away again', () =>
  withDom(() => {
    const metas = addMetas();
    applyTheme('dark');
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'dark');
    assert.deepEqual(metas.map((m) => m.getAttribute('content')), [THEME_COLORS.dark, THEME_COLORS.dark]);
    applyTheme('light');
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'light');
    assert.deepEqual(metas.map((m) => m.getAttribute('content')), [THEME_COLORS.light, THEME_COLORS.light]);
    applyTheme('system');
    assert.equal(doc().documentElement.getAttribute('data-theme'), null);
    assert.deepEqual(metas.map((m) => m.getAttribute('content')), ['#f6f3ee', '#14130f'], 'each meta has its own colour back');
  }));

test('saving a choice applies it, keeps it, and reports when it could not be kept', () =>
  withDom((dom) => {
    addMetas();
    assert.equal(saveTheme('dark'), true);
    assert.equal(localStorage.getItem(THEME_KEY), 'dark');
    dom.storage.blocked = true;
    assert.equal(saveTheme('light'), false, 'blocked storage: not kept');
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'light', 'but shown until the page closes');
    assert.equal(readTheme(), 'system', 'and reading never throws');
    dom.storage.blocked = false;
    dom.storage.full = true;
    assert.equal(saveTheme('dark'), false);
  }));

test('initTheme applies what is stored, and does nothing when nothing is', () =>
  withDom(() => {
    addMetas();
    initTheme();
    assert.equal(doc().documentElement.getAttribute('data-theme'), null);
    localStorage.setItem(THEME_KEY, 'dark');
    initTheme();
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'dark');
  }));

test('the first-paint script and the module agree on the key and the colours, and the script survives blocked storage', async () => {
  const source = fs.readFileSync(path.join(publicDir, 'theme-init.js'), 'utf8');
  assert.ok(source.includes(`'${THEME_KEY}'`), 'same storage key');
  assert.ok(source.includes(`'${THEME_COLORS.dark}'`) && source.includes(`'${THEME_COLORS.light}'`), 'same colours');
  // Run it the way the browser does: a classic script with no imports.
  await withDom((dom) => {
    const metas = addMetas();
    localStorage.setItem(THEME_KEY, 'dark');
    vm.runInNewContext(source, { document: doc(), localStorage });
    assert.equal(doc().documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(metas[0]?.getAttribute('content'), THEME_COLORS.dark);
    doc().documentElement.removeAttribute('data-theme');
    dom.storage.blocked = true;
    assert.doesNotThrow(() => vm.runInNewContext(source, { document: doc(), get localStorage() { return localStorage; } }));
    assert.equal(doc().documentElement.getAttribute('data-theme'), null, 'blocked storage: the system theme');
  });
});

test('the page ships a light and a dark theme-color and the colours are the paper and ink tokens of the style sheet', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.ok(html.includes(`<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)"`));
  assert.ok(html.includes(`<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)"`));
  assert.ok(css.includes(`--bg: ${THEME_COLORS.light};`), 'the light page colour is the --bg token');
  assert.ok(css.includes(`--bg: ${THEME_COLORS.dark};`), 'the dark page colour is the --bg token');
});

// ------------------------------------------------------------------ storage

test('storage: a read that fails is "nothing stored", a write that fails is "not saved", and nothing ever throws', () =>
  withDom((dom) => {
    assert.equal(storageSet('k', 'v'), true);
    assert.equal(storageGet('k'), 'v');
    assert.equal(storageSet('draft:1', 'a'), true);
    assert.deepEqual(storageKeys('draft:'), ['draft:1']);
    storageRemove('k');
    assert.equal(storageGet('k'), null);
    dom.storage.blocked = true;
    assert.equal(storageGet('draft:1'), null);
    assert.equal(storageSet('x', 'y'), false);
    assert.doesNotThrow(() => storageRemove('draft:1'));
    assert.deepEqual(storageKeys(
'draft:'), []);
  }));
