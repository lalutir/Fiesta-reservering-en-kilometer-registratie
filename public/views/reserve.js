import { get, patch, post } from '../api.js';
import { dateTimeField, driverSelect, field, h, nextFullHour, readRange, saveErrorText, showFieldErrors } from '../dom.js';
import { S } from '../strings.js';

// A form: never re-rendered in the background, so typing is not lost.
export const live = false;

/**
 * New reservation / suggestion, or (with an id in the route) edit one.
 * @param {import('../api.js').App} app
 * @param {{ arg: string | undefined }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  const editId = route.arg ? Number(route.arg) : null;
  /** @type {import('../api.js').Reservation | null} */
  let existing = null;
  if (editId) {
    existing = (await get(`/api/reservations/${editId}`)).reservation;
    if (!existing?.can.edit) {
      return h('div', { class: 'card' }, [h('p', { text: S.errors.not_editable }), h('a', { class: 'btn', href: '#/' }, S.back)]);
    }
  }

  const driver = driverSelect(app.users, me.id, existing !== null);
  driver.value = String(existing?.userId ?? me.id);

  const firstStart = nextFullHour(new Date());
  const start = dateTimeField(S.reserve.start, existing?.start ?? firstStart.toISOString(), app.tz);
  const end = dateTimeField(S.reserve.end, existing?.end ?? new Date(firstStart.getTime() + 2 * 3_600_000).toISOString(), app.tz);
  const note = h('input', { type: 'text', name: 'note', maxlength: '500', value: existing?.note ?? '', autocomplete: 'off' });
  const driverField = field(S.reserve.driver, driver);
  const noteField = field(S.reserve.note, note, S.noteHint);
  const submit = h('button', { class: 'btn primary block', type: 'submit' });
  const hint = h('p', { class: 'hint', text: S.reserve.suggestionHint, hidden: true });
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const isOther = () => Number(driver.value) !== me.id;
  const syncLabels = () => {
    submit.textContent = existing ? S.reserve.saveChanges : isOther() ? S.reserve.submitSuggestion : S.reserve.submit;
    hint.hidden = existing !== null || !isOther();
  };
  driver.addEventListener('change', syncLabels);
  syncLabels();

  /** @param {string | null} message */
  const showFormError = (message) => {
    formError.textContent = message ?? '';
    formError.hidden = !message;
  };

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        for (const f of [driverField, start, end, noteField]) f.setError(null);
        showFormError(null);
        const range = readRange(start, end);
        if (!range) return;
        const body = /** @type {Record<string, unknown>} */ ({ ...range, note: note.value });
        if (!existing && isOther()) body['userId'] = Number(driver.value);
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/reservations/${existing.id}`, body);
          else await post('/api/reservations', body);
          const saved = existing ? S.reserve.updated : isOther() ? S.reserve.suggested : S.reserve.created;
          // A note is recommended, never required: an empty one only earns a friendly tip.
          app.toast(note.value.trim() === '' ? `${saved} ${S.noteTip}` : saved);
          app.navigate('#/');
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors({ start, end, note: noteField, userId: driverField }, apiErr);
          showFormError(saveErrorText(apiErr, app.tz, S.reserve.overlap));
          submit.disabled = false;
        }
      },
    },
    [driverField.row, hint, start.row, end.row, noteField.row, h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }), formError, submit],
  );

  return h('div', { class: 'reserve' }, [h('h2', { text: existing ? S.reserve.editTitle : S.reserve.newTitle }), form]);
}
