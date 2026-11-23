// Tests für js/logic.js (Erinnerungsplanung, Mahlzeiten, Formatierung, Import/Export).
// Aufruf: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.TZ = 'Europe/Berlin';
const require = createRequire(import.meta.url);
require('../js/logic.js');
const L = globalThis.MB.logic;

const at = (h, m = 0, day = 23) => new Date(2026, 10, day, h, m, 0).getTime();
const sess = (side, h1, m1, h2, m2, day = 23) => ({ id: `${side}${h1}${m1}${day}`, side, start: at(h1, m1, day), end: at(h2, m2, day) });
const on = { remindersEnabled: true };

test('Timer: mm:ss, auch über 60 Minuten', () => {
  assert.equal(L.formatTimer(0), '00:00');
  assert.equal(L.formatTimer(65_400), '01:05');
  assert.equal(L.formatTimer(72 * 60_000 + 3000), '72:03');
});

test('Texte: Dauer, „vor …“, weiche Angabe', () => {
  assert.equal(L.formatDuration(40_000), '40 Sek.');
  assert.equal(L.formatDuration(12 * 60_000 + 20_000), '12 Min.');
  assert.equal(L.formatDuration(65 * 60_000), '1 Std. 5 Min.');
  assert.equal(L.formatAgo(130 * 60_000), 'vor 2 Std. 10 Min.');
  assert.equal(L.formatAgo(20_000), 'gerade eben');
  assert.equal(L.formatSoft(150 * 60_000), '2½ Std.');
  assert.equal(L.formatSoft(182 * 60_000), '3 Std.');
  assert.equal(L.formatSoft(160 * 60_000), '2 Std. 40 Min.');
  assert.equal(L.formatInterval(150), '2½ Std.');
  assert.equal(L.formatInterval(165), '2 Std. 45 Min.');
});

test('Mahlzeit: Seitenwechsel innerhalb von 15 Min. zählt zusammen', () => {
  const list = [sess('left', 9, 0, 9, 12), sess('left', 12, 0, 12, 10), sess('right', 12, 20, 12, 30)];
  const meal = L.lastMeal(list);
  assert.equal(meal.start, at(12, 0));
  assert.equal(meal.sessions.length, 2);
  assert.equal(L.groupMeals([sess('left', 12, 0, 12, 10), sess('right', 12, 26, 12, 30)]).length, 2);
});

test('Erinnerung tagsüber: ab Beginn der Mahlzeit + Tagesabstand', () => {
  const list = [sess('left', 12, 0, 12, 10), sess('right', 12, 20, 12, 30)];
  const p = L.planReminder(list, on);
  assert.equal(p.reason, 'day');
  assert.equal(p.at, at(14, 30));
});

test('Erinnerung abends: fällt sie in die Nacht, gilt der Nachtabstand', () => {
  const p = L.planReminder([sess('left', 21, 0, 21, 15)], on);
  assert.equal(p.reason, 'night');
  assert.equal(p.at, at(0, 30, 24));
});

test('Erinnerung nachts aus: keine Erinnerung in der Nacht, morgens wieder', () => {
  const off = { remindersEnabled: true, nightRemindersEnabled: false };
  assert.equal(L.planReminder([sess('left', 21, 0, 21, 15)], off).at, null);
  assert.equal(L.planReminder([sess('left', 21, 0, 21, 15)], off).reason, 'night-off');
  const early = L.planReminder([sess('left', 5, 0, 5, 15)], off);
  assert.equal(early.at, at(7, 30));
});

test('Erinnerungen aus oder keine Daten: nichts geplant', () => {
  assert.equal(L.planReminder([sess('left', 12, 0, 12, 10)], {}).at, null);
  assert.equal(L.planReminder([], on).at, null);
});

test('Nachtzeitraum über Mitternacht und am Tag', () => {
  const s = { nightStart: '22:00', nightEnd: '06:00' };
  assert.ok(L.isNight(at(23, 0), s));
  assert.ok(L.isNight(at(3, 0), s));
  assert.ok(!L.isNight(at(6, 0), s));
  assert.ok(!L.isNight(at(12, 0), s));
  assert.ok(L.isNight(at(14, 0), { nightStart: '13:00', nightEnd: '15:00' }));
});

test('Text der Erinnerung', () => {
  const list = [sess('left', 12, 0, 12, 10), sess('right', 12, 20, 12, 30)];
  assert.equal(
    L.reminderBody(list, at(14, 30)),
    '🐻 Es ist 2½ Std. her, zuletzt Rechts. Vielleicht bald wieder Zeit zum Stillen?'
  );
});

test('Vorschlag aus den letzten 3 Tagen', () => {
  const list = [];
  for (const day of [21, 22, 23]) {
    for (const h of [8, 11, 14, 17]) list.push(sess(h % 2 ? 'left' : 'right', h, 0, h, 15, day));
    list.push(sess('left', 23, 0, 23, 15, day));
  }
  const sug = L.suggestIntervals(list, {}, at(20, 0, 23));
  assert.equal(sug.day.minutes, 180);
  assert.ok(sug.day.count >= 4);
  assert.ok(sug.night === null || sug.night.minutes >= 120);
});

test('Verlauf nach Tagen mit Anzahl und Gesamtdauer', () => {
  const list = [sess('left', 9, 0, 9, 10, 23), sess('right', 12, 0, 12, 20, 23), sess('left', 9, 0, 9, 5, 22), sess('left', 9, 0, 9, 5, 18)];
  const days = L.groupByDay(list, at(20, 0, 23));
  assert.deepEqual(days.map((d) => d.label.split(',')[0]), ['Heute', 'Gestern', 'Mi.']);
  assert.equal(days[0].count, 2);
  assert.equal(days[0].totalMs, 30 * 60_000);
  assert.equal(days[0].sessions[0].side, 'right');
});

test('Export → Import ergibt dieselben Daten, Duplikate werden erkannt', () => {
  const list = [sess('left', 9, 0, 9, 10), sess('right', 12, 0, 12, 20)];
  const exported = L.buildExport(list, { dayIntervalMin: 165, theme: 'dark' }, at(20, 0));
  assert.equal(exported.sessions[0].start, '2026-11-23T09:00:00+01:00');
  const parsed = L.parseImport(JSON.stringify(exported));
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.sessions[1].start, list[1].start);
  assert.equal(parsed.settings.dayIntervalMin, 165);
  assert.equal(parsed.settings.theme, 'dark');
  assert.equal(L.mergeSessions(list, parsed.sessions).length, 0);
  assert.equal(L.mergeSessions([], parsed.sessions).length, 2);
  assert.throws(() => L.parseImport('kein json'), /gültige JSON/);
  assert.throws(() => L.parseImport('{"foo":1}'), /keine Stilldaten/);
});
