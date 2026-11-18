import { get, post } from '../api.js';
import { field, h } from '../dom.js';
import { S, errorText } from '../strings.js';

export const live = false;

/** How long to wait for the service worker before treating this browser as one without reminders. */
const READY_TIMEOUT_MS = 4000;
/** Signing out never waits longer than this for the reminder clean-up. */
const SIGN_OUT_WAIT_MS = 5000;

/**
 * The server's base64url public key as the bytes pushManager.subscribe() wants.
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function keyBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Can this browser receive reminders? An iPhone or iPad in a Safari tab cannot: it
 * only gets push once the app is installed on the Home Screen (iOS 16.4 or later),
 * so those get the install-first note instead of a plain "not supported".
 * @param {{ serviceWorker: boolean, pushManager: boolean, notification: boolean, ios: boolean }} env
 * @returns {'ready' | 'ios-install' | 'unsupported'}
 */
export function reminderSupport(env) {
  if (env.serviceWorker && env.pushManager && env.notification) return 'ready';
  return env.ios ? 'ios-install' : 'unsupported';
}

function currentEnvironment() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return { serviceWorker: 'serviceWorker' in navigator, pushManager: 'PushManager' in window, notification: 'Notification' in window, ios };
}

/** The service worker registration, or null when there is none within a few seconds. */
async function readyRegistration() {
  /** @type {Promise<ServiceWorkerRegistration | null>} */
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/** Tell the server and the browser that this device no longer gets reminders (nothing to do when it has no subscription). */
async function dropSubscription() {
  const registration = await readyRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/**
 * Best effort: stop this device getting reminders for the person who is signing out,
 * so a shared phone never shows somebody else's notifications. Never throws.
 */
async function unsubscribeThisDevice() {
  try {
    if ('serviceWorker' in navigator && 'PushManager' in window) await dropSubscription();
  } catch {
    // signing out must always work
  }
}

/**
 * The Reminders card: turn notifications on or off for this device and send a test.
 * Null when the server has reminders switched off.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement | null>}
 */
async function remindersCard(app) {
  const R = S.account.reminders;
  /** @type {{ enabled: boolean, publicKey?: string }} */
  let info;
  try {
    info = await get('/api/push/key');
  } catch {
    return null;
  }
  const publicKey = info.publicKey;
  if (!info.enabled || !publicKey) return null;

  const state = h('div', {});
  const message = h('p', { class: 'hint', role: 'status' });

  /**
   * Run one action with its button disabled; a failure is shown under the card.
   * @param {HTMLButtonElement} button
   * @param {() => Promise<void>} action
   */
  const guarded = async (button, action) => {
    button.disabled = true;
    message.textContent = '';
    try {
      await action();
    } catch (err) {
      const apiErr = /** @type {import('../api.js').ApiError} */ (err);
      message.textContent = apiErr.fields?.['endpoint'] === 'unsupported_endpoint' ? R.unsupportedEndpoint : errorText(apiErr);
    }
    button.disabled = false;
    // Turning reminders on or off swaps the buttons: keep keyboard and screen reader focus in the card.
    if (!button.isConnected) state.querySelector('button')?.focus();
  };

  const enable = async () => {
    // The permission question must be asked inside the tap, before any other waiting.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return paint();
    const registration = await readyRegistration();
    if (!registration) throw new Error(R.unsupported);
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    try {
      await post('/api/push/subscribe', subscription.toJSON());
    } catch (err) {
      // Do not keep a browser subscription the server refused.
      await subscription.unsubscribe().catch(() => false);
      throw err;
    }
    app.toast(R.enabledToast);
    return paint();
  };

  const disable = async () => {
    await dropSubscription();
    app.toast(R.disabledToast);
    return paint();
  };

  const sendTest = async () => {
    /** @type {{ sent: number }} */
    const result = await post('/api/push/test');
    if (result.sent > 0) app.toast(R.testSent);
    else message.textContent = R.testNotDelivered;
  };

  /** @param {string} label @param {() => Promise<void>} action @param {boolean} [primary] */
  const button = (label, action, primary = false) => {
    const el = h('button', { class: primary ? 'btn primary' : 'btn', type: 'button', onclick: () => void guarded(el, action) }, label);
    return el;
  };

  /** Show what this device can do: not supported, blocked, off or on. */
  async function paint() {
    const support = reminderSupport(currentEnvironment());
    const registration = support === 'ready' ? await readyRegistration() : null;
    if (support !== 'ready' || !registration) {
      state.replaceChildren(
        h('p', { class: 'notice', text: support === 'ios-install' ? R.iosInstall : R.unsupported }),
        h('p', { class: 'hint', text: R.fallback }),
      );
      return;
    }
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      state.replaceChildren(h('p', { text: R.on }), h('div', { class: 'actions' }, [button(R.disable, disable), button(R.test, sendTest)]));
    } else if (Notification.permission === 'denied') {
      state.replaceChildren(h('p', { class: 'notice', text: R.denied }), h('p', { class: 'hint', text: R.fallback }));
    } else {
      state.replaceChildren(h('p', { text: R.off }), h('div', { class: 'actions' }, [button(R.enable, enable, true)]));
    }
  }

  await paint();
  return h('section', { class: 'card' }, [h('h3', { text: R.title }), h('p', { text: R.intro }), state, message]);
}

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
          // Before the session ends, so the server still knows whose device this is.
          await Promise.race([unsubscribeThisDevice(), new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS))]);
          await post('/api/auth/logout');
        } finally {
          await app.signedOut(true);
        }
      },
    },
    S.account.signOut,
  );

  const reminders = await remindersCard(app);

  return h('div', { class: 'account' }, [
    h('h2', { text: S.account.title }),
    h('section', { class: 'card' }, [
      h('p', {}, [h('strong', { text: S.account.signedInAs(user.displayName) }), ` (${user.username}, ${S.account.role[user.role]})`]),
      h('p', { class: 'hint', text: S.account.timeZone(app.tz) }),
      h('p', { class: 'hint', text: S.account.window(app.session.windowMonths) }),
    ]),
    reminders,
    form,
    signOut,
    h('section', { class: 'card' }, [
      h('h3', { text: S.account.installTitle }),
      h('p', { text: S.account.installAndroid }),
      h('p', { text: S.account.installIos }),
    ]),
  ]);
}
