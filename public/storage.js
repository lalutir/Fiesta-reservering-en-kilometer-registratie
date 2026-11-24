// The one place that touches the browser's storage. Storage can be missing or blocked (a private window, cookies
// turned off, a full disk), and the access itself can throw, so every call is wrapped and the app never needs the
// answer: a read that fails is "nothing stored", a write that fails is "not saved", and the page works either way.
//
// What is kept here is only a convenience of this device: the theme choice and the unsent text of a form
// (public/drafts.js). Never a password, a session or anything the server is the source of truth for.

/**
 * @param {string} key
 * @returns {string | null} null when there is nothing, or when storage cannot be read
 */
export function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean} false when it could not be saved
 */
export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing stored, or nothing we may touch: either way it is gone for this page
  }
}

/**
 * @param {string} prefix
 * @returns {string[]} the stored keys that start with the prefix (empty when storage cannot be read)
 */
export function storageKeys(prefix) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
