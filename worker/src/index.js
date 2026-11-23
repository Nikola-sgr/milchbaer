/*
 * Milchbär – Erinnerungs-Backend (Cloudflare Worker + D1 + Cron).
 *
 * Gespeichert wird pro Gerät ausschließlich:
 *   - das Push-Abo (Endpoint + Schlüssel des Browsers)
 *   - der Zeitpunkt der nächsten Erinnerung (und ggf. einer Test-Erinnerung)
 * Keine Stilldaten. Den Text der Erinnerung baut der Service Worker auf dem iPhone
 * aus den lokal gespeicherten Daten selbst zusammen.
 *
 * API (JSON):
 *   PUT    /reminder  { subscription, at }   at = Zeitpunkt in ms oder null (= stornieren)
 *   DELETE /reminder  { endpoint }           Abo komplett entfernen
 *   POST   /test      { subscription }       Test-Erinnerung in ca. einer Minute
 */
import { sendWebPush, b64uDecode } from './webpush.js';

const MAX_BODY = 4096;
const MAX_ROWS = 2000;
const MAX_AHEAD = 24 * 3600 * 1000;
const TEST_DELAY = 20 * 1000;
const STALE_AFTER = 90 * 24 * 3600 * 1000;

const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const h = { Vary: 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'PUT, POST, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) },
  });
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

function checkEndpoint(endpoint, env) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (e) {
    throw new HttpError(400, 'Endpoint ungültig');
  }
  if (env.ALLOW_INSECURE_ENDPOINTS === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url.toString();
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, 'Unbekannter Push-Dienst');
  }
  return url.toString();
}

function checkSubscription(sub, env) {
  if (!sub || typeof sub !== 'object' || !sub.keys) throw new HttpError(400, 'Push-Abo fehlt');
  const endpoint = checkEndpoint(sub.endpoint, env);
  const { p256dh, auth } = sub.keys;
  let ok = false;
  try {
    ok = b64uDecode(p256dh).length === 65 && b64uDecode(auth).length === 16;
  } catch (e) {
    ok = false;
  }
  if (!ok) throw new HttpError(400, 'Schlüssel des Push-Abos ungültig');
  return { endpoint, p256dh, auth };
}

async function idFor(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureCapacity(env, id) {
  const existing = await env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ?1').bind(id).first();
  if (existing) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first();
  if (row && row.n >= MAX_ROWS) throw new HttpError(503, 'Zu viele Abos');
}

async function upsert(env, sub, fields) {
  const id = await idFor(sub.endpoint);
  await ensureCapacity(env, id);
  const now = Date.now();
  if ('due_at' in fields) {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, endpoint, p256dh, auth, due_at, test_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
       ON CONFLICT(id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         due_at = excluded.due_at, updated_at = excluded.updated_at`
    )
      .bind(id, sub.endpoint, sub.p256dh, sub.auth, fields.due_at, now)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, endpoint, p256dh, auth, due_at, test_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         test_at = excluded.test_at, updated_at = excluded.updated_at`
    )
      .bind(id, sub.endpoint, sub.p256dh, sub.auth, fields.test_at, now)
      .run();
  }
  return id;
}

async function handle(request, env, url) {
  if (url.pathname === '/reminder' && request.method === 'PUT') {
    const body = await readJson(request);
    const sub = checkSubscription(body.subscription, env);
    let at = body.at;
    if (at !== null && at !== undefined) {
      at = Number(at);
      const now = Date.now();
      if (!Number.isFinite(at) || at < now - 3600 * 1000 || at > now + MAX_AHEAD) {
        throw new HttpError(400, 'Zeitpunkt ungültig');
      }
      at = Math.round(at);
    } else {
      at = null;
    }
    await upsert(env, sub, { due_at: at });
    return { ok: true, at };
  }

  if (url.pathname === '/reminder' && request.method === 'DELETE') {
    const body = await readJson(request);
    const endpoint = checkEndpoint(body.endpoint, env);
    await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?1').bind(await idFor(endpoint)).run();
    return { ok: true };
  }

  if (url.pathname === '/test' && request.method === 'POST') {
    const body = await readJson(request);
    const sub = checkSubscription(body.subscription, env);
    const at = Date.now() + TEST_DELAY;
    await upsert(env, sub, { test_at: at });
    return { ok: true, at };
  }

  throw new HttpError(404, 'Nicht gefunden');
}

/** Wird vom Cron-Trigger jede Minute aufgerufen: fällige Erinnerungen verschicken. */
export async function runDue(env, now = Date.now()) {
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, due_at, test_at FROM subscriptions
     WHERE (due_at IS NOT NULL AND due_at <= ?1) OR (test_at IS NOT NULL AND test_at <= ?1)
     LIMIT 200`
  )
    .bind(now)
    .all();

  const report = { sent: 0, removed: 0, failed: 0 };
  for (const row of results || []) {
    // Zuerst als erledigt markieren, damit nichts doppelt verschickt wird.
    await env.DB.prepare(
      `UPDATE subscriptions SET
         due_at = CASE WHEN due_at <= ?2 THEN NULL ELSE due_at END,
         test_at = CASE WHEN test_at <= ?2 THEN NULL ELSE test_at END
       WHERE id = ?1`
    )
      .bind(row.id, now)
      .run();

    const jobs = [];
    if (row.due_at !== null && row.due_at <= now) jobs.push({ type: 'reminder', due: row.due_at });
    if (row.test_at !== null && row.test_at <= now) jobs.push({ type: 'test' });

    for (const data of jobs) {
      try {
        const res = await sendWebPush(row, data, vapid, { ttl: data.type === 'test' ? 600 : 3600, urgency: 'high' });
        if (res.ok) {
          report.sent++;
        } else if (res.gone) {
          await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?1').bind(row.id).run();
          report.removed++;
          break;
        } else {
          report.failed++;
          console.warn('Push fehlgeschlagen', res.status, res.text);
        }
      } catch (e) {
        report.failed++;
        console.warn('Push-Fehler', e && e.message);
      }
    }
  }

  // Einmal pro Stunde verwaiste Abos ohne Aktivität aufräumen.
  if (new Date(now).getUTCMinutes() === 0) {
    await env.DB.prepare('DELETE FROM subscriptions WHERE updated_at < ?1 AND due_at IS NULL AND test_at IS NULL')
      .bind(now - STALE_AFTER)
      .run();
  }
  return report;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'milchbaer-push' }, 200, cors);
    }
    if (!origin || !allowedOrigins(env).includes(origin)) {
      return json({ error: 'Herkunft nicht erlaubt' }, 403, cors);
    }
    try {
      return json(await handle(request, env, url), 200, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Interner Fehler' : e.message }, status, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDue(env).then((r) => {
        if (r.sent || r.removed || r.failed) console.log('Erinnerungen', JSON.stringify(r));
      })
    );
  },
};
