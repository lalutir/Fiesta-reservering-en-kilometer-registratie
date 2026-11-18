// The other side of a push message, for tests only: what a browser does with an
// encrypted payload (RFC 8291) and what a push service does with a VAPID token
// (RFC 8292). Kept out of src/ because the server never receives either.
import crypto from 'node:crypto';
import { fromB64u, toB64u } from '../src/webpush.ts';

function publicKeyObject(publicKey: string): crypto.KeyObject {
  const raw = fromB64u(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('A P-256 public key is 65 bytes starting with 0x04');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toB64u(raw.subarray(1, 33)), y: toB64u(raw.subarray(33)) }, format: 'jwk' });
}

/** Check a token's signature against a public key (what a push service does). Returns its claims, or undefined. */
export function verifyVapidToken(token: string, publicKey: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, claims, signature] = parts as [string, string, string];
  try {
    const good = crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' }, fromB64u(signature));
    if (!good) return undefined;
    return {
      header: JSON.parse(fromB64u(header).toString('utf8')) as Record<string, unknown>,
      claims: JSON.parse(fromB64u(claims).toString('utf8')) as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

/**
 * Decrypt a body made by encryptPayload with the subscriber's private key and
 * auth secret. (Browsers do this themselves.)
 */
export function decryptPayload(body: Uint8Array, uaPrivate: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array): Buffer {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLength = buf[20] as number;
  const asPublic = buf.subarray(21, 21 + idLength);
  const record = buf.subarray(21 + idLength);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublic), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // Strip the padding delimiter (0x02) and anything after it.
  const end = padded.lastIndexOf(2);
  return padded.subarray(0, end);
}
