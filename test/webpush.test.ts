import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, fromB64u, generateVapidKeys, publicKeyOf, toB64u, vapidAuthorization, vapidToken } from '../src/webpush.ts';
import { decryptPayload, verifyVapidToken } from './webpush-peer.ts';

// --- RFC 8291, section 5 and appendix A: the worked example ("When I grow up, I want to be a watermelon").
// The strings below are copied from the RFC text (rfc-editor.org/rfc/rfc8291), not typed from memory.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 known answer: the example message encrypts to exactly the body in the RFC', () => {
  const body = encryptPayload(Buffer.from(RFC8291.plaintext), fromB64u(RFC8291.uaPublic), fromB64u(RFC8291.auth), {
    salt: fromB64u(RFC8291.salt),
    asPrivate: fromB64u(RFC8291.asPrivate),
  });
  assert.equal(toB64u(body), RFC8291.body);
  // (The RFC's sample request prints Content-Length: 145, but its body text is 192 base64 characters = 144 bytes.)
  assert.equal(body.length, 144);
  // The pieces the RFC lists: the header is salt | record size 4096 | key id length 65 | our public key.
  assert.equal(toB64u(body.subarray(0, 16)), RFC8291.salt);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(toB64u(body.subarray(21, 86)), RFC8291.asPublic);
  // And the shared secret in the RFC is what our two key pairs agree on.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(RFC8291.asPrivate));
  assert.equal(toB64u(ecdh.computeSecret(fromB64u(RFC8291.uaPublic))), RFC8291.ecdhSecret);
});

test('RFC 8291: the receiver (with the example private key) reads the example body back', () => {
  const plain = decryptPayload(fromB64u(RFC8291.body), fromB64u(RFC8291.uaPrivate), fromB64u(RFC8291.uaPublic), fromB64u(RFC8291.auth));
  assert.equal(plain.toString('utf8'), RFC8291.plaintext);
});

test('every message gets a fresh salt and sender key; a tampered or mis-addressed body does not decrypt', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const a = encryptPayload(Buffer.from('same text'), ua.getPublicKey(), auth);
  const b = encryptPayload(Buffer.from('same text'), ua.getPublicKey(), auth);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt');
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'sender key');
  assert.equal(decryptPayload(a, ua.getPrivateKey(), ua.getPublicKey(), auth).toString(), 'same text');
  const flipped = Buffer.from(a);
  flipped[flipped.length - 20] = (flipped[flipped.length - 20] as number) ^ 1;
  assert.throws(() => decryptPayload(flipped, ua.getPrivateKey(), ua.getPublicKey(), auth), /auth/i);
  assert.throws(() => decryptPayload(a, ua.getPrivateKey(), ua.getPublicKey(), crypto.randomBytes(16)));
  const other = crypto.createECDH('prime256v1');
  other.generateKeys();
  assert.throws(() => decryptPayload(a, other.getPrivateKey(), other.getPublicKey(), auth));
});

test('encryption refuses malformed subscription keys and oversized payloads', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  assert.throws(() => encryptPayload(Buffer.from('x'), ua.getPublicKey().subarray(0, 64), auth), /65-byte/);
  assert.throws(() => encryptPayload(Buffer.from('x'), Buffer.concat([Buffer.from([2]), ua.getPublicKey().subarray(1)]), auth), /65-byte/);
  assert.throws(() => encryptPayload(Buffer.from('x'), ua.getPublicKey(), crypto.randomBytes(15)), /auth/);
  assert.throws(() => encryptPayload(Buffer.alloc(4000), ua.getPublicKey(), auth), /fit/);
  assert.throws(() => encryptPayload(Buffer.from('x'), ua.getPublicKey(), auth, { salt: Buffer.alloc(8) }), /salt/);
  const notOnCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
  assert.throws(() => encryptPayload(Buffer.from('x'), notOnCurve, auth));
  assert.equal(encryptPayload(Buffer.alloc(3993), ua.getPublicKey(), auth).length, 4096, 'the largest message fills exactly one 4096-byte record');
});

// --- VAPID (RFC 8292)

// The example in RFC 8292 section 2 (Figure 1), copied from the RFC text. A signature cannot be reproduced
// (ECDSA is randomised), so what is known-answer here is the VERIFICATION side: our verifier accepts the RFC's
// own token with the RFC's own key, and rejects it with any other key or any change.
const RFC8292 = {
  token:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.' +
    'i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  publicKey: 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
};

test('RFC 8292: the example token from the RFC verifies with the example key, and only with it', () => {
  const ok = verifyVapidToken(RFC8292.token, RFC8292.publicKey);
  assert.ok(ok, 'the RFC example verifies');
  assert.deepEqual({ ...ok.header }, { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual({ ...ok.claims }, { aud: 'https://push.example.net', exp: 1453523768, sub: 'mailto:push@example.com' });
  assert.equal(verifyVapidToken(RFC8292.token, generateVapidKeys().publicKey), undefined, 'another key does not verify it');
  const [h, c, s] = RFC8292.token.split('.') as [string, string, string];
  const changed = Buffer.from(c, 'base64url').toString().replace('push.example.net', 'push.evil.example');
  assert.equal(verifyVapidToken(`${h}.${toB64u(Buffer.from(changed))}.${s}`, RFC8292.publicKey), undefined, 'a changed claim does not verify');
  assert.equal(verifyVapidToken('not.a.token', RFC8292.publicKey), undefined);
  assert.equal(verifyVapidToken(RFC8292.token, 'short'), undefined);
});

test('VAPID: our own token has the documented shape, expires within 24 hours and verifies with the advertised public key', () => {
  const keys = generateVapidKeys();
  const now = Date.parse('2026-06-15T10:00:00.000Z');
  assert.equal(fromB64u(keys.publicKey).length, 65);
  assert.equal(fromB64u(keys.publicKey)[0], 4);
  assert.equal(publicKeyOf(keys.privateJwk), keys.publicKey);

  const token = vapidToken('https://fcm.googleapis.com/fcm/send/abc?x=1', 'https://car.example.test', keys, now);
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  assert.equal(fromB64u(parts[2] as string).length, 64, 'ES256 signature is the raw r|s pair, not DER');
  const checked = verifyVapidToken(token, keys.publicKey);
  assert.ok(checked);
  assert.deepEqual({ ...checked.header }, { typ: 'JWT', alg: 'ES256' });
  assert.equal(checked.claims['aud'], 'https://fcm.googleapis.com', 'the audience is the origin of the push service, without path');
  assert.equal(checked.claims['sub'], 'https://car.example.test');
  const exp = checked.claims['exp'] as number;
  assert.ok(exp > now / 1000 && exp - now / 1000 <= 24 * 3600, 'expires within 24 hours (RFC 8292 section 2)');
  assert.equal(verifyVapidToken(token, generateVapidKeys().publicKey), undefined);

  const header = vapidAuthorization('https://web.push.apple.com/abc', 'mailto:me@example.com', keys, now);
  const m = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], keys.publicKey);
  assert.equal(verifyVapidToken(m[1] as string, keys.publicKey)?.claims['aud'], 'https://web.push.apple.com');
});

test('the private key survives being stored as JSON and signs the same way afterwards', () => {
  const keys = generateVapidKeys();
  const reloaded = { privateJwk: JSON.parse(JSON.stringify(keys.privateJwk)), publicKey: keys.publicKey };
  const token = vapidToken('https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://car.example.test', reloaded, Date.now());
  assert.ok(verifyVapidToken(token, keys.publicKey));
  assert.equal(typeof keys.privateJwk.d, 'string', 'the JWK holds the private part, which is why it lives in the database and never in a response');
});
