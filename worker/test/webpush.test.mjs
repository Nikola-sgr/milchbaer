// Prüft die Web-Push-Verschlüsselung gegen eine unabhängige Implementierung (http_ece)
// und die VAPID-Signatur mit Node-Crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthorization, b64uEncode, b64uDecode } from '../src/webpush.js';

function makeBrowserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: b64uEncode(ecdh.getPublicKey()), auth: b64uEncode(auth), authBuf: auth };
}

test('aes128gcm-Payload lässt sich vom Browser entschlüsseln', async () => {
  const ua = makeBrowserKeys();
  const message = JSON.stringify({ type: 'reminder', due: 1763900000000 });
  const body = await encryptPayload(new TextEncoder().encode(message), ua.p256dh, ua.auth);
  const plain = ece.decrypt(Buffer.from(body), {
    version: 'aes128gcm',
    privateKey: ua.ecdh,
    authSecret: ua.authBuf,
  });
  assert.equal(plain.toString('utf8'), message);
});

test('jede Nachricht nutzt neues Salz und neuen Server-Schlüssel', async () => {
  const ua = makeBrowserKeys();
  const a = await encryptPayload(new TextEncoder().encode('x'), ua.p256dh, ua.auth);
  const b = await encryptPayload(new TextEncoder().encode('x'), ua.p256dh, ua.auth);
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16));
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86));
  assert.equal(a[20], 65);
  assert.equal(new DataView(a.buffer).getUint32(16), 4096);
});

test('ungültige Browser-Schlüssel werden abgelehnt', async () => {
  const ua = makeBrowserKeys();
  await assert.rejects(encryptPayload(new Uint8Array(1), 'AAAA', ua.auth));
  await assert.rejects(encryptPayload(new Uint8Array(1), ua.p256dh, 'AAAA'));
});

test('VAPID-JWT ist korrekt aufgebaut und gültig signiert', async () => {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64uEncode(new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', kp.publicKey)));
  const privateKey = (await crypto.webcrypto.subtle.exportKey('jwk', kp.privateKey)).d;
  const subject = 'https://nikola-sgr.github.io/milchbaer/';
  const now = 1763900000;
  const header = await vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH1n2/abc', { publicKey, privateKey, subject }, now);

  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], publicKey);
  const [h, c, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, subject);
  assert.ok(claims.exp > now && claims.exp - now <= 24 * 3600);
  const sig = b64uDecode(s);
  assert.equal(sig.length, 64);
  const ok = await crypto.webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    kp.publicKey,
    sig,
    new TextEncoder().encode(h + '.' + c)
  );
  assert.ok(ok, 'Signatur ungültig');
});
