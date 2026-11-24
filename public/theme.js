// The theme: follow the phone (Systeem, the default), or always Licht, or always Donker. The choice is kept on this
// device (storage.js) and shown as data-theme on <html>; the style sheet has the colours of both themes under it
// and follows prefers-color-scheme when there is no data-theme. The theme-color meta (the colour of the phone's
// status bar) is kept in step. public/theme-init.js does the first paint; this module does the rest.
import { h } from './dom.js';
import { S } from './strings.js';
import { storageGet, storageSet } from './storage.js';
import { segmented } from './ui.js';

export const THEME_KEY = 'car:theme';
/** @typedef {'system' | 'light' | 'dark'} ThemeChoice */
/** @type {ThemeChoice[]} */
export const THEME_CHOICES = ['system', 'light', 'dark'];
/** The page colour of each theme: what the status bar should be (tokens --bg in public/style.css). */
export const THEME_COLORS = { light: '#f6f3ee', dark: '#14130f' };

/** @returns {ThemeChoice} */
export function readTheme() {
  const stored = storageGet(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * Show a theme choice on the page: data-theme on <html> (none for the system theme) and the status bar colour.
 * @param {ThemeChoice} choice
 */
export function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    // The page ships two metas (one per colour scheme); remember what they said, so the system theme can restore it.
    if (!meta.hasAttribute('data-system')) meta.setAttribute('data-system', meta.getAttribute('content') ?? '');
    meta.setAttribute('content', choice === 'system' ? (meta.getAttribute('data-system') ?? '') : THEME_COLORS[choice]);
  }
}

/**
 * Keep a choice on this device and show it. A device that cannot store it still shows it until the page closes.
 * @param {ThemeChoice} choice
 * @returns {boolean} whether it was stored
 */
export function saveTheme(choice) {
  applyTheme(choice);
  return storageSet(THEME_KEY, choice);
}

/** Apply the stored choice (the first paint was done by theme-init.js; this makes the rest of the page agree). */
export function initTheme() {
  applyTheme(readTheme());
}

/**
 * The Systeem / Licht / Donker choice as a segmented control: it applies at once, and says so when this device cannot keep it.
 * @param {(message: string, isError?: boolean) => void} toast
 * @returns {HTMLElement}
 */
export function themeControl(toast) {
  const control = segmented({
    label: S.theme.label,
    value: readTheme(),
    options: THEME_CHOICES.map((value) => ({ value, label: S.theme[value] })),
    onChange: (value) => {
      if (!saveTheme(/** @type {ThemeChoice} */ (value))) toast(S.theme.notSaved);
    },
  });
  return control.el;
}

/**
 * The card with the choice, its name and a line of explanation (the page Meer and the Account page).
 * @param {(message: string, isError?: boolean) => void} toast
 * @returns {HTMLElement}
 */
export function themeCard(toast) {
  return h('section', { class: 'card theme-card' }, [h('h3', { text: S.theme.label }), themeControl(toast), h('p', { class: 'hint', text: S.theme.hint })]);
}
