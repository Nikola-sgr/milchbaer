/*
 * Milchbär – lokale Speicherung in IndexedDB.
 * Stores: "sessions" (abgeschlossene Sitzungen), "kv" (laufende Sitzung, Einstellungen, Zustand).
 * Wird von App und Service Worker genutzt.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'milchbaer';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('start', 'start');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
    return dbPromise;
  }

  /** Führt fn in einer Transaktion aus und liefert nach dem Commit das Ergebnis. */
  function run(stores, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(stores, mode);
          const out = fn(t);
          t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out && 'readyState' in out ? out.result : out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
        })
    );
  }

  const store = {
    allSessions() {
      return run('sessions', 'readonly', (t) => t.objectStore('sessions').getAll()).then((list) =>
        (list || []).sort((a, b) => a.start - b.start)
      );
    },
    putSessions(list) {
      return run('sessions', 'readwrite', (t) => {
        const st = t.objectStore('sessions');
        for (const s of list) st.put(s);
      });
    },
    deleteSession(id) {
      return run('sessions', 'readwrite', (t) => {
        t.objectStore('sessions').delete(id);
      });
    },
    /** Sitzung speichern und laufende Sitzung in einem Schritt entfernen. */
    finishSession(session) {
      return run(['sessions', 'kv'], 'readwrite', (t) => {
        t.objectStore('sessions').put(session);
        t.objectStore('kv').delete('active');
      });
    },
    get(key) {
      return run('kv', 'readonly', (t) => t.objectStore('kv').get(key));
    },
    set(key, value) {
      return run('kv', 'readwrite', (t) => {
        t.objectStore('kv').put(value, key);
      });
    },
    del(key) {
      return run('kv', 'readwrite', (t) => {
        t.objectStore('kv').delete(key);
      });
    },
  };

  root.MB = root.MB || {};
  root.MB.store = store;
})(typeof self !== 'undefined' ? self : globalThis);
