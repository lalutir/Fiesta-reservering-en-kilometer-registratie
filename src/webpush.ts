// Web Push cryptography on node:crypto, no dependency. Pure functions only: no
// database, no network, no clock, so every piece can be tested against a
// known-answer vector.
//
//   - VAPID (RFC 8292): an ES256 JSON Web Token that proves to the push service
//     which application server is sending, plus the public key it is verified with.
//   - Message encryption (RFC 8291, content coding aes128gcm from RFC 8188): the
//     payload is encrypted for one browser subscription (its p256dh public key
//     and auth secret) so the push service only ever sees ciphertext.
import crypto from 'node:crypto';

export const toB64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url');

// ------------------------------------------------------------------- VAPID

export interface VapidKeys {
  /** The private key as a JSON Web Key (kty EC, crv P-256, with d). Secret. */
  privateJwk: crypto.JsonWebKey;
  /** The uncompressed public point (0x04 | x | y) as base64url: what browsers take as applicationServerKey. */
  publicKey: string;
}

/** The base64url public point of a P-256 JWK. */
export function publicKeyOf(jwk: crypto.JsonWebKey): string {
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Not an EC public key');
  return toB64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  return { privateJwk, publicKey: publicKeyOf(privateJwk) };
}

/** The ES256 token (header.claims.signature, signature as raw r|s) for one push service origin. */
export function vapidToken(endpoint: string, subject: string, keys: VapidKeys, nowMs: number, lifetimeSeconds = 12 * 3600): string {
  const header = toB64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toB64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + lifetimeSeconds, sub: subject })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${toB64u(signature)}`;
}

/** The Authorization header value: "vapid t=<token>, k=<public key>". */
export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, nowMs: number): string {
  return `vapid t=${vapidToken(endpoint, subject, keys, nowMs)}, k=${keys.publicKey}`;
}

// ------------------------------------------------------------- encryption

const RECORD_SIZE = 4096;

/**
 * Encrypt one message for one subscription (RFC 8291 section 3 and 4 with the
 * aes128gcm coding): a single record, padding delimiter 0x02, no extra padding.
 * `uaPublic` is the browser's p256dh point (65 bytes), `authSecret` its 16-byte
 * auth secret. `salt` and `asPrivate` exist only so a test can reproduce the
 * example in the RFC; in use both are random per message.
 * Returns the whole request body: header (salt, record size, key id = our public
 * key) followed by the ciphertext and its tag.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: { salt?: Uint8Array; asPrivate?: Uint8Array } = {},
): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error('Payload does not fit in one record');
  const salt = opts.salt ?? crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(Buffer.from(opts.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(Buffer.from(uaPublic));

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}
