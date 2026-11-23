-- Milchbär: nur Push-Abo und nächster Erinnerungszeitpunkt, keine Stilldaten.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,          -- SHA-256 des Endpoints
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  due_at INTEGER,               -- nächste Erinnerung (ms seit 1970) oder NULL
  test_at INTEGER,              -- Test-Erinnerung (ms) oder NULL
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_due ON subscriptions (due_at);
CREATE INDEX IF NOT EXISTS idx_test ON subscriptions (test_at);
