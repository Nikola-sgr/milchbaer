/*
 * Web Push ohne Abhängigkeiten, nur mit WebCrypto.
 * - Verschlüsselung nach RFC 8291 (Content-Encoding: aes128gcm, RFC 8188)
 * - Absender-Authentifizierung per VAPID nach RFC 8292 (ES256-JWT)
 */

const enc = new TextEncoder();

export function b64uEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Verschlüsselt payload (Uint8Array) für ein Push-Abo.
 * @param {Uint8Array} payload
 * @param {string} p256dh  öffentlicher Schlüssel des Browsers (base64url, 65 Bytes)
 * @param {string} auth    Auth-Secret des Browsers (base64url, 16 Bytes)
 * @param {object} [testing] nur für Tests: feste Werte { salt, serverKeys }
 */
export async function encryptPayload(payload, p256dh, auth, testing) {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh ungültig');
  if (authSecret.length !== 16) throw new Error('auth ungültig');

  const serverKeys =
    (testing && testing.serverKeys) ||
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256)
  );

  // RFC 8291, Abschnitt 3.4
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = (testing && testing.salt) || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Ein einziger Datensatz: Klartext + Trennzeichen 0x02 (letzter Datensatz), ohne Padding
  const plaintext = concat(payload, new Uint8Array([2]));
  const recordSize = 4096;
  if (plaintext.length + 16 > recordSize) throw new Error('Nachricht zu groß');
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext)
  );

  // Header: salt (16) | record size (4) | keyid-Länge (1) | keyid = Server-Public-Key (65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

let vapidKeyCache = null;

async function vapidSigningKey(publicKeyB64u, privateKeyB64u) {
  const cacheKey = publicKeyB64u + '|' + privateKeyB64u;
  if (vapidKeyCache && vapidKeyCache.cacheKey === cacheKey) return vapidKeyCache.key;
  const pub = b64uDecode(publicKeyB64u);
  if (pub.length !== 65) throw new Error('VAPID_PUBLIC_KEY ungültig');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKeyB64u,
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  vapidKeyCache = { cacheKey, key };
  return key;
}

/** Erzeugt den Authorization-Header „vapid t=…, k=…“ für den Push-Dienst des Endpoints. */
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, nowSec) {
  const aud = new URL(endpoint).origin;
  const iat = nowSec || Math.floor(Date.now() / 1000);
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud, exp: iat + 12 * 3600, sub: subject })));
  const unsigned = header + '.' + claims;
  const key = await vapidSigningKey(publicKey, privateKey);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return 'vapid t=' + unsigned + '.' + b64uEncode(sig) + ', k=' + publicKey;
}

/**
 * Sendet eine Push-Nachricht.
 * @returns {Promise<{status:number, ok:boolean, gone:boolean, text:string}>}
 */
export async function sendWebPush(subscription, data, vapid, options = {}) {
  const body = await encryptPayload(enc.encode(JSON.stringify(data)), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl ?? 3600),
      Urgency: options.urgency || 'high',
      ...(options.topic ? { Topic: options.topic } : {}),
    },
    body,
  });
  const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, text };
}
