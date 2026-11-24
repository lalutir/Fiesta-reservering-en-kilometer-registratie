// The parts every screen is made of, written once: button, link button, icon button, list row, sheet and drawer,
// the confirm question, segmented control, banner, empty state, error state and skeleton. (The toast lives in
// dom.js next to the toaster; the form field, with its label, hint and error message, is field() in dom.js.)
//
// The rules that make these worth sharing:
//  - A control has a visible text or, for an icon button, a label that this module requires (an icon alone is not a name).
//  - A sheet or drawer is a native <dialog> opened with showModal(): the browser traps focus inside it, closes it on
//    Escape and gives focus back to what opened it. It is only in the page while it is open, so overlayOpen() is
//    simply "is there a dialog".
//  - A question about something that cannot be undone, or that tells other people, is asked in a confirm sheet
//    (confirmSheet resolves true or false). Nothing in the app calls window.confirm, alert or prompt.
//  - There is no sizing or position set from script: every look is a class in style.css (the CSP forbids inline styles).
import { h } from './dom.js';
import { icon } from './icons.js';
import { S } from './strings.js';

/** @typedef {'primary' | 'secondary' | 'danger' | 'ghost'} ButtonVariant */

/**
 * @param {ButtonVariant} variant
 * @param {{ small?: boolean, block?: boolean, extra?: string }} o
 */
function buttonClass(variant, o) {
  return ['btn', variant === 'secondary' ? '' : variant, o.small ? 'small' : '', o.block ? 'block' : '', o.extra ?? ''].filter(Boolean).join(' ');
}

/**
 * What stands inside a button or a link that looks like one: the text, or an icon and the text.
 * @param {{ label: string, icon?: string }} o
 */
function buttonContent(o) {
  return [o.icon ? icon(o.icon) : null, o.icon ? h('span', { class: 'btn-label', text: o.label }) : o.label];
}

/**
 * A button with a text label (and optionally an icon before it).
 * @param {object} o
 * @param {string} o.label
 * @param {(event: Event) => unknown} [o.onclick]
 * @param {ButtonVariant} [o.variant]
 * @param {boolean} [o.small]
 * @param {boolean} [o.block] full width
 * @param {string} [o.icon] an icon name (icons.js)
 * @param {boolean} [o.disabled]
 * @param {'button' | 'submit'} [o.type]
 * @param {Record<string, string>} [o.attrs] extra attributes (aria-*, data-*)
 */
export function button(o) {
  return h('button', { class: buttonClass(o.variant ?? 'secondary', o), type: o.type ?? 'button', disabled: o.disabled, onclick: o.onclick, ...o.attrs }, buttonContent(o));
}

/**
 * A link that looks like a button (it navigates; a button acts).
 * @param {object} o
 * @param {string} o.label
 * @param {string} o.href
 * @param {ButtonVariant} [o.variant]
 * @param {boolean} [o.small]
 * @param {boolean} [o.block]
 * @param {string} [o.icon]
 * @param {Record<string, string>} [o.attrs] extra attributes (aria-*, target)
 */
export function linkButton(o) {
  return h('a', { class: buttonClass(o.variant ?? 'secondary', o), href: o.href, ...o.attrs }, buttonContent(o));
}

/**
 * A button with only an icon. It cannot be made without a label: that label is its accessible name.
 * @param {object} o
 * @param {string} o.label
 * @param {string} o.icon
 * @param {(event: Event) => unknown} [o.onclick]
 * @param {ButtonVariant} [o.variant]
 */
export function iconButton(o) {
  if (!o.label || o.label.trim() === '') throw new Error('an icon button needs a label');
  return h('button', { class: buttonClass(o.variant ?? 'ghost', { extra: 'icon-btn' }), type: 'button', 'aria-label': o.label, onclick: o.onclick }, icon(o.icon));
}

/**
 * One row of a list: an optional icon, a title with a line under it, something at the end, and a chevron when the
 * row goes somewhere. A row with `href` is a link, with `onclick` a button, otherwise plain.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.sub]
 * @param {unknown} [o.trailing] what stands at the end (a count, a status)
 * @param {string} [o.href]
 * @param {(event: Event) => unknown} [o.onclick]
 * @param {string} [o.icon]
 * @param {string} [o.tone] 'warn' | 'bad' | 'ok': a marker class, always with words as well
 */
export function listRow(o) {
  const go = o.href !== undefined || o.onclick !== undefined;
  const children = [
    o.icon ? h('span', { class: 'row-icon' }, icon(o.icon)) : null,
    h('span', { class: 'row-main' }, [h('span', { class: 'row-title', text: o.title }), o.sub ? h('span', { class: 'row-sub', text: o.sub }) : null]),
    o.trailing ?? null,
    go ? icon('chevron-right', 'row-chevron') : null,
  ];
  const cls = `list-row${o.tone ? ` ${o.tone}` : ''}`;
  if (o.href !== undefined) return h('a', { class: cls, href: o.href }, children);
  if (o.onclick) return h('button', { class: cls, type: 'button', onclick: o.onclick }, children);
  return h('div', { class: cls }, children);
}

let sheetSeq = 0;

/** Is a sheet, drawer or confirm question open? (The 60-second refresh leaves the page alone while one is.) */
export function overlayOpen() {
  return document.body.querySelector('dialog') !== null;
}

/**
 * A panel over the page: a bottom sheet on a phone, a centred dialog on a tablet, a side drawer when kind is 'drawer'.
 * It is added to the page by open() and removed when it closes; onClose runs once, however it was closed.
 * @param {object} o
 * @param {string} o.title
 * @param {unknown} o.body
 * @param {unknown} [o.footer] the buttons at the bottom
 * @param {'sheet' | 'drawer'} [o.kind]
 * @param {() => void} [o.onClose]
 * @param {() => HTMLElement | null} [o.focus] what takes focus when it opens (default: the browser's choice)
 */
export function sheet(o) {
  const titleId = `sheet-title-${++sheetSeq}`;
  let finished = false;
  const dialog = h('dialog', { class: o.kind === 'drawer' ? 'sheet drawer' : 'sheet', 'aria-labelledby': titleId }, [
    h('header', { class: 'sheet-head' }, [h('h2', { id: titleId, class: 'sheet-title', text: o.title }), iconButton({ label: S.ui.close, icon: 'close', onclick: () => close() })]),
    h('div', { class: 'sheet-body' }, o.body),
    o.footer ? h('footer', { class: 'sheet-foot' }, o.footer) : null,
  ]);
  const body = /** @type {HTMLElement} */ (dialog.querySelector('.sheet-body'));
  function finish() {
    if (finished) return;
    finished = true;
    dialog.remove();
    o.onClose?.();
  }
  function close() {
    if (dialog.open) dialog.close();
    else finish();
  }
  // The browser reports every way of closing (Escape, a button, the backdrop) as a close event.
  dialog.addEventListener('close', finish);
  // A tap on the dimmed area outside the panel lands on the dialog itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  return {
    dialog,
    body,
    close,
    open() {
      document.body.appendChild(dialog);
      dialog.showModal();
      o.focus?.()?.focus();
    },
  };
}

/**
 * Ask a question that can be answered yes or no, in a sheet. Resolves true only when the person says yes.
 * Read what you need from the event (the button that was pressed) BEFORE awaiting this: in a browser
 * event.currentTarget is gone after the first await.
 * @param {string} message
 * @param {{ confirmLabel?: string, cancelLabel?: string, title?: string, danger?: boolean }} [opts] danger (default true) makes the yes button red
 * @returns {Promise<boolean>}
 */
export function confirmSheet(message, opts = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const no = button({ label: opts.cancelLabel ?? S.cancel, attrs: { 'data-answer': 'no' }, onclick: () => panel.close() });
    const yes = button({
      label: opts.confirmLabel ?? S.ui.confirm,
      variant: opts.danger === false ? 'primary' : 'danger',
      attrs: { 'data-answer': 'yes' },
      onclick: () => {
        answer = true;
        panel.close();
      },
    });
    const panel = sheet({
      title: opts.title ?? S.ui.confirmTitle,
      body: h('p', { class: 'sheet-message', text: message }),
      footer: [no, yes],
      onClose: () => resolve(answer),
      // The safe answer takes focus: Enter or a stray tap does not destroy anything.
      focus: () => no,
    });
    panel.open();
  });
}

/**
 * A row of buttons of which exactly one is pressed (aria-pressed), for a choice between a few views or options.
 * @param {object} o
 * @param {string} o.label the name of the group
 * @param {Array<{ value: string, label: string, name?: string }>} o.options name = a longer accessible name
 * @param {string} o.value
 * @param {(value: string) => void} o.onChange
 * @param {string} [o.extraClass]
 */
export function segmented(o) {
  let value = o.value;
  const buttons = o.options.map((option) =>
    h('button', { class: 'btn seg', type: 'button', 'aria-pressed': String(option.value === value), 'aria-label': option.name, onclick: () => select(option.value) }, option.label),
  );
  const el = h('div', { class: `segmented${o.extraClass ? ` ${o.extraClass}` : ''}`, role: 'group', 'aria-label': o.label }, buttons);
  /** @param {string} next */
  function show(next) {
    value = next;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(o.options[i]?.value === next)));
  }
  /** @param {string} next */
  function select(next) {
    if (next === value) return;
    show(next);
    o.onChange(next);
  }
  return { el, set: show, buttons };
}

/** @type {Record<string, string>} */
const BANNER_ICON = { info: 'info', ok: 'check-circle', warn: 'alert', bad: 'alert-circle' };

/**
 * A message above the content. The tone is shown by an icon and the words, never by colour alone.
 * @param {object} o
 * @param {'info' | 'ok' | 'warn' | 'bad'} [o.tone]
 * @param {string} [o.title]
 * @param {unknown} [o.text]
 * @param {unknown} [o.actions]
 * @param {string} [o.extraClass]
 */
export function banner(o) {
  const tone = o.tone ?? 'warn';
  return h('section', { class: `banner ${tone}${o.extraClass ? ` ${o.extraClass}` : ''}`, role: tone === 'bad' ? 'alert' : 'status' }, [
    icon(BANNER_ICON[tone] ?? 'info', 'banner-icon'),
    h('div', { class: 'banner-body' }, [o.title ? h('h3', { text: o.title }) : null, typeof o.text === 'string' ? h('p', { text: o.text }) : o.text, o.actions ? h('div', { class: 'actions' }, o.actions) : null]),
  ]);
}

/**
 * Nothing here yet: one sentence that says why and, when there is one, what to do about it.
 * @param {object} o
 * @param {string} o.text
 * @param {string} [o.title]
 * @param {unknown} [o.action] a button or link
 */
export function emptyState(o) {
  return h('div', { class: 'empty', role: 'status' }, [o.title ? h('strong', { class: 'empty-title', text: o.title }) : null, h('p', { text: o.text }), o.action ?? null]);
}

/**
 * The request failed: say so in words and offer to try again.
 * @param {string} text
 * @param {() => void} onRetry
 */
export function errorState(text, onRetry) {
  return h('div', { class: 'card error-card', role: 'alert' }, [h('p', { text }), button({ label: S.retry, onclick: () => onRetry() })]);
}

/**
 * A grey outline of what is loading, with the words "Laden…" for a screen reader.
 * @param {number} [rows]
 */
export function skeleton(rows = 3) {
  return h('div', { class: 'skeleton', role: 'status' }, [
    h('span', { class: 'sr-only', text: S.loading }),
    Array.from({ length: rows }, () => h('div', { class: 'skel-row', 'aria-hidden': 'true' })),
  ]);
}
