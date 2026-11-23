// Erzeugt ein VAPID-Schlüsselpaar (P-256) für Web Push.
// Ausgabe: öffentlicher Schlüssel (für js/config.js und wrangler.toml) und privater Schlüssel (Secret).
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', kp.publicKey);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.log('VAPID_PUBLIC_KEY=' + b64u(pub));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
