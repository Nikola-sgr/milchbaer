/*
 * Milchbär – reine Logik ohne DOM.
 * Wird von der App (index.html) und vom Service Worker (sw.js) geladen.
 */
(function (root) {
  'use strict';

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /** Beginnt eine Sitzung höchstens so lange nach dem Ende der vorigen, gehört sie zur selben Mahlzeit. */
  const MEAL_GAP = 15 * MIN;

  const LIMITS = {
    dayIntervalMin: { min: 90, max: 240, step: 15 },
    nightIntervalMin: { min: 120, max: 360, step: 15 },
  };

  const DEFAULT_SETTINGS = Object.freeze({
    remindersEnabled: false,
    dayIntervalMin: 150,
    nightIntervalMin: 210,
    nightRemindersEnabled: true,
    nightStart: '22:00',
    nightEnd: '06:00',
    theme: 'auto',
  });

  const SIDES = { left: 'Links', right: 'Rechts' };

  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function withDefaults(settings) {
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  function sideLabel(side) {
    return SIDES[side] || '–';
  }

  function makeId(start) {
    const rnd = Math.random().toString(36).slice(2, 8);
    return 's_' + Number(start || Date.now()).toString(36) + '_' + rnd;
  }

  // ---------- Formatierung ----------

  /** Laufender Timer: mm:ss (Minuten dürfen über 59 gehen). */
  function formatTimer(ms) {
    const total = Math.max(0, Math.floor(ms / SEC));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function formatClock(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatMinutes(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return m + ' Min.';
    if (m === 0) return h + ' Std.';
    return h + ' Std. ' + m + ' Min.';
  }

  /** Dauer einer Sitzung: „40 Sek.“, „12 Min.“, „1 Std. 5 Min.“ */
  function formatDuration(ms) {
    const sec = Math.max(0, Math.round(ms / SEC));
    if (sec < 60) return sec + ' Sek.';
    return formatMinutes(Math.round(sec / 60));
  }

  /** Abstand in den Einstellungen: „2½ Std.“, „2 Std. 45 Min.“ */
  function formatInterval(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (m === 30 && h > 0) return h + '½ Std.';
    return formatMinutes(min);
  }

  /** „gerade eben“, „vor 12 Min.“, „vor 2 Std. 10 Min.“, „vor 2 Tagen“ */
  function formatAgo(ms) {
    const min = Math.floor(Math.max(0, ms) / MIN);
    if (min < 1) return 'gerade eben';
    if (min < 24 * 60) return 'vor ' + formatMinutes(min);
    const days = Math.floor(min / (24 * 60));
    return days === 1 ? 'vor 1 Tag' : 'vor ' + days + ' Tagen';
  }

  /** Weiche Angabe für die Erinnerung: „2½ Std.“ nahe einer halben Stunde, sonst genau. */
  function formatSoft(ms) {
    const min = Math.round(Math.max(0, ms) / MIN);
    if (min < 60) return min + ' Min.';
    const halves = Math.round(min / 30);
    if (Math.abs(halves * 30 - min) <= 5) {
      const h = Math.floor(halves / 2);
      return h + (halves % 2 === 1 ? '½' : '') + ' Std.';
    }
    return formatMinutes(min);
  }

  function isoLocal(ts) {
    const d = new Date(ts);
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      (off >= 0 ? '+' : '-') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60)
    );
  }

  // ---------- Tage ----------

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  const dayFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long' });
  const dayFormatYear = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

  function dayLabel(ts, now) {
    const today = startOfDay(now);
    const day = startOfDay(ts);
    if (day === today) return 'Heute';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (day === yesterday.getTime()) return 'Gestern';
    const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
    return (sameYear ? dayFormat : dayFormatYear).format(new Date(ts));
  }

  /** Sitzungen nach Tag gruppiert, neueste zuerst. */
  function groupByDay(sessions, now) {
    const sorted = sessions.slice().sort((a, b) => b.start - a.start);
    const days = [];
    let cur = null;
    for (const s of sorted) {
      const key = dayKey(s.start);
      if (!cur || cur.key !== key) {
        cur = { key, label: dayLabel(s.start, now), sessions: [], count: 0, totalMs: 0 };
        days.push(cur);
      }
      cur.sessions.push(s);
      cur.count += 1;
      cur.totalMs += Math.max(0, s.end - s.start);
    }
    return days;
  }

  // ---------- Mahlzeiten ----------

  function groupMeals(sessions) {
    const sorted = sessions.slice().sort((a, b) => a.start - b.start);
    const meals = [];
    let cur = null;
    for (const s of sorted) {
      if (cur && s.start - cur.end <= MEAL_GAP) {
        cur.sessions.push(s);
        cur.end = Math.max(cur.end, s.end);
      } else {
        cur = { start: s.start, end: s.end, sessions: [s] };
        meals.push(cur);
      }
    }
    return meals;
  }

  function lastMeal(sessions) {
    const meals = groupMeals(sessions);
    return meals.length ? meals[meals.length - 1] : null;
  }

  function lastSession(sessions) {
    let last = null;
    for (const s of sessions) if (!last || s.start > last.start) last = s;
    return last;
  }

  // ---------- Nacht & Erinnerung ----------

  function parseHM(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function isNight(ts, settings) {
    const s = withDefaults(settings);
    const a = parseHM(s.nightStart);
    const b = parseHM(s.nightEnd);
    if (a === null || b === null || a === b) return false;
    const d = new Date(ts);
    const m = d.getHours() * 60 + d.getMinutes();
    return a < b ? m >= a && m < b : m >= a || m < b;
  }

  /**
   * Plant die nächste Erinnerung, gerechnet ab dem Beginn der letzten Mahlzeit.
   * Liegt der Beginn oder der Zeitpunkt mit Tagesabstand in der Nacht, gilt der Nachtabstand.
   * Sind nächtliche Erinnerungen aus, entfällt eine Erinnerung, die in die Nacht fiele.
   * Ergebnis: { at, reason, base } – at ist null, wenn keine Erinnerung geplant wird.
   */
  function planReminder(sessions, settings) {
    const s = withDefaults(settings);
    if (!s.remindersEnabled) return { at: null, reason: 'off', base: null };
    const meal = lastMeal(sessions);
    if (!meal) return { at: null, reason: 'nodata', base: null };
    const base = meal.start;
    const dayAt = base + s.dayIntervalMin * MIN;
    if (s.nightRemindersEnabled) {
      const night = isNight(base, s) || isNight(dayAt, s);
      return { at: night ? base + s.nightIntervalMin * MIN : dayAt, reason: night ? 'night' : 'day', base };
    }
    if (isNight(dayAt, s)) return { at: null, reason: 'night-off', base };
    return { at: dayAt, reason: 'day', base };
  }

  function reminderBody(sessions, now) {
    const meal = lastMeal(sessions);
    const last = lastSession(sessions);
    if (!meal || !last) return '🐻 Vielleicht bald wieder Zeit zum Stillen?';
    return (
      '🐻 Es ist ' + formatSoft(now - meal.start) + ' her, zuletzt ' + sideLabel(last.side) +
      '. Vielleicht bald wieder Zeit zum Stillen?'
    );
  }

  /** Persönlicher Vorschlag aus den Abständen der letzten 3 Tage (nur Vorschlag, ändert nichts). */
  function suggestIntervals(sessions, settings, now) {
    const s = withDefaults(settings);
    const meals = groupMeals(sessions);
    const from = now - 3 * DAY;
    const day = [];
    const night = [];
    for (let i = 1; i < meals.length; i++) {
      const prev = meals[i - 1];
      const cur = meals[i];
      if (cur.start < from) continue;
      const gap = cur.start - prev.start;
      const isN = isNight(prev.start, s) || isNight(cur.start, s);
      if (gap < 45 * MIN || gap > (isN ? 8 : 5) * HOUR) continue;
      (isN ? night : day).push(gap);
    }
    const avgMin = (list) => list.reduce((a, b) => a + b, 0) / list.length / MIN;
    const round = (min, lim) => clamp(Math.round(min / 5) * 5, lim.min, lim.max);
    return {
      day: day.length >= 4 ? { minutes: round(avgMin(day), LIMITS.dayIntervalMin), count: day.length } : null,
      night: night.length >= 2 ? { minutes: round(avgMin(night), LIMITS.nightIntervalMin), count: night.length } : null,
    };
  }

  // ---------- Export / Import ----------

  function pickSettings(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const key of ['dayIntervalMin', 'nightIntervalMin']) {
      const v = Number(src[key]);
      if (Number.isFinite(v)) out[key] = clamp(Math.round(v), LIMITS[key].min, LIMITS[key].max);
    }
    if (typeof src.nightRemindersEnabled === 'boolean') out.nightRemindersEnabled = src.nightRemindersEnabled;
    for (const key of ['nightStart', 'nightEnd']) {
      if (parseHM(src[key]) !== null) out[key] = src[key].padStart(5, '0');
    }
    if (['auto', 'light', 'dark'].includes(src.theme)) out.theme = src.theme;
    return out;
  }

  function buildExport(sessions, settings, now) {
    const s = withDefaults(settings);
    return {
      app: 'milchbaer',
      format: 1,
      exportedAt: isoLocal(now),
      sessions: sessions
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((x) => ({
          id: x.id,
          side: x.side,
          start: isoLocal(x.start),
          end: isoLocal(x.end),
          durationSec: Math.round((x.end - x.start) / SEC),
        })),
      settings: {
        dayIntervalMin: s.dayIntervalMin,
        nightIntervalMin: s.nightIntervalMin,
        nightRemindersEnabled: s.nightRemindersEnabled,
        nightStart: s.nightStart,
        nightEnd: s.nightEnd,
        theme: s.theme,
      },
    };
  }

  function toTs(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  function normSide(v) {
    const x = String(v || '').toLowerCase();
    if (x === 'left' || x === 'links' || x === 'l') return 'left';
    if (x === 'right' || x === 'rechts' || x === 'r') return 'right';
    return null;
  }

  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Die Datei ist keine gültige JSON-Datei.');
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.sessions) ? data.sessions : null;
    if (!list) throw new Error('In der Datei wurden keine Stilldaten gefunden.');
    const sessions = [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const side = normSide(e.side !== undefined ? e.side : e.seite);
      const start = toTs(e.start);
      const end = toTs(e.end);
      if (!side || start === null || end === null || end < start) continue;
      const id = typeof e.id === 'string' && e.id.length <= 64 && e.id ? e.id : 's_' + start.toString(36) + '_' + side;
      sessions.push({ id, side, start, end, durationSec: Math.round((end - start) / SEC) });
    }
    const settings = data && !Array.isArray(data) && data.settings ? pickSettings(data.settings) : null;
    return { sessions, settings, skipped: list.length - sessions.length };
  }

  /** Neue Einträge ermitteln (gleiche ID oder gleicher Beginn + Seite gelten als vorhanden). */
  function mergeSessions(existing, incoming) {
    const ids = new Set(existing.map((s) => s.id));
    const keys = new Set(existing.map((s) => s.start + '|' + s.side));
    const added = [];
    for (const s of incoming) {
      const key = s.start + '|' + s.side;
      if (ids.has(s.id) || keys.has(key)) continue;
      ids.add(s.id);
      keys.add(key);
      added.push(s);
    }
    return added;
  }

  root.MB = root.MB || {};
  root.MB.logic = {
    MIN, HOUR, DAY, MEAL_GAP, LIMITS, DEFAULT_SETTINGS,
    withDefaults, sideLabel, makeId, clamp,
    formatTimer, formatClock, formatDuration, formatInterval, formatAgo, formatSoft, formatMinutes, isoLocal,
    dayKey, dayLabel, groupByDay,
    groupMeals, lastMeal, lastSession,
    parseHM, isNight, planReminder, reminderBody, suggestIntervals,
    pickSettings, buildExport, parseImport, mergeSessions,
  };
})(typeof self !== 'undefined' ? self : globalThis);
