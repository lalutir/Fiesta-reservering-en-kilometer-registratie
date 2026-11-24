// The Car tab: the APK expiry date of the car, and damage reports.
//   * APK: one date for the one car. Anybody can enter the new date when the car has been inspected again;
//     until then the card asks for it. Days left are counted with the same shared helper as the server
//     (calendar days, so a clock change never makes a day 23 or 25 hours long).
//   * Damage: anybody can report damage; everybody sees every report; the person who filed one (or an admin)
//     edits and deletes it; anybody can mark one repaired. The server works out who last had the car before the
//     noticed day. This view only words it, and neutrally: it is information, not blame.
// A date here is a day of the calendar ('YYYY-MM-DD'), never an instant: the date inputs hold it as it is.
import { del, get, patch, post } from '../api.js';
import { actionBar, addDateKeyYears, daysBetween, field, focusFirstInvalid, formatDateKey, h, isCalendarDate, localDateKey, setBusy, showFieldErrors } from '../dom.js';
import { persistForm, restoredLine } from '../drafts.js';
import { S, errorText } from '../strings.js';
import { button, confirmSheet, emptyState, linkButton } from '../ui.js';
import { deferDelete, pendingIds } from '../undo.js';

// Contains forms, so it is not re-rendered in the background.
export const live = false;

// The same limits as the server (src/car.ts and src/validate.ts); test/car-view.test.ts keeps the two equal.
export const LOCATIONS = /** @type {const} */ (['front', 'rear', 'left', 'right', 'roof', 'interior', 'wheels_tyres', 'windows', 'mechanical', 'other']);
export const DESCRIPTION_MAX = 1000;
export const REPAIR_NOTE_MAX = 500;
export const APK_YEARS_AHEAD = 5;
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;
/** An APK that runs out within this many days is shown as due soon. A colour only: nobody is reminded. */
export const APK_SOON_DAYS = 30;

/**
 * Whether a typed date is acceptable, and the code of the sentence to show when it is not.
 * @param {string} text the value of a date input ('' when empty)
 * @param {string} max the latest allowed day, 'YYYY-MM-DD'
 * @param {string} [min] the earliest allowed day (default 2000-01-01)
 * @param {{ tooLate: string, tooEarly?: string }} [codes] the codes for a day after `max` and before `min`
 * @returns {string | null} null when it is fine
 */
export function dateProblem(text, max, min = `${MIN_YEAR}-01-01`, codes = { tooLate: 'in_future' }) {
  if (text === '') return 'required';
  if (!isCalendarDate(text) || text < `${MIN_YEAR}-01-01` || text > `${MAX_YEAR}-12-31`) return 'invalid_date';
  if (text > max) return codes.tooLate;
  if (text < min) return codes.tooEarly ?? 'invalid_date';
  return null;
}

/**
 * How the APK stands today, for the card.
 * @param {string} expiresOn 'YYYY-MM-DD'
 * @param {string} today 'YYYY-MM-DD' in the household zone
 * @returns {{ kind: 'ok' | 'soon' | 'today' | 'expired', daysLeft: number, headline: string, detail: string, badge: string }}
 */
export function apkSummary(expiresOn, today) {
  const daysLeft = daysBetween(today, expiresOn);
  const date = formatDateKey(expiresOn);
  const a = S.car.apk;
  if (daysLeft < 0) return { kind: 'expired', daysLeft, headline: a.expiredOn(date), detail: a.expiredDays(-daysLeft), badge: a.badge.expired };
  if (daysLeft === 0) return { kind: 'today', daysLeft, headline: a.expiresOn(date), detail: a.todayDetail, badge: a.badge.today };
  const kind = daysLeft <= APK_SOON_DAYS ? 'soon' : 'ok';
  return { kind, daysLeft, headline: a.expiresOn(date), detail: a.inDays(daysLeft), badge: a.badge[kind] };
}

/** The neutral sentence under a report: what the records show about the car before the noticed day, and what that rests on. @param {import('../api.js').DamageReport['hint']} hint */
export function hintText(hint) {
  if (!hint.driver || hint.basis === 'none') return S.car.hint.none;
  return S.car.hint[hint.basis](hint.driver.name);
}

/** @param {{ kind: string }} s the badge class of a state: ok is green, soon and today amber, expired red. */
const badgeClass = (s) => (s.kind === 'ok' ? 'confirmed' : s.kind === 'expired' ? 'declined' : 'pending');

/**
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  const [apkData, damageData] = await Promise.all([get('/api/car/apk'), get('/api/damage')]);
  /** @type {import('../api.js').Apk} */
  const apk = apkData.apk;
  // A report that was deleted a moment ago (and can still be taken back) is not on the screen.
  const goneReports = pendingIds('damage');
  /** @type {import('../api.js').DamageReport[]} */
  const reports = damageData.items.filter((/** @type {import('../api.js').DamageReport} */ r) => !goneReports.has(r.id));
  const today = localDateKey(Date.now(), app.tz);
  const apkMax = addDateKeyYears(today, APK_YEARS_AHEAD);
  const editId = Number(route.query.get('edit') ?? 0) || null;
  // Only a report this person may change opens for editing; anything else falls back to a blank form.
  const existing = editId ? (reports.find((r) => r.id === editId && r.can.edit) ?? null) : null;

  /** After the view is rebuilt, focus goes back to the page heading rather than to nowhere. */
  const focusHeading = () => {
    const target = document.querySelector('.car-view h2');
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  /**
   * A refused save: the field errors by their fields, the sentence for the whole refusal under the form, focus on the
   * first invalid field and the submit button usable again.
   * @param {import('../api.js').ApiError} err
   * @param {Parameters<typeof showFieldErrors>[0]} fields
   * @param {HTMLElement} errorLine
   * @param {ParentNode} formEl
   * @param {HTMLButtonElement} submitButton
   */
  const refused = (err, fields, errorLine, formEl, submitButton) => {
    showFieldErrors(fields, err);
    errorLine.textContent = errorText(err);
    errorLine.hidden = false;
    focusFirstInvalid(formEl);
    submitButton.disabled = false;
  };

  // ------------------------------------------------------------------ the APK card
  const apkInput = h('input', { type: 'date', min: `${MIN_YEAR}-01-01`, max: apkMax, value: apk.expiresOn ?? '' });
  const fApk = field(S.car.apk.label, apkInput, S.car.apk.hint);
  const apkError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  // One main action per view: the date is the thing to do only while it is missing; once it is set, the main action of
  // the page is the damage form's Save report, and Update date is a plain button.
  const apkSubmit = button({ label: apk.expiresOn ? S.car.apk.update : S.car.apk.save, variant: apk.expiresOn ? 'secondary' : 'primary', type: 'submit' });
  const apkForm = h(
    'form',
    {
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        fApk.setError(null);
        apkError.hidden = true;
        const problem = dateProblem(apkInput.value, apkMax, `${MIN_YEAR}-01-01`, { tooLate: 'too_far_ahead' });
        if (problem) {
          fApk.setError(problem);
          focusFirstInvalid(apkForm);
          return;
        }
        apkSubmit.disabled = true;
        try {
          await patch('/api/car/apk', { expiresOn: apkInput.value });
          app.toast(S.car.apk.saved);
          await app.refresh();
          focusHeading();
        } catch (err) {
          refused(/** @type {import('../api.js').ApiError} */ (err), { expiresOn: fApk }, apkError, apkForm, apkSubmit);
        }
      },
    },
    [fApk.row, apkError, h('div', { class: 'actions' }, [apkSubmit])],
  );

  const state = apk.expiresOn ? apkSummary(apk.expiresOn, today) : null;
  const apkCard = h('section', { class: 'card apk-card', 'aria-labelledby': 'apk-title' }, [
    h('h3', { id: 'apk-title', text: S.car.apk.title }),
    state
      ? h('div', { class: 'apk-state' }, [
          h('div', { class: 'row' }, [h('strong', { text: state.headline }), h('span', { class: `badge-status ${badgeClass(state)}`, text: state.badge })]),
          h('div', { class: 'sub', text: state.detail }),
          apk.updatedBy && apk.updatedAt
            ? h('div', { class: 'sub', text: S.car.apk.updatedBy(apk.updatedBy.id === me.id ? S.you : apk.updatedBy.name, formatDateKey(localDateKey(apk.updatedAt, app.tz))) })
            : null,
        ])
      : h('div', { class: 'apk-state notice' }, [h('strong', { text: S.car.apk.notSet }), h('div', { text: S.car.apk.prompt })]),
    apkForm,
  ]);

  // ----------------------------------------------------------- the damage form
  const noticedOn = h('input', { type: 'date', min: `${MIN_YEAR}-01-01`, max: today, required: true, value: existing?.noticedOn ?? today });
  const fNoticedOn = field(S.car.noticedOn, noticedOn, S.car.noticedOnHint);

  // Me first (that is who noticed it unless they say otherwise), then the others, and "Unknown". A person who
  // has been deactivated since stays selectable while their report is edited, so saving it does not drop them.
  const people = [...app.users].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id));
  const noticerOptions = people.map((u) => h('option', { value: String(u.id), text: u.id === me.id ? `${u.displayName} (${S.meLabel})` : u.displayName }));
  if (existing?.noticedBy && !people.some((u) => u.id === existing.noticedBy?.id)) {
    noticerOptions.push(h('option', { value: String(existing.noticedBy.id), text: existing.noticedBy.name }));
  }
  noticerOptions.push(h('option', { value: 'unknown', text: S.car.unknown }));
  const noticedBy = h('select', { name: 'noticedBy' }, noticerOptions);
  noticedBy.value = existing ? (existing.noticedBy ? String(existing.noticedBy.id) : 'unknown') : String(me.id);
  const fNoticedBy = field(S.car.noticedBy, noticedBy);

  const location = h('select', { name: 'location', required: true }, [
    h('option', { value: '', text: S.car.wherePick }),
    ...LOCATIONS.map((value) => h('option', { value, text: S.car.location[value] })),
  ]);
  location.value = existing?.location ?? '';
  const fLocation = field(S.car.where, location);

  const description = h('textarea', { rows: '3', maxlength: String(DESCRIPTION_MAX), autocomplete: 'off', value: existing?.description ?? '' });
  const fDescription = field(S.car.description, description, S.car.descriptionHint);

  // Editing a repaired report also shows its repair; an open one has no repair to edit (Mark repaired does that).
  const editsRepair = existing?.status === 'repaired';
  const repairedOnEdit = h('input', { type: 'date', min: existing?.noticedOn ?? `${MIN_YEAR}-01-01`, max: today, value: existing?.repairedOn ?? '' });
  const fRepairedOnEdit = field(S.car.repairedOn, repairedOnEdit);
  const repairNoteEdit = h('textarea', { rows: '2', maxlength: String(REPAIR_NOTE_MAX), autocomplete: 'off', value: existing?.repairNote ?? '' });
  const fRepairNoteEdit = field(S.car.repairNote, repairNoteEdit, S.car.repairNoteHint);

  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = button({ label: S.car.save, variant: 'primary', block: true, type: 'submit' });
  // A new report keeps what was typed when the person leaves and comes back; an edit shows what the server has.
  const unsent = existing ? null : persistForm({ userId: me.id, name: 'damage', controls: { noticedOn, noticedBy, location, description } });
  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        for (const f of [fNoticedOn, fNoticedBy, fLocation, fDescription, fRepairedOnEdit, fRepairNoteEdit]) f.setError(null);
        formError.hidden = true;
        const problems = /** @type {Array<[ReturnType<typeof field>, string | null]>} */ ([
          [fNoticedOn, dateProblem(noticedOn.value, today)],
          [fLocation, location.value === '' ? 'required' : null],
          [fDescription, description.value.trim() === '' ? 'required' : description.value.length > DESCRIPTION_MAX ? 'too_long' : null],
        ]);
        if (editsRepair) problems.push([fRepairedOnEdit, dateProblem(repairedOnEdit.value, today, noticedOn.value, { tooLate: 'in_future', tooEarly: 'before_noticed' })]);
        let bad = false;
        for (const [f, code] of problems) {
          if (code) {
            f.setError(code);
            bad = true;
          }
        }
        if (bad) {
          focusFirstInvalid(form);
          return;
        }
        /** @type {Record<string, unknown>} */
        const body = {
          noticedOn: noticedOn.value,
          noticedBy: noticedBy.value === 'unknown' ? null : Number(noticedBy.value),
          location: location.value,
          description: description.value,
        };
        if (editsRepair) {
          body['repairedOn'] = repairedOnEdit.value;
          body['repairNote'] = repairNoteEdit.value;
        }
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/damage/${existing.id}`, body);
          else await post('/api/damage', body);
          unsent?.clear();
          app.toast(S.car.saved);
          if (existing) app.navigate('#/car');
          else {
            await app.refresh();
            focusHeading();
          }
        } catch (err) {
          const fields = { noticedOn: fNoticedOn, noticedBy: fNoticedBy, location: fLocation, description: fDescription, repairedOn: fRepairedOnEdit, repairNote: fRepairNoteEdit };
          refused(/** @type {import('../api.js').ApiError} */ (err), fields, formError, form, submit);
        }
      },
    },
    [
      h('h3', { text: existing ? S.car.editTitle : S.car.addTitle }),
      unsent ? restoredLine(unsent) : null,
      fNoticedOn.row,
      fNoticedBy.row,
      fLocation.row,
      fDescription.row,
      editsRepair ? [fRepairedOnEdit.row, fRepairNoteEdit.row] : null,
      formError,
      h('div', { class: 'actions' }, [submit, existing ? linkButton({ label: S.cancel, href: '#/car' }) : null]),
    ],
  );

  // --------------------------------------------------------------- the lists
  /**
   * Run a change on one report with its buttons disabled, then reload the list. A refusal (somebody was quicker) is
   * shown as a toast and the reloaded list shows how it is now.
   * @param {Element | null} bar the buttons of the report
   * @param {() => Promise<unknown>} action
   * @param {string} done the toast for a success
   */
  const change = async (bar, action, done) => {
    if (bar) setBusy(bar, true);
    try {
      await action();
      app.toast(done);
    } catch (err) {
      app.toast(errorText(/** @type {Error} */ (err)), true);
    }
    await app.refresh();
    if (bar?.isConnected) setBusy(bar, false);
    focusHeading();
  };

  /**
   * Take a report away. Deleting a damage report tells nobody anything, so the person's own disappears at once with
   * "Ongedaan maken" and the DELETE goes out after the window; somebody else's (an admin cleaning up) asks first.
   * @param {import('../api.js').DamageReport} r
   * @param {Element | null} bar the buttons of the report, read from the click before anything is awaited
   */
  const removeReport = async (r, bar) => {
    if (r.reportedBy.id === me.id) {
      deferDelete({
        key: `damage:${r.id}`,
        message: S.undo.damage,
        commit: (o) => del(`/api/damage/${r.id}`, o),
        onUndo: () => void app.refresh(),
        onError: (err) => {
          app.toast(errorText(/** @type {Error} */ (err)), true);
          void app.refresh();
        },
        toast: app.toast,
      });
      await app.refresh();
      focusHeading();
      return;
    }
    if (!(await confirmSheet(S.car.confirmDelete, { confirmLabel: S.delete }))) return;
    await change(bar, () => del(`/api/damage/${r.id}`), S.car.deleted);
  };

  /** @param {import('../api.js').DamageReport} r */
  const card = (r) => {
    const place = S.car.location[r.location];
    const day = formatDateKey(r.noticedOn);
    const noticer = r.noticedBy ? (r.noticedBy.id === me.id ? S.you : r.noticedBy.name) : null;

    // Mark repaired: a small form inside the card that opens in place, so the person never leaves the list.
    const repairedOn = h('input', { type: 'date', min: r.noticedOn, max: today, required: true, value: today < r.noticedOn ? r.noticedOn : today });
    const fRepairedOn = field(S.car.repairedOn, repairedOn);
    const repairNote = h('textarea', { rows: '2', maxlength: String(REPAIR_NOTE_MAX), autocomplete: 'off' });
    const fRepairNote = field(S.car.repairNote, repairNote, S.car.repairNoteHint);
    const repairError = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const repairSubmit = button({ label: S.car.confirmRepaired, variant: 'primary', type: 'submit' });
    const repairForm = h(
      'form',
      {
        class: 'repair-form',
        hidden: true,
        novalidate: true,
        onsubmit: async (/** @type {Event} */ e) => {
          e.preventDefault();
          fRepairedOn.setError(null);
          fRepairNote.setError(null);
          repairError.hidden = true;
          const problem = dateProblem(repairedOn.value, today, r.noticedOn, { tooLate: 'in_future', tooEarly: 'before_noticed' });
          if (problem) {
            fRepairedOn.setError(problem);
            focusFirstInvalid(repairForm);
            return;
          }
          repairSubmit.disabled = true;
          try {
            await post(`/api/damage/${r.id}/repair`, { repairedOn: repairedOn.value, repairNote: repairNote.value });
            app.toast(S.car.repaired);
            await app.refresh();
            focusHeading();
          } catch (err) {
            const apiErr = /** @type {import('../api.js').ApiError} */ (err);
            if (apiErr.code === 'already_repaired') {
              // Somebody else was quicker: say so and show the list as it is now.
              app.toast(errorText(apiErr), true);
              await app.refresh();
              focusHeading();
              return;
            }
            refused(apiErr, { repairedOn: fRepairedOn, repairNote: fRepairNote }, repairError, repairForm, repairSubmit);
          }
        },
      },
      [
        fRepairedOn.row,
        fRepairNote.row,
        repairError,
        h('div', { class: 'actions' }, [
          repairSubmit,
          button({
            label: S.cancel,
            onclick: () => {
              repairForm.hidden = true;
              // The button that opened the form says it is closed again, and keyboard focus goes back to it.
              repairButton?.setAttribute('aria-expanded', 'false');
              repairButton?.focus();
            },
          }),
        ]),
      ],
    );
    const repairButton = r.can.repair
      ? button({
          label: S.car.markRepaired,
          attrs: { 'aria-label': S.car.repairLabel(place, day), 'aria-expanded': 'false' },
          onclick: (/** @type {Event} */ e) => {
            repairForm.hidden = !repairForm.hidden;
            if (e.currentTarget instanceof Element) e.currentTarget.setAttribute('aria-expanded', String(!repairForm.hidden));
            if (!repairForm.hidden) repairedOn.focus();
          },
        })
      : null;

    return h('article', { class: `card damage ${r.status}`, id: `damage-${r.id}` }, [
      h('div', { class: 'row' }, [
        h('strong', { text: place }),
        h('span', { class: `badge-status ${r.status === 'open' ? 'pending' : 'confirmed'}`, text: S.car.status[r.status] }),
      ]),
      h('div', { class: 'when', text: noticer ? S.car.noticedLine(day, noticer) : S.car.noticedUnknown(day) }),
      // Text only: a description is typed by a person and never treated as markup.
      h('p', { class: 'damage-text', text: r.description }),
      r.status === 'repaired' && r.repairedOn
        ? h('div', { class: 'sub' }, [S.car.repairedLine(formatDateKey(r.repairedOn)), r.repairNote ? h('div', { class: 'damage-text', text: r.repairNote }) : null])
        : null,
      h('div', { class: 'sub' }, [S.car.reportedBy(r.reportedBy.id === me.id ? S.you : r.reportedBy.name)]),
      h('div', { class: 'sub damage-hint' }, [hintText(r.hint), ' ', S.car.hint.note]),
      repairForm,
      r.can.repair || r.can.edit || r.can.delete
        ? h('div', { class: 'actions' }, [
            repairButton,
            r.status === 'repaired' && r.can.edit
              ? button({
                  label: S.car.reopen,
                  attrs: { 'aria-label': S.car.reopenLabel(place, day) },
                  onclick: (/** @type {Event} */ e) => void change(actionBar(e), () => patch(`/api/damage/${r.id}`, { status: 'open' }), S.car.reopened),
                })
              : null,
            r.can.edit ? linkButton({ label: S.edit, href: `#/car?edit=${r.id}`, attrs: { 'aria-label': S.car.editLabel(place, day) } }) : null,
            r.can.delete
              ? button({
                  label: S.delete,
                  variant: 'danger',
                  attrs: { 'aria-label': S.car.deleteLabel(place, day) },
                  onclick: (/** @type {Event} */ e) => removeReport(r, actionBar(e)),
                })
              : null,
          ])
        : null,
    ]);
  };

  const open = reports.filter((r) => r.status === 'open');
  const repaired = reports.filter((r) => r.status === 'repaired');

  // Editing: the form comes first. Pressing Edit lands on the top of the page (see landOnView in app.js), and in its usual
  // place the form sits under the APK card, below the fold on a 320 px phone: it would look as if nothing had happened.
  return h('div', { class: 'car-view' }, [
    h('h2', { text: S.car.title }),
    // On a wide screen the APK and the form are one column and the reports the other; on a phone they follow each other in this order.
    h('div', { class: 'split' }, [
      h('div', {}, [existing ? form : null, apkCard, h('h2', { text: S.car.damage }), h('p', { class: 'hint', text: S.car.intro }), existing ? null : form]),
      h('div', {}, [
        h('h3', { text: S.car.open(open.length) }),
        open.length === 0 ? emptyState({ text: reports.length === 0 ? S.car.none : S.car.noneOpen }) : open.map(card),
        repaired.length > 0 ? [h('h3', { text: S.car.repairedList(repaired.length) }), repaired.map(card)] : null,
      ]),
    ]),
  ]);
}
