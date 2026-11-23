// Safe DOM construction (text only, never innerHTML) and display helpers.
// The time helpers come from the same file the server uses (/shared/time.js).
import { addDateKeyYears, daysBetween, formatDateKey, formatLocal, isCalendarDate, localDateKey, localInputToUtc, utcToLocalInput } from '../shared/time.js';
import { formatCentsInput, formatEuro, formatLitres, formatPrice } from '../shared/format.js';
import { S, errorText, fieldErrorText } from './strings.js';

export { addDateKeyYears, daysBetween, formatDateKey, formatLocal, isCalendarDate, localDateKey, localInputToUtc, utcToLocalInput };
// Amounts, litres and kilometres are written by one module, the same one the server uses (/shared/format.js).
export { formatCentsInput, formatEuro, formatLitres, formatPrice };

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'required', 'readOnly', 'multiple']);

/**
 * Build an element. Props: `class`, `text`, `onclick`-style listeners, DOM
 * properties (value, checked, disabled, ...) and plain attributes. Children may
 * be nodes, strings, numbers, arrays of those, or falsy (skipped). Content is
 * always inserted as text, so user data can never become markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  /** @type {Array<[string, unknown]>} */
  const late = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (key === 'value') late.push([key, value]); // after <option> children exist
    else if (PROPERTY_KEYS.has(key)) Reflect.set(el, key, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  for (const [key, value] of late) Reflect.set(el, key, value);
  return el;
}

/**
 * @param {Node} parent
 * @param {unknown[]} children
 */
function append(parent, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Replace all children of an element.
 * @param {Element} el
 * @param {...unknown} children
 */
export function setContent(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/**
 * "Sat, 20 Nov 09:00 - 13:00" on one local day, otherwise both ends in full.
 * @param {string} startIso
 * @param {string} endIso
 * @param {string} tz
 */
export function fmtRange(startIso, endIso, tz) {
  if (localDateKey(startIso, tz) === localDateKey(endIso, tz)) {
    return `${formatLocal(startIso, tz, 'day')}, ${formatLocal(startIso, tz, 'time')} – ${formatLocal(endIso, tz, 'time')}`;
  }
  return `${formatLocal(startIso, tz, 'datetime')} – ${formatLocal(endIso, tz, 'datetime')}`;
}

/**
 * Like fmtRange for a drive: a draft has no end yet and shows when it started.
 * @param {string} startIso
 * @param {string | null} endIso null while the drive is still open
 * @param {string} tz
 */
export function fmtDriveRange(startIso, endIso, tz) {
  if (endIso === null) return S.usage.started(fmtWhen(startIso, tz));
  return fmtRange(startIso, endIso, tz);
}

/**
 * "Sat, 20 Nov 09:00": one moment, day and time.
 * @param {string} iso
 * @param {string} tz
 */
export function fmtWhen(iso, tz) {
  return `${formatLocal(iso, tz, 'day')}, ${formatLocal(iso, tz, 'time')}`;
}

/**
 * Group items by the local calendar day of their start, keeping their order.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} startOf
 * @param {string} tz
 * @returns {Array<{key: string, label: string, items: T[]}>}
 */
export function groupByDay(items, startOf, tz) {
  /** @type {Array<{key: string, label: string, items: T[]}>} */
  const groups = [];
  for (const item of items) {
    const iso = startOf(item);
    const key = localDateKey(iso, tz);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: formatLocal(iso, tz, 'day'), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * Disable (or re-enable) every button inside a container while a request runs,
 * so a double tap cannot send the same action twice.
 * @param {Element} container
 * @param {boolean} busy
 */
export function setBusy(container, busy) {
  for (const button of container.querySelectorAll('button')) button.disabled = busy;
}

let fieldSeq = 0;

/**
 * @typedef {object} Field
 * @property {HTMLElement} row
 * @property {(code: string | null | undefined) => void} setError show a validation code (or clear with null)
 */

/**
 * Tell assistive technology which controls are invalid and where the message is.
 * @param {HTMLElement[]} controls
 * @param {boolean} invalid
 * @param {string[]} describedBy ids of the hint (if any) and of the error message
 */
function markInvalid(controls, invalid, describedBy) {
  for (const control of controls) {
    if (invalid) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    if (describedBy.length > 0) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
  }
}

/**
 * A labelled form control with a place for its error message. The label and the hint can be
 * changed afterwards (the note says "required" once the kilometres are not the driver's own).
 * @param {string} label
 * @param {HTMLElement} control
 * @param {string} [hint]
 * @returns {Field & { setLabel: (text: string) => void, setHint: (text: string) => void }}
 */
export function field(label, control, hint) {
  if (!control.id) control.id = `field-${++fieldSeq}`;
  const hintId = `${control.id}-hint`;
  const errorId = `${control.id}-error`;
  const error = h('span', { class: 'field-error', role: 'alert', id: errorId });
  const labelEl = h('label', { for: control.id, text: label });
  const hintEl = hint ? h('small', { class: 'hint', id: hintId, text: hint }) : null;
  const row = h('div', { class: 'field' }, [labelEl, control, hintEl, error]);
  const baseline = hint ? [hintId] : [];
  markInvalid([control], false, baseline);
  return {
    row,
    setError: (code) => {
      error.textContent = code ? fieldErrorText(code) : '';
      row.classList.toggle('invalid', !!code);
      markInvalid([control], !!code, code ? [...baseline, errorId] : baseline);
    },
    setLabel: (text) => {
      labelEl.textContent = text;
    },
    setHint: (text) => {
      if (hintEl) hintEl.textContent = text;
    },
  };
}

/**
 * A date input and a time input that together mean one instant in the
 * household zone (so the phone's own time zone never matters).
 * @param {string} label
 * @param {string | null} iso initial instant (UTC ISO) or null for empty
 * @param {string} tz
 * @param {{ optional?: boolean, hint?: string }} [opts] optional = may be left empty (isEmpty() tells)
 * @returns {Field & { getIso: () => string | null, setIso: (iso: string) => void, isEmpty: () => boolean, onInput: (fn: () => void) => void }}
 */
export function dateTimeField(label, iso, tz, opts = {}) {
  const required = !opts.optional;
  const date = h('input', { type: 'date', required, 'aria-label': `${label}: ${S.reserve.date}` });
  const time = h('input', { type: 'time', required, step: '60', 'aria-label': `${label}: ${S.reserve.time}` });
  /** @param {string} value */
  const setIso = (value) => {
    const parts = utcToLocalInput(value, tz);
    date.value = parts.date;
    time.value = parts.time;
  };
  if (iso) setIso(iso);
  const errorId = `field-${++fieldSeq}-error`;
  const hintId = `field-${++fieldSeq}-hint`;
  const error = h('span', { class: 'field-error', role: 'alert', id: errorId });
  const row = h('div', { class: 'field' }, [
    h('span', { class: 'label', text: label }),
    h('div', { class: 'pair' }, [date, time]),
    opts.hint ? h('small', { class: 'hint', id: hintId, text: opts.hint }) : null,
    error,
  ]);
  const baseline = opts.hint ? [hintId] : [];
  markInvalid([date, time], false, baseline);
  return {
    row,
    setError: (code) => {
      error.textContent = code ? fieldErrorText(code) : '';
      row.classList.toggle('invalid', !!code);
      markInvalid([date, time], !!code, code ? [...baseline, errorId] : baseline);
    },
    getIso: () => localInputToUtc(date.value, time.value, tz),
    setIso,
    isEmpty: () => date.value === '' && time.value === '',
    onInput: (fn) => {
      date.addEventListener('input', fn);
      time.addEventListener('input', fn);
    },
  };
}

/**
 * Read a start/end pair of date-time fields. A field that does not hold a valid
 * date and time is marked, and the result is then null.
 * @param {ReturnType<typeof dateTimeField>} start
 * @param {ReturnType<typeof dateTimeField>} end
 * @returns {{ start: string, end: string } | null}
 */
export function readRange(start, end) {
  const startIso = start.getIso();
  const endIso = end.getIso();
  if (!startIso) start.setError('invalid_datetime');
  if (!endIso) end.setError('invalid_datetime');
  return startIso && endIso ? { start: startIso, end: endIso } : null;
}

/**
 * Read the start and the optional end of a drive. A start that is not a valid
 * date and time is marked; so is an end that is only half filled in. An empty
 * end is fine (end: null, the drive is still open).
 * @param {ReturnType<typeof dateTimeField>} start
 * @param {ReturnType<typeof dateTimeField>} end
 * @returns {{ start: string, end: string | null } | null}
 */
export function readDriveTimes(start, end) {
  const startIso = start.getIso();
  if (!startIso) start.setError('invalid_datetime');
  let endIso = null;
  let endBad = false;
  if (!end.isEmpty()) {
    endIso = end.getIso();
    if (!endIso) {
      end.setError('invalid_datetime');
      endBad = true;
    }
  }
  return startIso && !endBad ? { start: startIso, end: endIso } : null;
}

/**
 * The request body for saving a drive from what the form holds, and the
 * kilometre obligation on the client side (the server enforces it again).
 * End time and end reading both filled = a finished drive; both empty = a
 * draft (the drive has started, the end follows); exactly one filled = the
 * empty one is reported as required. A finished drive cannot go back to a draft.
 * @param {object} v
 * @param {'new' | 'draft' | 'completed'} v.mode what is being saved: a new drive, an open draft or a finished drive
 * @param {string} v.start
 * @param {string | null} v.end null when the end date-time is empty
 * @param {number | null} v.odometerStart
 * @param {number | null} v.odometerEnd
 * @param {string} v.note
 * @param {KmOwner} [v.owner] whose kilometres these are; anything but "self" needs a note (and a person for "person") and is sent along
 * @returns {{ ok: true, status: 'draft' | 'completed', body: Record<string, unknown> } | { ok: false, errors: Record<string, string> }}
 */
export function driveBody(v) {
  /** @type {Record<string, string>} */
  const errors = {};
  if (v.odometerStart === null) errors['odometerStart'] = 'required';
  const hasEnd = v.end !== null;
  const hasReading = v.odometerEnd !== null;
  if (hasEnd !== hasReading) errors[hasEnd ? 'odometerEnd' : 'end'] = 'required';
  if (!hasEnd && !hasReading && v.mode === 'completed') {
    errors['end'] = 'required';
    errors['odometerEnd'] = 'required';
  }
  const owner = v.owner && v.owner.kmFor !== 'self' ? v.owner : null;
  if (owner) {
    // The server enforces both again; saying it here saves a round trip and keeps the form where it is.
    if (v.note.trim() === '') errors['note'] = 'required';
    if (owner.kmFor === 'person' && owner.kmUserId === null) errors['kmUserId'] = 'required';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const status = hasEnd ? 'completed' : 'draft';
  /** @type {Record<string, unknown>} */
  const body = { status, start: v.start, end: v.end, odometerStart: v.odometerStart, odometerEnd: v.odometerEnd, note: v.note };
  if (owner) {
    body['kmFor'] = owner.kmFor;
    body['kmUserId'] = owner.kmFor === 'person' ? owner.kmUserId : null;
  }
  return { ok: true, status, body };
}

/** @typedef {{ kmFor: 'self' | 'person' | 'together', kmUserId: number | null }} KmOwner */

/**
 * Keep a note field in step with the owner control: anything but "mine" makes the note required,
 * and the label, the hint and aria-required say so.
 * @param {ReturnType<typeof kmOwnerControl>} owner
 * @param {ReturnType<typeof field>} noteField
 * @param {HTMLElement} noteInput
 */
export function linkNoteToOwner(owner, noteField, noteInput) {
  const sync = () => {
    const required = owner.isNotMine();
    noteField.setLabel(required ? S.usage.noteRequired : S.usage.note);
    noteField.setHint(required ? S.usage.noteRequiredHint : S.noteHint);
    noteInput.setAttribute('aria-required', required ? 'true' : 'false');
  };
  owner.onChange(sync);
  sync();
}

/**
 * Whose kilometres a drive is, in words; null when they are the driver's own.
 * @param {{ kmFor?: 'self' | 'person' | 'together', kmUserId?: number | null, kmUserName?: string | null }} drive
 * @param {number} meId
 * @returns {string | null}
 */
export function kmOwnerLabel(drive, meId) {
  if (drive.kmFor === 'together') return S.usage.kmOwnerTogether;
  if (drive.kmFor === 'person' && drive.kmUserId !== null && drive.kmUserId !== undefined) {
    return S.usage.kmOwnerPerson(drive.kmUserId === meId ? S.me : (drive.kmUserName ?? '?'));
  }
  return null;
}

/**
 * kmOwnerLabel as a line under a drive; null when the kilometres are the driver's own.
 * @param {Parameters<typeof kmOwnerLabel>[0]} drive
 * @param {number} meId
 * @returns {HTMLElement | null}
 */
export function kmOwnerLine(drive, meId) {
  const label = kmOwnerLabel(drive, meId);
  return label ? h('div', { class: 'sub km-owner-line', text: label }) : null;
}

/**
 * The control that says whose kilometres a drive is. By default they are the driver's own; the checkbox
 * "I drove, but the kilometres aren't mine" reveals one choice: another person or Together (split
 * in the same ratio as everybody's own kilometres). The note then becomes required (the caller listens with onChange and says so).
 * @param {object} o
 * @param {Array<{ id: number, displayName: string }>} o.users active users
 * @param {number} o.meId
 * @param {number} o.driverId the driver: not offered as the other person
 * @param {Parameters<typeof kmOwnerLabel>[0] | null} [o.current] the drive being edited (older answers without the fields read as the driver's own)
 * @returns {{
 *   row: HTMLElement,
 *   field: Field,
 *   read: () => KmOwner,
 *   isNotMine: () => boolean,
 *   setDriver: (id: number) => void,
 *   onChange: (fn: () => void) => void,
 * }}
 */
export function kmOwnerControl(o) {
  const currentFor = o.current?.kmFor ?? 'self';
  const currentUserId = o.current?.kmUserId ?? null;
  let driverId = o.driverId;
  const check = h('input', { type: 'checkbox', checked: currentFor !== 'self' });
  const select = h('select', { name: 'kmOwner', 'aria-required': 'true' });
  const f = field(S.usage.kmWhose, select);
  const box = h('div', { class: 'km-owner-box', hidden: !check.checked }, [f.row]);

  /** @param {string} selected the value to keep or '' */
  const fillOptions = (selected) => {
    const options = [h('option', { value: '', text: S.usage.kmPersonNone }), h('option', { value: 'together', text: S.usage.kmChooseTogether })];
    const offered = new Set();
    for (const u of o.users) {
      if (u.id === driverId) continue;
      offered.add(u.id);
      options.push(h('option', { value: `person:${u.id}`, text: u.id === o.meId ? `${u.displayName} (${S.meLabel})` : u.displayName }));
    }
    // Someone deactivated since the drive was saved stays selectable while it is edited, so saving it does not drop them.
    if (currentUserId !== null && currentUserId !== driverId && !offered.has(currentUserId)) {
      options.push(h('option', { value: `person:${currentUserId}`, text: o.current?.kmUserName ?? '?' }));
    }
    select.replaceChildren(...options);
    select.value = options.some((opt) => opt.value === selected) ? selected : '';
  };
  fillOptions(currentFor === 'together' ? 'together' : currentFor === 'person' ? `person:${currentUserId}` : '');

  /** @type {Array<() => void>} */
  const listeners = [];
  const changed = () => {
    box.hidden = !check.checked;
    for (const fn of listeners) fn();
  };
  check.addEventListener('change', changed);
  select.addEventListener('change', changed);

  return {
    row: h('div', { class: 'km-owner' }, [h('label', { class: 'check' }, [check, h('span', { text: S.usage.kmNotMine })]), box]),
    field: f,
    read: () => {
      if (!check.checked) return { kmFor: 'self', kmUserId: null };
      if (select.value === 'together') return { kmFor: 'together', kmUserId: null };
      const m = /^person:(\d+)$/.exec(select.value);
      return { kmFor: 'person', kmUserId: m ? Number(m[1]) : null };
    },
    isNotMine: () => check.checked,
    setDriver: (id) => {
      driverId = id;
      fillOptions(select.value);
    },
    onChange: (fn) => {
      listeners.push(fn);
    },
  };
}

/**
 * Put the per-field codes of an API error on the matching form fields.
 * @param {Record<string, Field>} fields keyed by the API field name
 * @param {{ fields: Record<string, string> }} err
 */
export function showFieldErrors(fields, err) {
  for (const [name, code] of Object.entries(err.fields)) fields[name]?.setError(code);
}

/**
 * After a save that was refused: put keyboard and screen reader focus on the first
 * field marked invalid. On a long phone form the field is above the Save button,
 * so without this the person sees nothing happen.
 * @param {ParentNode} root the form
 */
export function focusFirstInvalid(root) {
  const first = root.querySelector('[aria-invalid="true"]');
  if (first instanceof HTMLElement) first.focus();
}

/**
 * Message for a failed save: an overlap names the booking in the way, anything
 * else gets the generic text for its error code.
 * @param {import('./api.js').ApiError} err
 * @param {string} tz
 * @param {(who: string, when: string) => string} overlapText
 */
export function saveErrorText(err, tz, overlapText) {
  const conflict = err.body['conflict'];
  return err.code === 'overlap' && conflict
    ? overlapText(conflict.userName, fmtRange(conflict.start, conflict.end, tz))
    : errorText(err);
}

/**
 * A whole-number input (odometer reading, reservation number).
 * @param {number | null | undefined} value
 * @param {string} [min]
 */
export function numberInput(value, min = '0') {
  return h('input', { type: 'number', inputmode: 'numeric', min, step: '1', value: value === null || value === undefined ? '' : String(value) });
}

/**
 * @param {string} value
 * @returns {number | null} null when empty
 */
export function readNumber(value) {
  const v = value.trim();
  return v === '' ? null : Number(v);
}

/**
 * The "who" drop-down: every active user, the signed-in one marked as "me".
 * @param {Array<{ id: number, displayName: string }>} users
 * @param {number} meId
 * @param {boolean} disabled
 */
export function driverSelect(users, meId, disabled) {
  return h(
    'select',
    { name: 'driver', disabled },
    users.map((u) => h('option', { value: String(u.id), text: u.id === meId ? `${u.displayName} (${S.meLabel})` : u.displayName })),
  );
}

/**
 * A toast function that writes into the element `getEl` returns (null: nothing to show yet).
 * @param {() => HTMLElement | null} getEl
 * @returns {(message: string, isError?: boolean) => void}
 */
export function toaster(getEl) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return (message, isError = false) => {
    const el = getEl();
    if (!el) return;
    el.textContent = message;
    el.className = isError ? 'toast show error' : 'toast show';
    clearTimeout(timer);
    // An error says what to fix, so it stays long enough to read and act on. A longer
    // message (a saved note with the note tip added) gets more time, about 70 ms a character.
    timer = setTimeout(() => getEl()?.classList.remove('show'), isError ? 8000 : Math.max(4000, message.length * 70));
  };
}

/**
 * Round an instant up to the next full hour.
 * @param {Date} date
 * @returns {Date}
 */
export function nextFullHour(date) {
  const hour = 3_600_000;
  return new Date(Math.ceil((date.getTime() + 1) / hour) * hour);
}
