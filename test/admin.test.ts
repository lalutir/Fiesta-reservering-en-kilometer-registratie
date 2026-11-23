// The admin page, driven like an admin does: the km column and notes on the
// Reservations tab, the per-person list of kilometres still to register on the Drives
// tab (30 days by default, the whole window on request), cancelling an unused
// reservation, and registering or finishing a drive from that list.
//
// public/admin/admin.js is a page script: it takes #admin and #toast from the
// document when it is first loaded and starts itself. So this is one test that loads
// it once and walks through the page, instead of many tests that each need a fresh page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRange, fmtWhen } from '../public/dom.js';
import { S } from '../public/strings.js';
import {
  ADMIN,
  ANNA,
  BEN,
  NOW,
  Reply,
  TZ,
  all,
  at,
  byText,
  control,
  dateTime,
  draft,
  errorOf,
  fieldRow,
  one,
  refuse,
  reservation,
  typeInto,
  until,
  usage,
  withClient,
  type FakeElement,
} from './fake-dom.ts';
import type { Json } from './helpers.ts';

const A = S.admin;
const P = S.admin.usage;

test('admin page: km state and notes per reservation, the pending km per person, and registering from the list', async () => {
  const session = { user: ADMIN, timeZone: TZ, windowMonths: 6, serverTime: NOW };

  // Anna has an ended reservation without km and one with a drive in progress; Ben has an ended one too.
  const oma = reservation({ id: 7, start: at(-300), end: at(-240), note: 'Visit to Oma' });
  const started = reservation({ id: 8, start: at(-200), end: at(-100), kmState: 'draft', drive: { id: 9, userId: 1, userName: 'Anna', status: 'draft', odometerStart: 41120, odometerEnd: null, distanceKm: null, linked: true } });
  const bens = reservation({ id: 10, userId: 2, userName: 'Ben', start: at(-1000), end: at(-900), note: '', can: { edit: true, cancel: true, approve: false, decline: false } });
  const registered = reservation({
    id: 11,
    start: at(-2000),
    end: at(-1900),
    note: 'Airport',
    kmState: 'registered',
    drive: { id: 3, userId: 2, userName: 'Ben', status: 'completed', odometerStart: 41000, odometerEnd: 41120, distanceKm: 120, linked: false },
  });
  const pending = {
    items: [
      { userId: 1, userName: 'Anna', reservations: [oma, started], drafts: [draft()] },
      { userId: 2, userName: 'Ben', reservations: [bens], drafts: [] },
    ],
    count: 3,
  };
  let reservationsGone = false;
  // The first attempt to change whose kilometres drive 12 are is refused (the person was deactivated meanwhile); the next one is accepted.
  let ownerRefusal: Reply | null = refuse(422, 'validation_failed', { fields: { kmUserId: 'unknown_user' } });

  const routes = {
    'GET /api/auth/me': () => session,
    'GET /api/admin/users': () => ({ users: [ANNA, BEN, ADMIN] }),
    'GET /api/reservations': () => ({ items: [oma, started, registered] }),
    'GET /api/usage': () => ({
      items: [
        usage(),
        draft(),
        // Ben drove, the kilometres are Anna's.
        usage({ id: 12, userId: BEN.id, userName: 'Ben', start: at(-3000), end: at(-2900), kmFor: 'person', kmUserId: ANNA.id, kmUserName: 'Anna', note: 'Took Anna to the station', can: { edit: true, delete: true } }),
        usage({ id: 13, userId: ANNA.id, userName: 'Anna', start: at(-4000), end: at(-3900), kmFor: 'together', kmUserId: null, kmUserName: null, note: 'Family trip', can: { edit: true, delete: true } }),
      ],
    }),
    'PATCH /api/usage/12': () => ownerRefusal ?? { usage: {} },
    'GET /api/usage/pending': () => (reservationsGone ? { items: [{ userId: 1, userName: 'Anna', reservations: [started], drafts: [draft()] }, { userId: 2, userName: 'Ben', reservations: [bens], drafts: [] }], count: 2 } : pending),
    'DELETE /api/reservations/7': () => {
      reservationsGone = true;
      return new Reply(null, 204);
    },
    'POST /api/usage': () => new Reply({ usage: {} }, 201),
    'PATCH /api/usage/9': () => ({ usage: {} }),
  };

  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    // The page shell: what admin/index.html gives the script.
    const page = (id: string): FakeElement => {
      const el = (globalThis as Json)['document'].createElement('div') as FakeElement;
      el.id = id;
      return dom.mount(el);
    };
    const root = page('admin');
    const toastEl = page('toast');
    const redirects: string[] = [];
    Object.defineProperty(globalThis, 'location', { value: { replace: (to: string) => redirects.push(to) }, configurable: true, writable: true });
    try {
      await import('../public/admin/admin.js');
      await until(() => all(root, '.admin-tabs button').length === 4 && all(root, 'table').length > 0, 'the admin page to start on the users tab');
      assert.deepEqual(redirects, [], 'an admin stays on the page');
      const tab = (name: string): FakeElement => one(root, `button[data-tab="${name}"]`);

      // ---------------------------------------------------- Reservations tab
      await tab('reservations').fire('click');
      await until(() => all(root, '.table-wrap').some((w) => w.getAttribute('aria-label') === A.tabs.reservations), 'the reservations tab');
      assert.equal(tab('reservations').getAttribute('aria-pressed'), 'true');
      assert.equal(tab('users').getAttribute('aria-pressed'), 'false');
      const rows = all(root, 'tbody tr').map((tr) => all(tr, 'td').map((td) => td.textContent));
      assert.equal(rows[0]?.[5], `${A.usage.kmState.missing}`, 'a reservation with nothing registered says Missing');
      assert.equal(rows[0]?.[6], 'Visit to Oma', 'the note has its own column');
      assert.equal(rows[1]?.[5], `${A.usage.kmState.draft} (Anna)`, 'a started drive says who started it');
      assert.equal(rows[1]?.[6], '–', 'no note shows a dash');
      assert.equal(rows[2]?.[5], `${A.usage.kmState.registered} ${S.usage.km(120)}, Ben`, 'a registered one says how far and who drove');
      assert.equal(rows[2]?.[6], 'Airport');
      assert.equal(one(root, '.chip.paid').textContent, rows[2]?.[5], 'registered is the same green chip as paid');

      // ------------------------------------------------------------ Drives tab
      await tab('usage').fire('click');
      await until(() => all(root, 'h2').some((h2) => h2.textContent === `${P.pendingTitle} (3)`), 'the drives tab with its pending list');
      const queryOf = (n: number) => api.calls.filter((c) => c.path === '/api/usage/pending')[n]?.query;
      assert.equal(queryOf(0), 'all=1&days=30', 'the admin looks at everybody, for the last 30 days');
      assert.ok(all(root, 'p.hint').some((p) => p.textContent === P.pendingScope(30)));

      const pendingTable = (): FakeElement => {
        const wrap = all(root, '.table-wrap').find((w) => w.getAttribute('aria-label') === P.pendingTitle);
        assert.ok(wrap, 'the pending list is on the page');
        return wrap;
      };
      const pendingRows = (): string[][] => all(pendingTable(), 'tbody tr').map((tr) => all(tr, 'td').map((td) => td.textContent));
      assert.deepEqual(
        pendingRows().map((r) => r.slice(0, 4)),
        [
          ['Anna', P.pendingDraft, `${fmtWhen(at(-60), TZ)}, 41.120 km`, 'Groceries'],
          ['Anna', `${P.pendingReservation} #7`, fmtRange(at(-300), at(-240), TZ), 'Visit to Oma'],
          ['Ben', `${P.pendingReservation} #10`, fmtRange(at(-1000), at(-900), TZ), '–'],
        ],
        'one row per piece of work and per person; the reservation that already has a drive in progress is only the drive',
      );

      // The whole window on request, and back.
      await byText(root, 'button', P.pendingFull).fire('click');
      await until(() => all(root, 'p.hint').some((p) => p.textContent === P.pendingScope(190)), 'the whole window');
      assert.equal(queryOf(1), 'all=1&days=190');
      await byText(root, 'button', P.pendingShort).fire('click');
      await until(() => all(root, 'p.hint').some((p) => p.textContent === P.pendingScope(30)) && queryOf(2) === 'all=1&days=30', 'the short list again');

      // --------------------------------------- "car not used": cancel, after a question
      const cancelOma = all(pendingTable(), 'tbody tr')[1] as FakeElement;
      dom.answer = false;
      await byText(cancelOma, 'button', A.reservations.cancelReservation).fire('click');
      assert.deepEqual(api.writes(), [], 'a "no" changes nothing');
      dom.answer = true;
      await byText(cancelOma, 'button', A.reservations.cancelReservation).fire('click');
      await until(() => all(root, 'h2').some((h2) => h2.textContent === `${P.pendingTitle} (2)`), 'the list after the cancel');
      assert.equal(api.writes().at(-1)?.path, '/api/reservations/7');
      assert.equal(toastEl.textContent, A.reservations.cancelled);
      assert.deepEqual(dom.confirms.slice(-2), [A.reservations.confirmCancel, A.reservations.confirmCancel]);

      // ------------------- register km for someone else, from the row of their reservation
      const bensRow = all(pendingTable(), 'tbody tr').find((tr) => all(tr, 'td')[1]?.textContent === `${P.pendingReservation} #10`) as FakeElement;
      await byText(bensRow, 'button', P.newRecord).fire('click');
      await until(() => all(root, 'form.editor').length === 1, 'the drive editor');
      const editor = one(root, 'form.editor');
      assert.equal(one(editor, 'h2').textContent, P.newRecord);
      assert.equal(control(fieldRow(editor, S.usage.driver)).value, String(BEN.id), 'the person of that reservation is the driver');
      assert.equal(control(fieldRow(editor, `${S.usage.reservation} #`)).value, '10', 'linked to it');
      assert.deepEqual([dateTime(fieldRow(editor, S.usage.start)).date.value, dateTime(fieldRow(editor, S.usage.start)).time.value], ['2026-06-14', '19:20'], "the reservation's own start");
      assert.equal(dom.focused(), control(fieldRow(editor, S.usage.driver)), 'focus is on the first control of the editor after it opens');

      await editor.fire('submit');
      assert.equal(api.writes().length, 1, 'both readings are needed: nothing was sent');
      assert.equal(one(fieldRow(editor, S.usage.odometerStart), '.field-error').textContent, S.fieldErrors.required);
      await typeInto(control(fieldRow(editor, S.usage.odometerStart)), '41120');
      await typeInto(control(fieldRow(editor, S.usage.odometerEnd)), '41135');
      await editor.fire('submit');
      await until(() => api.writes().length === 2, 'the drive to be sent');
      const sent = api.writes()[1] as Json;
      assert.equal(`${sent.method} ${sent.path}`, 'POST /api/usage');
      assert.deepEqual(sent.body, {
        status: 'completed',
        start: at(-1000),
        end: at(-900),
        odometerStart: 41120,
        odometerEnd: 41135,
        note: '',
        userId: BEN.id,
        reservationId: 10,
      });
      await until(() => all(root, 'form.editor').length === 0 && toastEl.textContent === A.usage.saved, 'the editor to close');

      // -------------------------------------- finish someone's open drive from the list
      const draftRow = all(pendingTable(), 'tbody tr').find((tr) => all(tr, 'td')[1]?.textContent === P.pendingDraft) as FakeElement;
      await byText(draftRow, 'button', S.edit).fire('click');
      await until(() => all(root, 'form.editor').length === 1, 'the editor for the open drive');
      const finish = one(root, 'form.editor');
      assert.equal(one(finish, 'h2').textContent, `${P.editTitle} #9`);
      assert.equal(control(fieldRow(finish, S.usage.odometerStart)).value, '41120');
      const end = dateTime(fieldRow(finish, S.usage.end));
      assert.deepEqual([end.date.value, end.time.value], ['', ''], 'the end is still open');
      end.date.value = '2026-06-15';
      end.time.value = '12:00';
      await typeInto(control(fieldRow(finish, S.usage.odometerEnd)), '41150');
      await finish.fire('submit');
      await until(() => api.writes().length === 3, 'the open drive to be finished');
      const patched = api.writes()[2] as Json;
      assert.equal(`${patched.method} ${patched.path}`, 'PATCH /api/usage/9');
      assert.deepEqual(patched.body, {
        status: 'completed',
        start: at(-60),
        end: NOW,
        odometerStart: 41120,
        odometerEnd: 41150,
        note: 'Groceries',
        userId: ANNA.id,
        reservationId: 7,
      });
      await until(() => all(root, 'form.editor').length === 0 && toastEl.textContent === A.usage.saved, 'the editor to close after finishing');

      // ------------------------ whose kilometres: shown in the Drives table, and the admin can change it
      const usageRows = (): FakeElement[] => {
        const wrap = all(root, '.table-wrap').find((w) => w.getAttribute('aria-label') === A.tabs.usage);
        assert.ok(wrap, 'the drives table is on the page');
        return all(wrap, 'tbody tr');
      };
      const rowOf = (id: number): FakeElement => usageRows().find((tr) => all(tr, 'td')[0]?.textContent === String(id)) as FakeElement;
      const cells = (id: number): string[] => all(rowOf(id), 'td').map((td) => td.textContent);
      assert.equal(cells(3)[5], S.usage.km(120), 'the driver\'s own kilometres say nothing extra');
      assert.equal(cells(12)[5], `${S.usage.km(120)} · ${S.usage.kmOwnerPerson('Anna')}`, 'Ben drove, the kilometres are Anna\'s');
      assert.equal(cells(12)[1], 'Ben', 'the driver is still the driver');
      assert.equal(cells(12)[7], 'Took Anna to the station', 'with the note');
      assert.equal(cells(13)[5], `${S.usage.km(120)} · ${S.usage.kmOwnerTogether}`);

      await byText(rowOf(12), 'button', S.edit).fire('click');
      await until(() => all(root, 'form.editor').length === 1, 'the editor for the drive');
      const owned = one(root, 'form.editor');
      assert.equal(one(owned, 'label.check input').checked, true);
      assert.equal(control(fieldRow(owned, S.usage.kmWhose)).value, `person:${ANNA.id}`);
      assert.ok(fieldRow(owned, S.usage.noteRequired), 'the note is required while the kilometres are not the driver\'s own');
      // The admin hands the kilometres to everybody; the same request the member form sends.
      control(fieldRow(owned, S.usage.kmWhose)).value = 'together';
      await control(fieldRow(owned, S.usage.kmWhose)).fire('change');
      await owned.fire('submit');
      await until(() => api.writes().length === 4, 'the change to be sent');
      const refused = api.writes()[3] as Json;
      assert.equal(`${refused.method} ${refused.path}`, 'PATCH /api/usage/12');
      assert.deepEqual([refused.body.kmFor, refused.body.kmUserId, refused.body.note, refused.body.userId], ['together', null, 'Took Anna to the station', BEN.id]);

      // The server refuses (say the person was deactivated meanwhile): the editor stays open and the refusal shows
      // on the choice itself and in the form message, not as a silent failure.
      await until(() => !one(owned, 'p.form-error').hidden, 'the refusal to show');
      assert.equal(all(root, 'form.editor').length, 1, 'the editor stays open');
      assert.equal(errorOf(fieldRow(owned, S.usage.kmWhose)), S.fieldErrors.unknown_user);
      assert.equal(one(owned, 'p.form-error').textContent, S.errors.validation_failed);

      // Sending it again once the server accepts it: the same request, the refusal is cleared and the editor closes.
      ownerRefusal = null;
      await owned.fire('submit');
      await until(() => api.writes().length === 5, 'the second attempt to be sent');
      const changed = api.writes()[4] as Json;
      assert.equal(`${changed.method} ${changed.path}`, 'PATCH /api/usage/12');
      assert.deepEqual(changed.body, refused.body, 'the second attempt sends the same change');
      await until(() => all(root, 'form.editor').length === 0 && toastEl.textContent === A.usage.saved, 'the editor to close after the accepted change');

      // Giving the kilometres back to the driver has to be said in the request, since "self" is otherwise left out of it.
      await byText(rowOf(12), 'button', S.edit).fire('click');
      await until(() => all(root, 'form.editor').length === 1, 'the editor for the drive once more');
      const handBack = one(root, 'form.editor');
      const notMine = one(handBack, 'label.check input');
      assert.equal(notMine.checked, true, 'the list still says these are Anna\'s kilometres');
      notMine.checked = false;
      await notMine.fire('change');
      await handBack.fire('submit');
      await until(() => api.writes().length === 6, 'the hand-back to be sent');
      const back = api.writes()[5] as Json;
      assert.equal(`${back.method} ${back.path}`, 'PATCH /api/usage/12');
      assert.deepEqual([back.body.kmFor, back.body.kmUserId, back.body.userId], ['self', null, BEN.id]);
      await until(() => all(root, 'form.editor').length === 0, 'the editor to close after the hand-back');
    } finally {
      delete (globalThis as Json)['location'];
    }
  });
});
