import { post } from '../api.js';
import { h, field } from '../dom.js';
import { S, errorText } from '../strings.js';

/** @typedef {import('../api.js').ApiError} ApiError */

/**
 * The sign-in screen (shown without the app shell).
 * @param {{ notice?: string | undefined, onSuccess: () => void }} opts
 * @returns {HTMLElement}
 */
export function render({ notice, onSuccess }) {
  const username = h('input', {
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    required: true,
  });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, S.login.submit);
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          await post('/api/auth/login', { username: username.value, password: password.value });
          onSuccess();
        } catch (err) {
          error.textContent = errorText(/** @type {ApiError} */ (err));
          error.hidden = false;
          password.value = '';
          submit.disabled = false;
          // The disabled button dropped focus; put it where the person has to type next.
          password.focus();
        }
      },
    },
    [field(S.login.username, username).row, field(S.login.password, password).row, error, submit],
  );
  return h('div', { class: 'login' }, [
    h('img', { class: 'logo', src: '/icons/icon-192.png', alt: '', width: '72', height: '72' }),
    h('h1', { text: S.appName }),
    notice ? h('p', { class: 'notice', text: notice }) : null,
    form,
    h('p', { class: 'hint center', text: S.login.hint }),
  ]);
}

export const live = false;
