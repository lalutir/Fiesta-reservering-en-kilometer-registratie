import { post } from '../api.js';
import { field, h } from '../dom.js';
import { S, errorText } from '../strings.js';

export const live = false;

/**
 * Who am I, change password, sign out, how to install the app.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement>}
 */
export async function render(app) {
  const { user } = app.session;
  const current = h('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', name: 'new', autocomplete: 'new-password', minlength: '10', required: true });
  const fCurrent = field(S.account.currentPassword, current);
  const fNext = field(S.account.newPassword, next);
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, S.account.savePassword);

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        fCurrent.setError(null);
        fNext.setError(null);
        formError.hidden = true;
        submit.disabled = true;
        try {
          await post('/api/auth/password', { currentPassword: current.value, newPassword: next.value });
          current.value = '';
          next.value = '';
          app.toast(S.account.passwordChanged);
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          fCurrent.setError(apiErr.fields['currentPassword']);
          fNext.setError(apiErr.fields['newPassword']);
          if (!Object.keys(apiErr.fields).length) {
            formError.textContent = errorText(apiErr);
            formError.hidden = false;
          }
        }
        submit.disabled = false;
      },
    },
    [h('h3', { text: S.account.changePassword }), fCurrent.row, fNext.row, formError, submit],
  );

  const signOut = h(
    'button',
    {
      class: 'btn block',
      type: 'button',
      onclick: async () => {
        try {
          await post('/api/auth/logout');
        } finally {
          await app.signedOut(true);
        }
      },
    },
    S.account.signOut,
  );

  return h('div', { class: 'account' }, [
    h('h2', { text: S.account.title }),
    h('section', { class: 'card' }, [
      h('p', {}, [h('strong', { text: S.account.signedInAs(user.displayName) }), ` (${user.username}, ${S.account.role[user.role]})`]),
      h('p', { class: 'hint', text: S.account.timeZone(app.tz) }),
      h('p', { class: 'hint', text: S.account.window(app.session.windowMonths) }),
    ]),
    form,
    signOut,
    h('section', { class: 'card' }, [
      h('h3', { text: S.account.installTitle }),
      h('p', { text: S.account.installAndroid }),
      h('p', { text: S.account.installIos }),
    ]),
  ]);
}
