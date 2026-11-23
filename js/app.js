/*
 * Milchbär – Oberfläche und Ablauf.
 * Grundsatz: Die Dauer wird immer aus „jetzt minus Startzeit“ berechnet.
 * Der Startzeitpunkt liegt dauerhaft in IndexedDB; das Intervall aktualisiert nur die Anzeige.
 */
(function () {
  'use strict';

  const L = MB.logic;
  const S = MB.store;
  const C = MB.config;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const state = {
    sessions: [],
    active: null, // { side, start }
    settings: L.withDefaults(null),
    reminder: { at: null, reason: 'off' },
    view: 'home',
    historyDays: 14,
    busy: false,
  };

  const app = $('#app');
  let timerHandle = null;
  let hintHandle = null;

  // ---------- Hilfen ----------

  function toast(text, ms) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  function ask(opts) {
    const o = Object.assign({ confirm: 'OK', cancel: 'Abbrechen', danger: false, text: '' }, opts);
    return new Promise((resolve) => {
      const d = $('#sheet');
      $('#sheet-title').textContent = o.title;
      $('#sheet-text').textContent = o.text;
      $('#sheet-text').hidden = !o.text;
      const actions = $('#sheet-actions');
      actions.textContent = '';
      const ok = document.createElement('button');
      ok.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
      ok.value = 'ok';
      ok.textContent = o.confirm;
      const no = document.createElement('button');
      no.className = 'btn btn-soft';
      no.value = 'cancel';
      no.textContent = o.cancel;
      actions.append(ok, no);
      d.returnValue = '';
      d.onclose = () => resolve(d.returnValue === 'ok');
      d.showModal();
      no.focus();
    });
  }

  $('#sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close('cancel');
  });

  function b64uToBytes(str) {
    const pad = '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // ---------- Darstellung ----------

  const THEME_COLORS = { light: '#F5EFE6', dark: '#1B1612' };

  function applyTheme() {
    const t = state.settings.theme;
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem('mb-theme', t);
    } catch (e) {}
    const metas = $$('meta[name="theme-color"]');
    metas.forEach((m) => {
      const scheme = (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
      m.setAttribute('content', t === 'auto' ? THEME_COLORS[scheme] : THEME_COLORS[t]);
    });
    $$('#theme-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeValue === t)));
  }

  // ---------- Ansichten ----------

  function show(view) {
    if (state.active) view = 'session';
    else if (view === 'session') view = 'home';
    state.view = view;
    app.dataset.view = view;
    $$('.tabbar button').forEach((b) => {
      if (b.dataset.nav === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    render();
  }

  function render() {
    if (state.view === 'session') renderSession();
    if (state.view === 'home') renderHome();
    if (state.view === 'history') renderHistory();
    if (state.view === 'settings') renderSettings();
    manageTimers();
  }

  function manageTimers() {
    const visible = document.visibilityState === 'visible';
    if (state.view === 'session' && visible) {
      if (!timerHandle) timerHandle = setInterval(renderTimer, 250);
    } else if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    if (state.view === 'home' && visible) {
      if (!hintHandle) hintHandle = setInterval(renderHints, 20000);
    } else if (hintHandle) {
      clearInterval(hintHandle);
      hintHandle = null;
    }
  }

  // ---------- Start ----------

  function renderHome() {
    renderHints();
    const last = L.lastSession(state.sessions);
    $$('.side-btn').forEach((b) => b.classList.toggle('is-last', !!last && b.dataset.side === last.side));
  }

  function renderHints() {
    const now = Date.now();
    const last = L.lastSession(state.sessions);
    const meal = L.lastMeal(state.sessions);
    $('#hint-last').textContent = last
      ? 'Zuletzt: ' + L.sideLabel(last.side) + ', ' + L.formatAgo(now - meal.start)
      : 'Tippe auf eine Seite, um zu beginnen.';

    const next = $('#hint-next');
    const r = state.reminder;
    let text = '';
    if (state.settings.remindersEnabled) {
      if (r.at && r.at > now) text = 'Nächste Erinnerung gegen ' + L.formatClock(r.at);
      else if (r.reason === 'night-off' && r.base && now - r.base < 12 * L.HOUR) text = 'Nachts keine Erinnerung';
    }
    next.textContent = text;
    next.hidden = !text;
  }

  // ---------- Sitzung ----------

  function renderSession() {
    const a = state.active;
    if (!a) return;
    $('#session-side').textContent = L.sideLabel(a.side);
    $('#session-since').textContent = 'seit ' + L.formatClock(a.start);
    renderTimer();
  }

  function renderTimer() {
    if (!state.active) return;
    $('#timer').textContent = L.formatTimer(Date.now() - state.active.start);
  }

  async function startSession(side) {
    if (state.busy || state.active) return;
    const active = { side, start: Date.now() };
    state.busy = true;
    try {
      await S.set('active', active);
      state.active = active;
      show('session');
      replan();
    } catch (e) {
      toast('Speichern hat nicht geklappt. Bitte noch einmal tippen.');
    } finally {
      state.busy = false;
    }
  }

  async function stopSession() {
    const a = state.active;
    if (state.busy || !a) return;
    const end = Date.now();
    const duration = end - a.start;
    state.busy = true;
    try {
      if (duration < 10 * 1000) {
        const keep = await ask({
          title: 'Sehr kurze Sitzung',
          text: 'Die Sitzung dauerte nur ' + L.formatDuration(duration) + '. Möchtest du sie trotzdem speichern?',
          confirm: 'Speichern',
          cancel: 'Verwerfen',
        });
        if (!keep) {
          await S.del('active');
          state.active = null;
          show('home');
          replan();
          return;
        }
      }
      const session = { id: L.makeId(a.start), side: a.side, start: a.start, end, durationSec: Math.round(duration / 1000) };
      await S.finishSession(session);
      state.sessions.push(session);
      state.active = null;
      show('home');
      toast('Gespeichert: ' + L.sideLabel(session.side) + ', ' + L.formatDuration(duration));
      replan();
    } catch (e) {
      toast('Speichern hat nicht geklappt. Bitte noch einmal tippen.');
    } finally {
      state.busy = false;
    }
  }

  // ---------- Verlauf ----------

  function renderHistory() {
    const list = $('#history-list');
    list.textContent = '';
    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = MB.bearSVG('head') + '<p>Noch keine Einträge.<br>Sie erscheinen hier, sobald du eine Sitzung stoppst.</p>';
      list.append(empty);
      return;
    }
    const now = Date.now();
    const days = L.groupByDay(state.sessions, now);
    const meals = L.groupMeals(state.sessions);
    const contIds = new Set();
    meals.forEach((m) => m.sessions.slice(1).forEach((s) => contIds.add(s.id)));

    const shown = days.slice(0, state.historyDays);
    const frag = document.createDocumentFragment();
    for (const day of shown) {
      const sec = document.createElement('section');
      sec.className = 'day';
      const head = document.createElement('header');
      head.className = 'day-head';
      const h = document.createElement('h2');
      h.textContent = day.label;
      const sum = document.createElement('span');
      sum.className = 'day-sum';
      sum.textContent = day.count + (day.count === 1 ? ' Sitzung' : ' Sitzungen') + ' · ' + L.formatDuration(day.totalMs);
      head.append(h, sum);
      const ul = document.createElement('ul');
      ul.className = 'entries';
      for (const s of day.sessions) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'entry' + (contIds.has(s.id) ? ' is-meal-cont' : '');
        btn.dataset.id = s.id;
        btn.setAttribute('aria-label', L.formatClock(s.start) + ' bis ' + L.formatClock(s.end) + ', ' + L.sideLabel(s.side) + ', ' + L.formatDuration(s.end - s.start) + '. Tippen zum Löschen.');
        btn.innerHTML =
          '<span class="entry-time"></span><span class="entry-side"></span><span class="entry-dur"></span>';
        btn.children[0].textContent = L.formatClock(s.start) + ' – ' + L.formatClock(s.end);
        btn.children[1].textContent = L.sideLabel(s.side);
        btn.children[2].textContent = L.formatDuration(s.end - s.start);
        li.append(btn);
        ul.append(li);
      }
      sec.append(head, ul);
      frag.append(sec);
    }
    if (days.length > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-soft more';
      more.textContent = 'Ältere Einträge anzeigen';
      more.addEventListener('click', () => {
        state.historyDays += 30;
        renderHistory();
      });
      frag.append(more);
    }
    list.append(frag);
  }

  async function confirmDelete(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const when = L.dayLabel(s.start, Date.now());
    const ok = await ask({
      title: 'Eintrag löschen?',
      text: L.sideLabel(s.side) + ' · ' + when + ', ' + L.formatClock(s.start) + ' – ' + L.formatClock(s.end) + '\n' + L.formatDuration(s.end - s.start),
      confirm: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    await S.deleteSession(id);
    state.sessions = state.sessions.filter((x) => x.id !== id);
    renderHistory();
    toast('Eintrag gelöscht');
    replan();
  }

  // ---------- Einstellungen ----------

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function renderSettings() {
    const s = state.settings;
    const toggle = $('#rem-toggle');
    toggle.checked = s.remindersEnabled;
    $('#rem-details').hidden = !s.remindersEnabled;

    let status = s.remindersEnabled ? 'An' : 'Aus';
    let hint = '';
    if (!pushSupported()) {
      status = 'Nicht verfügbar';
      hint =
        isIOS() && !isStandalone()
          ? 'Erinnerungen funktionieren auf dem iPhone nur, wenn Milchbär über „Teilen → Zum Home-Bildschirm“ installiert ist (ab iOS 16.4). Öffne die App dann über das Symbol auf dem Home-Bildschirm.'
          : 'Dieser Browser unterstützt keine Erinnerungen.';
    } else if (Notification.permission === 'denied') {
      status = 'Blockiert';
      hint = isIOS()
        ? 'Mitteilungen sind für Milchbär ausgeschaltet. Du kannst sie in den iPhone-Einstellungen unter „Mitteilungen → Milchbär“ wieder erlauben.'
        : 'Mitteilungen sind für diese Seite blockiert. Du kannst sie in den Browser-Einstellungen wieder erlauben.';
    } else if (s.remindersEnabled && state.reminder.at && state.reminder.at > Date.now()) {
      status = 'An · nächste gegen ' + L.formatClock(state.reminder.at);
    }
    $('#rem-status').textContent = status;
    $('#rem-hint').textContent = hint;
    $('#rem-hint').hidden = !hint;
    toggle.disabled = !pushSupported();

    $$('.stepper').forEach((st) => {
      const key = st.dataset.key;
      const lim = L.LIMITS[key];
      st.querySelector('output').textContent = L.formatInterval(s[key]);
      st.querySelector('[data-step="-1"]').disabled = s[key] <= lim.min;
      st.querySelector('[data-step="1"]').disabled = s[key] >= lim.max;
    });
    $('#night-toggle').checked = s.nightRemindersEnabled;
    $('#night-interval-row').hidden = !s.nightRemindersEnabled;
    $('#night-start').value = s.nightStart;
    $('#night-end').value = s.nightEnd;

    renderSuggestion();
    applyTheme();
    $('#footer').textContent = 'Milchbär · Version ' + C.VERSION;
  }

  function renderSuggestion() {
    const box = $('#suggest');
    const sug = L.suggestIntervals(state.sessions, state.settings, Date.now());
    const s = state.settings;
    const parts = [];
    if (sug.day) parts.push('tagsüber etwa alle ' + L.formatInterval(sug.day.minutes));
    if (sug.night && s.nightRemindersEnabled) parts.push('nachts etwa alle ' + L.formatInterval(sug.night.minutes));
    const differs =
      (sug.day && sug.day.minutes !== s.dayIntervalMin) ||
      (sug.night && s.nightRemindersEnabled && sug.night.minutes !== s.nightIntervalMin);
    box.hidden = !parts.length || !differs;
    if (box.hidden) return;
    const text = 'Deine letzten 3 Tage: ' + parts.join(', ');
    $('#suggest-text').textContent = text.endsWith('.') ? text : text + '.';
    box.dataset.day = sug.day ? sug.day.minutes : '';
    box.dataset.night = sug.night && s.nightRemindersEnabled ? sug.night.minutes : '';
  }

  async function saveSettings() {
    await S.set('settings', state.settings);
  }

  async function updateSetting(patch) {
    Object.assign(state.settings, patch);
    await saveSettings();
    renderSettings();
    replan();
  }

  async function onReminderToggle(e) {
    const input = e.currentTarget;
    if (!input.checked) {
      await updateSetting({ remindersEnabled: false });
      unsubscribePush();
      return;
    }
    if (!pushSupported()) {
      input.checked = false;
      renderSettings();
      return;
    }
    // Die Erlaubnis wird direkt in der Tipp-Geste abgefragt (Pflicht unter iOS).
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      input.checked = false;
      renderSettings();
      toast('Ohne Erlaubnis für Mitteilungen gibt es keine Erinnerungen.', 3600);
      return;
    }
    try {
      await getSubscription(true);
    } catch (err) {
      console.warn(err);
      input.checked = false;
      renderSettings();
      toast('Die Anmeldung für Erinnerungen hat nicht geklappt. Bitte später noch einmal versuchen.', 3600);
      return;
    }
    await updateSetting({ remindersEnabled: true });
    toast('Erinnerungen sind an');
  }

  // ---------- Erinnerungen (Push) ----------

  let swReady = null;
  let syncChain = Promise.resolve();

  async function getSubscription(create) {
    const reg = await swReady;
    if (!reg) throw new Error('Kein Service Worker');
    let sub = await reg.pushManager.getSubscription();
    const usedKey = await S.get('pushKey');
    if (sub && usedKey && usedKey !== C.VAPID_PUBLIC_KEY) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub && create) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(C.VAPID_PUBLIC_KEY) });
      await S.set('pushKey', C.VAPID_PUBLIC_KEY);
    }
    return sub;
  }

  async function api(method, path, body) {
    const res = await fetch(C.PUSH_API_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Server antwortet mit ' + res.status);
    return res.json().catch(() => ({}));
  }

  /** Plant die nächste Erinnerung lokal neu und gleicht sie mit dem Server ab. */
  async function replan() {
    let at = null;
    let reason = 'off';
    let base = null;
    if (state.active) {
      reason = 'active';
    } else if (state.settings.remindersEnabled) {
      const p = L.planReminder(state.sessions, state.settings);
      reason = p.reason;
      base = p.base;
      at = p.at && p.at > Date.now() + 30 * 1000 ? p.at : null;
      if (p.at && !at) reason = 'past';
    }
    state.reminder = { at, reason, base };
    await S.set('reminder', state.reminder).catch(() => {});
    if (state.view === 'home') renderHints();
    if (state.view === 'settings') renderSettings();
    if (state.settings.remindersEnabled) {
      await S.set('syncPending', true).catch(() => {});
      queueSync();
    }
  }

  function queueSync() {
    syncChain = syncChain.then(syncNow, syncNow);
    return syncChain;
  }

  async function syncNow() {
    if (!state.settings.remindersEnabled || !pushSupported()) return;
    if (!(await S.get('syncPending'))) return;
    try {
      if (Notification.permission !== 'granted') return;
      const sub = await getSubscription(true);
      if (!sub) return;
      const json = sub.toJSON();
      const prev = await S.get('pushEndpoint');
      if (prev && prev !== json.endpoint) await api('DELETE', '/reminder', { endpoint: prev }).catch(() => {});
      await api('PUT', '/reminder', { subscription: json, at: state.reminder.at });
      await S.set('pushEndpoint', json.endpoint);
      await S.del('syncPending');
    } catch (e) {
      console.warn('Abgleich mit dem Erinnerungs-Server fehlgeschlagen, neuer Versuch später.', e);
    }
  }

  async function unsubscribePush() {
    try {
      await S.del('syncPending');
      const sub = await getSubscription(false).catch(() => null);
      const endpoint = (sub && sub.endpoint) || (await S.get('pushEndpoint'));
      if (endpoint) await api('DELETE', '/reminder', { endpoint }).catch((e) => console.warn(e));
      // Auch wenn der Server gerade nicht erreichbar ist: Nach dem Abmelden lehnt der
      // Push-Dienst weitere Nachrichten ab, und der Server löscht den Eintrag selbst.
      if (sub) await sub.unsubscribe().catch(() => {});
      await S.del('pushEndpoint');
    } catch (e) {
      console.warn(e);
    }
  }

  async function sendTest() {
    const btn = $('#rem-test');
    btn.disabled = true;
    try {
      const sub = await getSubscription(Notification.permission === 'granted');
      if (!sub) throw new Error('Kein Push-Abo');
      await api('POST', '/test', { subscription: sub.toJSON() });
      toast('Die Test-Erinnerung kommt in etwa einer Minute. Du kannst das iPhone jetzt sperren.', 4200);
    } catch (e) {
      console.warn(e);
      toast('Test hat nicht geklappt. Bist du online?', 3200);
    } finally {
      setTimeout(() => (btn.disabled = false), 4000);
    }
  }

  // ---------- Export / Import ----------

  async function exportData() {
    const data = L.buildExport(state.sessions, state.settings, Date.now());
    const text = JSON.stringify(data, null, 2);
    const name = 'milchbaer-' + L.dayKey(Date.now()) + '.json';
    const candidates = [new File([text], name, { type: 'application/json' }), new File([text], name, { type: 'text/plain' })];
    if (navigator.canShare && navigator.share) {
      const file = candidates.find((f) => navigator.canShare({ files: [f] }));
      if (file) {
        try {
          await navigator.share({ files: [file], title: 'Milchbär-Sicherung' });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
    }
    const url = URL.createObjectURL(candidates[0]);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function importFile(file) {
    let parsed;
    try {
      parsed = L.parseImport(await file.text());
    } catch (e) {
      toast(e.message, 3600);
      return;
    }
    const added = L.mergeSessions(state.sessions, parsed.sessions);
    const hasSettings = parsed.settings && Object.keys(parsed.settings).length > 0;
    if (!added.length && !hasSettings) {
      toast('Keine neuen Einträge gefunden.');
      return;
    }
    let text =
      added.length === 0
        ? 'Alle Sitzungen aus der Datei sind schon vorhanden.'
        : (added.length === 1 ? '1 neue Sitzung wird hinzugefügt.' : added.length + ' neue Sitzungen werden hinzugefügt.') +
          ' Vorhandene Einträge bleiben erhalten.';
    if (hasSettings) text += '\nDie Einstellungen (Abstände, Nachtzeit, Darstellung) werden aus der Datei übernommen.';
    const ok = await ask({ title: 'Daten importieren?', text, confirm: 'Importieren' });
    if (!ok) return;
    await S.putSessions(added);
    state.sessions = await S.allSessions();
    if (hasSettings) {
      Object.assign(state.settings, parsed.settings);
      await saveSettings();
    }
    renderSettings();
    toast('Import abgeschlossen: ' + added.length + (added.length === 1 ? ' Sitzung' : ' Sitzungen'));
    replan();
  }

  // ---------- Ereignisse ----------

  function bindEvents() {
    $$('.side-btn').forEach((b) => b.addEventListener('click', () => startSession(b.dataset.side)));
    $('#stop-btn').addEventListener('click', stopSession);
    $$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));

    $('#history-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.entry');
      if (btn) confirmDelete(btn.dataset.id);
    });

    $('#rem-toggle').addEventListener('change', onReminderToggle);
    $('#night-toggle').addEventListener('change', (e) => updateSetting({ nightRemindersEnabled: e.currentTarget.checked }));
    $$('.stepper').forEach((st) =>
      st.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-step]');
        if (!btn) return;
        const key = st.dataset.key;
        const lim = L.LIMITS[key];
        const cur = state.settings[key];
        const dir = Number(btn.dataset.step);
        // Auf das 15-Minuten-Raster einrasten, falls ein Vorschlag krumme Werte gesetzt hat.
        const snapped = dir > 0 ? Math.floor(cur / lim.step) * lim.step + lim.step : Math.ceil(cur / lim.step) * lim.step - lim.step;
        updateSetting({ [key]: L.clamp(snapped, lim.min, lim.max) });
      })
    );
    for (const id of ['night-start', 'night-end']) {
      $('#' + id).addEventListener('change', (e) => {
        const v = e.currentTarget.value;
        if (L.parseHM(v) === null) return renderSettings();
        updateSetting(id === 'night-start' ? { nightStart: v } : { nightEnd: v });
      });
    }
    $('#suggest-apply').addEventListener('click', () => {
      const box = $('#suggest');
      const patch = {};
      if (box.dataset.day) patch.dayIntervalMin = Number(box.dataset.day);
      if (box.dataset.night) patch.nightIntervalMin = Number(box.dataset.night);
      updateSetting(patch);
      toast('Vorschlag übernommen');
    });
    $('#rem-test').addEventListener('click', sendTest);
    $$('#theme-seg button').forEach((b) =>
      b.addEventListener('click', () => updateSetting({ theme: b.dataset.themeValue }))
    );
    $('#export-btn').addEventListener('click', exportData);
    $('#import-btn').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.currentTarget.files && e.currentTarget.files[0];
      e.currentTarget.value = '';
      if (f) importFile(f);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
      else manageTimers();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) refresh();
    });
    window.addEventListener('online', () => queueSync());
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => applyTheme());
  }

  /** Zustand frisch aus IndexedDB laden, z. B. nach dem Zurückkehren in die App. */
  async function refresh() {
    const [sessions, active, reminder] = await Promise.all([S.allSessions(), S.get('active'), S.get('reminder')]);
    state.sessions = sessions;
    state.active = active || null;
    if (reminder) state.reminder = reminder;
    show(state.active ? 'session' : state.view === 'session' ? 'home' : state.view);
    queueSync();
  }

  async function init() {
    $('#bear-home').innerHTML = MB.bearSVG('full');
    $('#bear-session').innerHTML = MB.bearSVG('full');

    if ('serviceWorker' in navigator) {
      swReady = navigator.serviceWorker
        .register('sw.js', { scope: './', updateViaCache: 'none' })
        .then(() => navigator.serviceWorker.ready)
        .catch((e) => {
          console.warn('Service Worker nicht registriert', e);
          return null;
        });
    } else {
      swReady = Promise.resolve(null);
    }

    try {
      const [sessions, active, settings, reminder] = await Promise.all([
        S.allSessions(),
        S.get('active'),
        S.get('settings'),
        S.get('reminder'),
      ]);
      state.sessions = sessions;
      state.active = active || null;
      state.settings = L.withDefaults(settings);
      if (reminder) state.reminder = reminder;
    } catch (e) {
      console.error(e);
      toast('Der Gerätespeicher ist nicht erreichbar. Daten können nicht gespeichert werden.', 6000);
    }

    applyTheme();
    bindEvents();
    show(state.active ? 'session' : 'home');

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    // Abgleich nach dem Öffnen: Server-Stand reparieren, falls ein früherer Versuch offline war.
    if (state.settings.remindersEnabled) {
      if (!(await S.get('syncPending'))) await S.set('syncPending', true).catch(() => {});
      queueSync();
    }
  }

  // Für lokale Tests im Browser
  window.MB.app = { state, replan, refresh };

  init();
})();
