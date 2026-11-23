# 🐻 Milchbär

Eine ruhige, minimalistische Still-App für das iPhone, gebaut als Progressive Web App.

**App:** https://nikola-sgr.github.io/milchbaer/
**Installation auf dem iPhone:** siehe [ANLEITUNG.md](ANLEITUNG.md)

## Was die App kann

- Stillsitzung mit einem Tipp starten (Links / Rechts), großer Timer, großer Stopp-Button
- Der Timer rechnet immer „jetzt minus Startzeit“. Der Start liegt dauerhaft im Gerät, eine laufende Sitzung läuft nach dem Schließen und Wiederöffnen einfach weiter.
- Hinweis, welche Seite zuletzt dran war und wie lange das her ist
- Verlauf nach Tagen mit Anzahl und Gesamtdauer, Einträge löschen
- Export und Import als JSON-Datei
- Sanfte Erinnerungen per Web Push (ab iOS 16.4, nur als Home-Bildschirm-App), getrennt für Tag und Nacht, mit Vorschlag aus den letzten 3 Tagen
- Heller und dunkler Modus, komplett offline nutzbar

## Datenschutz

Alle Stilldaten bleiben in IndexedDB auf dem Gerät. Das Backend kennt nur das Push-Abo und den Zeitpunkt der nächsten Erinnerung. Den Text der Erinnerung („Es ist 2½ Std. her, zuletzt Links …“) baut der Service Worker auf dem iPhone selbst aus den lokalen Daten.

## Aufbau

```
index.html, styles.css    Oberfläche
js/logic.js               Reine Logik: Mahlzeiten, Erinnerungsplanung, Formatierung, Import/Export
js/store.js               IndexedDB
js/app.js                 Ablauf und Bedienung
js/bear.js                Der Bär (SVG)
js/config.js              Adresse des Backends und öffentlicher VAPID-Schlüssel
sw.js                     Service Worker: Offline-Cache, Push, Benachrichtigungen
manifest.webmanifest      Web-App-Manifest
icons/                    App-Icons (erzeugt mit tools/make-icons.mjs)
worker/                   Erinnerungs-Backend: Cloudflare Worker + D1 + Cron (jede Minute)
tests/                    Tests für js/logic.js
tools/                    Nur für die Entwicklung (Icons, VAPID-Schlüssel)
```

Kein Framework, kein Build-Schritt. GitHub Pages liefert die Dateien direkt aus.

## Entwickeln

```bash
python3 -m http.server 8080          # App unter http://localhost:8080
```

Auf `localhost` lädt der Service Worker immer zuerst aus dem Netz, damit Änderungen sofort sichtbar sind. In Produktion gilt „erst Cache“.

**Wichtig bei jeder Änderung an App-Dateien:** `VERSION` in `sw.js` erhöhen, sonst sehen installierte Apps die neue Fassung nicht.

Backend lokal:

```bash
cd worker
npm install
npx wrangler d1 execute milchbaer --local --file schema.sql
npx wrangler dev --test-scheduled    # http://localhost:8787, Cron auslösen: /__scheduled
```

Für lokale Tests braucht `worker/.dev.vars` den privaten VAPID-Schlüssel (`VAPID_PRIVATE_KEY=…`) und `ALLOW_INSECURE_ENDPOINTS=1`. Die Datei ist nicht im Repository.

## Tests

```bash
node --test tests/                   # Logik der App
cd worker && npm test                # Web-Push-Verschlüsselung (RFC 8291) und VAPID-Signatur
cd worker && node test/e2e-local.mjs # Backend Ende-zu-Ende gegen "wrangler dev" (läuft parallel)
```

## Backend veröffentlichen

```bash
cd worker
npx wrangler login
npx wrangler d1 create milchbaer --location weur      # database_id in wrangler.toml eintragen
npx wrangler d1 execute milchbaer --remote --file schema.sql
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

Danach die Worker-Adresse in `js/config.js` (`PUSH_API_URL`) eintragen (aktuell `https://milchbaer-push.milchbaer-push.workers.dev`).

Neue VAPID-Schlüssel erzeugt `node tools/gen-vapid.mjs`. Nach einem Schlüsselwechsel melden sich die Geräte beim nächsten Öffnen der App automatisch neu an.

Kosten: Alles läuft im kostenlosen Rahmen von GitHub Pages und Cloudflare Workers (inkl. D1 und Cron-Trigger).
