// Every error the server can send for a person to read has a text in public/strings.js.
// Without one the app would show the raw code ("invalid_link") instead of a sentence.
// The check reads the server source for the codes it sends, so a new code without a
// text fails here, not in front of a user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S, errorText, fieldErrorText } from '../public/strings.js';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Codes only a broken client, a script or an attacker can trigger: the app never sends them, so it has no sentence for them. */
const NOT_FOR_PEOPLE: Record<string, string> = {
  bad_request: 'a malformed request',
  bad_json: 'a body that is not JSON',
  unsupported_media_type: 'a body that is not application/json',
  payload_too_large: 'a body over the size cap',
  csrf: 'a cross-site write, which the app never makes',
  must_be_string: 'a field of the wrong JSON type, which the forms never send',
  must_be_boolean: 'a field of the wrong JSON type, which the forms never send',
};

function emittedCodes(): { error: Map<string, string>; field: Map<string, string> } {
  const error = new Map<string, string>();
  const field = new Map<string, string>();
  for (const name of fs.readdirSync(src).filter((f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    const add = (into: Map<string, string>, re: RegExp) => {
      for (const m of text.matchAll(re)) into.set(m[1] as string, name);
    };
    add(error, /new HttpError\(\d+,\s*'([a-z_]+)'/g);
    add(error, /failIfAny\([^,]+,\s*'([a-z_]+)'/g);
    add(field, /\.fail\(\s*[^,]+,\s*'([a-z_]+)'/g);
    add(field, /(?:fields|errors)\[[^\]]+\]\s*=\s*'([a-z_]+)'/g);
    add(field, /new ValidationError\(\{[^}]*?:\s*'([a-z_]+)'/g);
  }
  return { error, field };
}

test('the scan finds the codes it is supposed to find (so the checks below are not vacuous)', () => {
  const { error, field } = emittedCodes();
  for (const code of ['draft_exists', 'has_paid_requests', 'already_paid', 'no_subscription', 'too_many_subscriptions', 'overlap', 'unauthenticated']) {
    assert.ok(error.has(code), `error code ${code} not found in src`);
  }
  for (const code of ['required', 'cannot_reopen', 'invalid_link', 'nothing_owed', 'must_not_be_below_start', 'must_be_empty', 'outside_window', 'in_future']) {
    assert.ok(field.has(code), `field code ${code} not found in src`);
  }
  assert.ok(error.size >= 20 && field.size >= 20, `only ${error.size} error and ${field.size} field codes found`);
});

test('every error code the server sends has a sentence, except the ones no person can run into', () => {
  const { error } = emittedCodes();
  const missing = [...error].filter(([code]) => !(code in S.errors) && !(code in NOT_FOR_PEOPLE)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, [], 'add these to S.errors in public/strings.js (or, if no person can trigger them, to NOT_FOR_PEOPLE with the reason)');
});

test('every field code the server sends has a sentence, except the ones no person can run into', () => {
  const { field } = emittedCodes();
  const missing = [...field].filter(([code]) => !(code in S.fieldErrors) && !(code in NOT_FOR_PEOPLE)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, [], 'add these to S.fieldErrors in public/strings.js (or, if no person can trigger them, to NOT_FOR_PEOPLE with the reason)');
});

test('the exceptions list stays honest: nothing on it has a sentence, and everything on it is still sent', () => {
  const { error, field } = emittedCodes();
  for (const code of Object.keys(NOT_FOR_PEOPLE)) {
    assert.ok(error.has(code) || field.has(code), `${code} is no longer sent: remove it from NOT_FOR_PEOPLE`);
  }
});

test('the text lookups give the sentence for a known code and fall back for an unknown one', () => {
  assert.equal(errorText({ code: 'draft_exists' }), S.errors.draft_exists);
  assert.equal(errorText({ code: 'no_such_code', message: 'Server said so' }), 'Server said so');
  assert.equal(errorText({ code: 'no_such_code' }), S.errors.error);
  assert.equal(fieldErrorText('invalid_link'), S.fieldErrors.invalid_link);
  assert.equal(fieldErrorText('no_such_code'), 'no_such_code');
});
