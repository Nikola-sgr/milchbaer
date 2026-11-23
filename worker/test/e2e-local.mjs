// Ende-zu-Ende-Test des Backends gegen „wrangler dev --test-scheduled“ (lokale D1)
// mit einem nachgebauten Push-Dienst, der wie ein Browser entschlüsselt und die VAPID-Signatur prüft.
//
//   Terminal 1: npx wrangler d1 execute milchbaer --local --file schema.sql
//               npx wrangler dev --test-scheduled
//   Terminal 2: node test/e2e-local.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ece from 'http_ece';

const API = 'http://localhost:8787';
const ORIGIN = 'http://localhost:8080';
const PUSH_PORT = 9911;
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const VAPID_PUBLIC_KEY = /VAPID_PUBLIC_KEY\s*=\s*"([^"]+)"/.exec(toml)[1];

// --- nachgebauter Push-Dienst ---
const received = [];
const browsers = new Map();
function newBrowser(path) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  browsers.set(path, { ecdh, auth });
  return {
    endpoint: `http://127.0.0.1:${PUSH_PORT}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

async function verifyVapid(header) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || '');
  assert.ok(m, 'Authorization-Header fehlt oder falsch: ' + header);
  assert.equal(m[2], VAPID_PUBLIC_KEY);
  const [h, c, s] = m[1].split('.');
  const pub = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(m[2], 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(s, 'base64url'), Buffer.from(h + '.' + c));
  assert.ok(ok, 'VAPID-Signatur ungültig');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, `http://127.0.0.1:${PUSH_PORT}`);
  return claims;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      if (req.url === '/push/gone') {
        received.push({ path: req.url, gone: true });
        res.writeHead(410).end();
        return;
      }
      const claims = await verifyVapid(req.headers.authorization);
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      assert.ok(Number(req.headers.ttl) > 0);
      const b = browsers.get(req.url);
      const plain = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.auth });
      received.push({ path: req.url, data: JSON.parse(plain.toString()), claims, urgency: req.headers.urgency });
      res.writeHead(201).end();
    } catch (e) {
      console.error('Push-Dienst: Fehler', e.message);
      received.push({ path: req.url, error: e.message });
      res.writeHead(400).end();
    }
  });
});
await new Promise((r) => server.listen(PUSH_PORT, '127.0.0.1', r));

// --- Hilfen ---
async function call(method, path, body, origin = ORIGIN) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const cron = () => fetch(API + '/__scheduled?cron=*+*+*+*+*').then((r) => r.text()).then(() => sleep(800));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const take = () => received.splice(0, received.length);
function rows() {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'milchbaer', '--local', '--json', '--command', 'SELECT endpoint, due_at, test_at FROM subscriptions'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  return JSON.parse(out)[0].results;
}

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);

try {
  // CORS & Schutz
  let r = await fetch(API + '/reminder', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  ok('CORS-Preflight für erlaubte Herkunft');

  const a = newBrowser('/push/a');
  r = await call('PUT', '/reminder', { subscription: a, at: Date.now() + 3600e3 }, 'https://fremd.example');
  assert.equal(r.status, 403);
  ok('fremde Herkunft wird abgelehnt (403)');

  r = await call('PUT', '/reminder', { subscription: { ...a, endpoint: 'https://evil.example.com/x' }, at: null });
  assert.equal(r.status, 400);
  ok('unbekannter Push-Dienst wird abgelehnt (400)');

  r = await call('PUT', '/reminder', { subscription: a, at: Date.now() + 10 * 24 * 3600e3 });
  assert.equal(r.status, 400);
  ok('unplausibler Zeitpunkt wird abgelehnt (400)');

  // Planen in der Zukunft → nichts wird verschickt
  r = await call('PUT', '/reminder', { subscription: a, at: Date.now() + 3600e3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await cron();
  assert.equal(take().length, 0);
  ok('künftige Erinnerung wird gespeichert und noch nicht verschickt');

  // Stornieren (neue Sitzung gestartet)
  r = await call('PUT', '/reminder', { subscription: a, at: null });
  assert.equal(r.status, 200);
  assert.equal(rows().find((x) => x.endpoint.endsWith('/push/a')).due_at, null);
  ok('Erinnerung wird storniert (due_at = NULL)');

  // Fällige Erinnerung → genau einmal verschickt
  r = await call('PUT', '/reminder', { subscription: a, at: Date.now() - 1000 });
  assert.equal(r.status, 200);
  await cron();
  let got = take();
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].error, undefined, got[0].error);
  assert.equal(got[0].data.type, 'reminder');
  assert.equal(got[0].urgency, 'high');
  assert.equal(got[0].claims.sub, 'https://nikola-sgr.github.io/milchbaer/');
  await cron();
  assert.equal(take().length, 0);
  ok('fällige Erinnerung kommt genau einmal an, verschlüsselt und signiert');

  // Gespeicherte Daten: nur Abo + Zeitpunkt
  const stored = rows();
  assert.deepEqual(Object.keys(stored[0]).sort(), ['due_at', 'endpoint', 'test_at']);
  ok('Datenbank enthält nur Abo und Zeitpunkte');

  // Test-Erinnerung
  r = await call('POST', '/test', { subscription: a });
  assert.equal(r.status, 200);
  await cron();
  assert.equal(take().length, 0);
  await sleep(21_000);
  await cron();
  got = take();
  assert.equal(got.length, 1);
  assert.equal(got[0].data.type, 'test');
  ok('Test-Erinnerung kommt nach ca. 20 Sekunden beim nächsten Cron-Lauf');

  // Abgelaufenes Abo (410) wird gelöscht
  const g = newBrowser('/push/gone');
  await call('PUT', '/reminder', { subscription: g, at: Date.now() - 1000 });
  await cron();
  assert.equal(take()[0].gone, true);
  assert.equal(rows().filter((x) => x.endpoint.endsWith('/push/gone')).length, 0);
  ok('abgelaufenes Abo (410) wird automatisch entfernt');

  // Abmelden
  r = await call('DELETE', '/reminder', { endpoint: a.endpoint });
  assert.equal(r.status, 200);
  assert.equal(rows().length, 0);
  ok('Abmelden löscht das Abo vollständig');

  console.log('\nAlle Backend-Tests bestanden.');
} catch (e) {
  console.error('✖', e.message);
  process.exitCode = 1;
} finally {
  server.close();
}
