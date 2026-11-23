/*
 * Milchbär – Service Worker: Offline-Betrieb und Erinnerungen.
 * Bei jeder Änderung an App-Dateien VERSION erhöhen, damit die neue Fassung geladen wird.
 */
'use strict';

importScripts('js/config.js', 'js/logic.js', 'js/store.js');

const VERSION = 'v1.0.3';
const CACHE = 'milchbaer-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/config.js',
  'js/logic.js',
  'js/store.js',
  'js/bear.js',
  'js/app.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('milchbaer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Nur bei der Entwicklung auf „localhost“: erst Netz, dann Cache (Änderungen sofort sichtbar).
const DEV = self.location.hostname === 'localhost';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // z. B. Erinnerungs-Server: immer direkt ins Netz

  if (DEV) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() =>
        caches.match(req.mode === 'navigate' ? 'index.html' : req, { cacheName: CACHE, ignoreSearch: true })
      )
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { cacheName: CACHE }).then((hit) => hit || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});

// ---------- Erinnerungen ----------

async function reminderText(data) {
  if (data && data.type === 'test') {
    return '🐻 Das ist eine Test-Erinnerung. So leise melde ich mich, wenn es so weit ist.';
  }
  try {
    const [sessions, active] = await Promise.all([MB.store.allSessions(), MB.store.get('active')]);
    if (active) return '🐻 Du stillst gerade. Alles gut, lass dir Zeit.';
    return MB.logic.reminderBody(sessions, Date.now());
  } catch (e) {
    return '🐻 Vielleicht bald wieder Zeit zum Stillen?';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    reminderText(data).then((body) =>
      self.registration.showNotification('Sanfte Erinnerung', {
        body,
        tag: data && data.type === 'test' ? 'milchbaer-test' : 'milchbaer-reminder',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        lang: 'de',
        data: { url: './' },
      })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
