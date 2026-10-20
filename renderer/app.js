/* app.js — логика интерфейса (renderer). v2.5.0:
   - файлы: иконки типов, кнопка «назад», свойства файлов, перетаскивание с ПК, загрузка в текущую папку
   - приложения: счётчики, человеческие имена (± пакеты), процессы с описаниями
   - свойства приложения: разрешения колонками, тултипы в стиле приложения, «Очистить кэш», «Удалить приложение»
   - терминал: команды по производителям, свои команды (Сохранения/), автодополнение
   - зеркало: вотчдог «данные идут, но кадров нет», быстрый JPEG-режим; журнал = только ошибки (F19) */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let state = null;
let devices = [];          // [{serial, state, model, android, props}]
let activeSerial = null;   // ЕДИНСТВЕННОЕ активное устройство (R8)
let savedItems = [];       // «Мои устройства» — для офлайн-опций селектора (R7)
let scanFound = [];
let recTimer = null, recStart = 0;
let logcatOn = false, logcatPaused = false, logcatBuf = [];

/* ---------- утилиты ---------- */
const ERR_MSG_RE = /не удалось|ошибка|невозможно|недоступен|нет подключ|отказано|занято|слишком/i;
let snackEl = null;
function snack(msg, ms = 3500) {
  // F19: каждая ошибка, показанная в интерфейсе, обязана попасть в журнал (app.log = только ошибки)
  if (ERR_MSG_RE.test(String(msg))) { try { window.api.uiLog(String(msg).slice(0, 400)); } catch (e) {} }
  snackEl = snackEl || $('#snackbar');
  snackEl.textContent = msg; snackEl.classList.remove('hidden');
  clearTimeout(snackEl._t);
  snackEl._t = setTimeout(() => snackEl.classList.add('hidden'), ms);
}
function openDlg(id) { $('#' + id).classList.remove('hidden'); }
function closeDlg(id) { $('#' + id).classList.add('hidden'); }

/* модальный ввод (замена системного диалога ввода, которого нет в Electron) */
let inputResolve = null;
function askText(title, label, value) {
  return new Promise(resolve => {
    inputResolve = resolve;
    $('#input-title').textContent = title;
    $('#input-label').textContent = label || '';
    const f = $('#input-field'); f.value = value || '';
    openDlg('dlg-input');
    setTimeout(() => { try { f.focus(); f.select(); } catch (e) {} }, 60);
  });
}
function finishInput(okVal) {
  if (!inputResolve) { closeDlg('dlg-input'); return; }
  const r = inputResolve; inputResolve = null;
  closeDlg('dlg-input');
  r(okVal ? $('#input-field').value.trim() : null);
}
$('#input-ok').onclick = () => finishInput(true);
$('#input-field').addEventListener('keydown', e => { if (e.key === 'Enter') finishInput(true); });

// подтверждение вместо нативного confirm() — не выбивается из кастомного окна (A1)
// v2.8.0: opts.checkbox — «Больше не спрашивать»: возвращает {ok, dontAsk} вместо boolean;
// подтверждающие галочки запоминаются в localStorage — владелец больше не кликает по сто раз
let confirmCb = null, confirmCancelCb = null;
function uiConfirm(title, body, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    confirmCb = () => resolve({ ok: true, dontAsk: !!(opts.checkbox && $('#confirm-dontask') && $('#confirm-dontask').checked) });
    confirmCancelCb = () => resolve({ ok: false, dontAsk: false });
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body || '';
    const cb = $('#confirm-dontask');
    if (cb) {
      if (opts.checkbox) { cb.parentElement.classList.remove('hidden'); cb.checked = false; }
      else cb.parentElement.classList.add('hidden');
    }
    openDlg('dlg-confirm');
  });
}
async function confirmOnce(key, title, body) {
  // v2.8.0: подтверждение «один раз навсегда» для конкретного действия (ключ в localStorage)
  try { if (localStorage.getItem(key) === '1') return { ok: true, dontAsk: true }; } catch (e) {}
  const r = await uiConfirm(title, body, { checkbox: 'Больше не спрашивать' });
  if (r.ok && r.dontAsk) { try { localStorage.setItem(key, '1'); } catch (e) {} }
  return r;
}

// флаг активной QR-сессии: нужен обработчику data-close ниже и блоку QR-подключения
let qrActive = false;

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n + ' Б'; }
function copyText(t) {
  try { navigator.clipboard.writeText(t); snack('Скопировано: ' + t); } catch (e) {}
}

/* ---------- звуки действий ---------- */
const snd = {
  ctx: null, on: true,
  play(kind) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = this.ctx.currentTime;
      const mk = (f, st, d, g, type) => {
        const o = this.ctx.createOscillator(), gn = this.ctx.createGain();
        o.type = type || 'sine'; o.frequency.value = f;
        gn.gain.setValueAtTime(0, t + st);
        gn.gain.linearRampToValueAtTime(g || 0.07, t + st + 0.012);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + st + d);
        o.connect(gn); gn.connect(this.ctx.destination);
        o.start(t + st); o.stop(t + st + d + 0.03);
      };
      if (kind === 'ok') { mk(660, 0, 0.12); mk(880, 0.09, 0.16); }
      else if (kind === 'connect') { mk(523, 0, 0.1); mk(659, 0.09, 0.1); mk(784, 0.18, 0.2); }
      else if (kind === 'err') { mk(196, 0, 0.22, 0.09, 'triangle'); mk(147, 0.12, 0.25, 0.08, 'triangle'); }
      else if (kind === 'found') { mk(740, 0, 0.09); mk(988, 0.08, 0.13); }
      else if (kind === 'click') { mk(520, 0, 0.05, 0.035); }
      else if (kind === 'drop') { mk(392, 0, 0.08); mk(523, 0.07, 0.1); }
    } catch (e) {}
  }
};
document.addEventListener('click', (e) => { if (e.target.closest('.btn,.chip,.rail-item,.star')) snd.play('click'); }, true);
const _snack = snack;
snack = function (msg, ms) { _snack(msg, ms); snd.play(ERR_MSG_RE.test(String(msg)) ? 'err' : 'ok'); };

/* ---------- тултипы в стиле приложения (F13): нативные Windows-подсказки заменены ---------- */
(function tooltip() {
  const tip = document.createElement('div');
  tip.id = 'app-tip'; tip.className = 'hidden';
  document.body.appendChild(tip);
  let raf = 0;
  function show(txt, x, y) {
    tip.textContent = txt;
    tip.classList.remove('hidden');
    const r = tip.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    let px = Math.min(Math.max(8, x + 14), w - r.width - 10);
    let py = y + 18;
    if (py + r.height > h - 8) py = Math.max(8, y - r.height - 12);
    tip.style.left = px + 'px'; tip.style.top = py + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const txt = t.getAttribute('data-tip') || '';
    if (!txt) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => show(txt, e.clientX, e.clientY));
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.classList.contains('hidden')) return;
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.classList.add('hidden'); return; }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => show(t.getAttribute('data-tip') || '', e.clientX, e.clientY));
  });
  document.addEventListener('mousedown', () => tip.classList.add('hidden'), true);
  document.addEventListener('mouseleave', () => tip.classList.add('hidden'));
})();

/* ---------- титульная панель / навигация ---------- */
$('#btn-min').onclick = () => window.api.winMin();
$('#btn-max').onclick = () => window.api.winMax();
$('#btn-close').onclick = () => window.api.winClose();
window.api.onMaximized(v => { $('#btn-max').innerHTML = v ? '&#10697;' : '&#9633;'; });

$$('.rail-item').forEach(b => b.onclick = () => goPage(b.dataset.page));

$$('[data-close]').forEach(b => b.onclick = () => {
  if (b.dataset.close === 'dlg-input') finishInput(false);
  if (b.dataset.close === 'dlg-qrpc' && qrActive) { qrActive = false; window.api.qrCancel(); }
  if (b.dataset.close === 'dlg-confirm' && confirmCancelCb) { const c = confirmCancelCb; confirmCancelCb = null; confirmCb = null; c(); }
  closeDlg(b.dataset.close);
});
$('#confirm-yes').onclick = () => { closeDlg('dlg-confirm'); if (confirmCb) confirmCb(); confirmCb = null; confirmCancelCb = null; };

$$('.tabs .tab').forEach(t => t.onclick = () => {
  $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
});

/* ---------- состояние ---------- */
let savesDir = '';
async function loadState() {
  state = await window.api.getState();
  document.body.dataset.theme = state.config.theme || 'dark';
  $('#tb-version').textContent = 'v' + state.version + ' RU';
  $('#about-ver').textContent = state.version;
  // F16: все сохранения — в «Сохранения/» рядом с программой
  savesDir = state.savesDir || state.capturesDir || '';
  $('#data-dir-label').textContent = 'Все сохранения хранятся строго в папке с программой: ' + savesDir;
  $('#set-adb-path').value = state.config.adbPath || '';
  $('#set-scrcpy-path').value = state.config.scrcpyPath || '';
  $('#set-autostart').checked = !!state.config.autostart;
  $('#set-tray').checked = state.config.closeToTray !== false;
  $('#set-autoreconnect').checked = !!state.config.autoreconnect;
  $('#set-scanstart').checked = !!state.config.scanOnStart;
  $('#set-sounds').checked = state.config.sounds !== false;
  $('#set-autolast').checked = !!state.config.autolast;
  snd.on = state.config.sounds !== false;
  $('#set-theme').value = state.config.theme || 'dark';
  await refreshAdbStatus();
  renderHistory(); renderFavorites(); renderSaved();
}

async function refreshAdbStatus() {
  const v = await window.api.adbVersion();
  if (v.ok) {
    $('#adb-status').textContent = 'adb ' + v.version;
    $('#adb-ver-label').textContent = '— версия ' + v.version;
    $('#adb-banner').classList.add('hidden');
  } else {
    $('#adb-status').textContent = 'adb не найден';
    $('#adb-banner').classList.remove('hidden');
  }
}

/* ---------- ЕДИНОЕ активное устройство (R7/R8) ---------- */
function onlineDevices() { return devices.filter(d => d.state === 'device'); }
function isOnline(serial) { return onlineDevices().some(d => d.serial === serial); }
function isUsb(serial) { return !String(serial || '').includes(':'); }
function nameOf(serial) {
  const d = devices.find(x => x.serial === serial);
  return (d && (d.model || d.props && d.props.product)) || serial || '';
}
function stText(serial) {
  if (!serial) return '';
  if (isOnline(serial)) return serial === activeSerial ? '✓ активно' : '● в сети' + (isUsb(serial) ? ' [USB]' : '');
  return '○ не подключено';
}
function chipClass(serial) {
  if (!isOnline(serial)) return 'st-chip st-off';
  return serial === activeSerial ? 'st-chip st-active' : 'st-chip st-online';
}

function renderTbDevice() {
  const sel = $('#tb-device');
  const online = onlineDevices();
  // офлайн-адреса из «Моих устройств» и истории — для быстрого подключения из любого места
  const hist = (state && state.history) || [];
  const offline = [];
  for (const s of savedItems) {
    const ser = s.host + ':' + s.port;
    if (!online.some(d => d.serial === ser) && !offline.some(o => o.serial === ser)) offline.push({ serial: ser, label: (s.name || s.host) + ':' + s.port });
  }
  for (const h of hist) {
    const ser = h.host + ':' + h.port;
    if (!online.some(d => d.serial === ser) && !offline.some(o => o.serial === ser)) offline.push({ serial: ser, label: h.host + ':' + h.port });
  }
  let html = '';
  if (!online.length && !offline.length) {
    html = '<option value="">Нет устройства — подключите ниже</option>';
  } else {
    for (const d of online) {
      const act = d.serial === activeSerial;
      html += `<option value="${esc(d.serial)}">${act ? '✓' : '●'} ${esc(d.model || d.serial)}${isUsb(d.serial) ? ' [USB]' : ''} — ${act ? 'активно' : 'в сети'}</option>`;
    }
    for (const o of offline) html += `<option value="${esc(o.serial)}">○ ${esc(o.label)} — не подключено</option>`;
    if (!online.some(d => d.serial === activeSerial)) html = `<option value="">— устройство не выбрано —</option>` + html;
  }
  const prev = sel.value;
  sel.innerHTML = html;
  const want = activeSerial && online.some(d => d.serial === activeSerial) ? activeSerial : '';
  sel.value = want || sel.options[0] && sel.options[0].value || '';
  sel.setAttribute('data-tip', sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'Активное устройство');
  void prev;
}

$('#tb-device').onchange = () => {
  const v = $('#tb-device').value;
  if (!v) return;
  if (isOnline(v)) {
    setActive(v);
    snack('Активное устройство: ' + nameOf(v) + ' (' + v + ')');
  } else {
    const [h, p] = v.split(':');
    doConnect(h, +p);
  }
};

function setActive(serial) {
  activeSerial = serial || null;
  renderTbDevice();
  renderActiveCard();
  renderDevices();
  renderSavedChipsState();
  updateToolsState();
}

/* карточка активного устройства на странице «Подключение» */
async function renderActiveCard() {
  const card = $('#active-card'), empty = $('#active-empty');
  const s = activeSerial;
  if (!s || !isOnline(s)) {
    card.classList.add('hidden');
    empty.classList.remove('hidden');
    $('#tools-active-label').textContent = '';
    $('#fs-active-label').textContent = '';
    $('#apps-active-label').textContent = '';
    return;
  }
  card.classList.remove('hidden');
  empty.classList.add('hidden');
  $('#ad-name').textContent = nameOf(s);
  $('#ad-serial').textContent = s + (isUsb(s) ? ' · USB' : '');
  const d = devices.find(x => x.serial === s);
  const chips = [];
  if (d && d.android) chips.push('Android <b>' + esc(d.android) + '</b>');
  const info = infoCache[s] && infoCache[s].info;
  if (info && info.battery && info.battery !== '?') chips.push('Батарея <b>' + esc(info.battery) + '%</b>');
  if (pingCache[s] != null) chips.push('Пинг <b>' + pingCache[s] + ' мс</b>');
  chips.push(isUsb(s) ? '<b>USB</b>' : '<b>Wi-Fi</b>');
  $('#ad-chips').innerHTML = chips.join('');
  const label = nameOf(s);
  $('#tools-active-label').textContent = 'Устройство: ' + label;
  $('#fs-active-label').textContent = 'Устройство: ' + label;
  $('#apps-active-label').textContent = 'Устройство: ' + label;
  devInfoText(s);
}
const pingCache = {};
let pingBusy = false;
async function pingActive() {
  if (!activeSerial || !isOnline(activeSerial) || pingBusy) return;
  pingBusy = true;
  try {
    const r = await window.api.adbPing(activeSerial);
    if (r.ok) {
      pingCache[activeSerial] = r.ms;
      if (activeSerial) renderActiveCard();
    }
  } catch (e) {}
  pingBusy = false;
}

/* ---------- устройства: карточки + списки ---------- */
let refreshBusy = false; // W10-ревизор: не плодим параллельные опросы adb на медленном устройстве
async function refreshDevices() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const r = await window.api.adbDevices();
    devices = r.ok ? r.list : [];
  const online = onlineDevices();
  // потеря активного устройства (A1-ревью): сбрасываем, глушим привязанные инструменты,
  // если в сети ровно одно — назначаем его активным автоматически
  if (activeSerial && !online.some(d => d.serial === activeSerial)) {
    logLostActive(activeSerial);
    activeSerial = null;
    if (mirrorOn) mirrorStopUI(true);
    if (recTimer) { clearInterval(recTimer); recTimer = null; recordUIReset(); }
    if (logcatOn) { logcatOn = false; logcatButtons(); }
    if (shellOn) { shellOn = false; $('#shell-view').textContent += '\n[устройство отключено]\n'; }
    if (online.length === 1) activeSerial = online[0].serial;
  }
  renderTbDevice();
  renderActiveCard();
  renderDevices();
  renderSavedChipsState();
  updateToolsState();
  } finally { refreshBusy = false; }
}

// v2.7.2: «active lost» в журнале не чаще раза в 2 минуты на serial — раньше при устаревшем
// порте сообщение спамило каждые 5 секунд (refreshDevices) и засоряло логфайл
const _lostLoggedAt = {};
function logLostActive(serial) {
  const t = Date.now();
  if (_lostLoggedAt[serial] && t - _lostLoggedAt[serial] < 120000) return;
  _lostLoggedAt[serial] = t;
  try { window.api.uiLog('active lost: ' + serial); } catch (e) {}
}

function renderDevices() {
  const box = $('#device-list');
  const online = onlineDevices();
  $('#device-empty').classList.toggle('hidden', online.length > 0);
  box.innerHTML = online.map(d => {
    const isNet = !isUsb(d.serial);
    const [host, port] = isNet ? d.serial.split(':') : [null, null];
    const fav = (state.favorites || []).some(f => f.host === host && f.port === +port);
    const act = d.serial === activeSerial;
    return `<div class="card dev-card">
      <div class="dev-name"><span class="dot${act ? '' : ' off'}"></span>${esc(d.model || d.props.product || d.serial)}
        <span class="${chipClass(d.serial)}">${stText(d.serial)}</span>
        ${isNet ? `<button class="star ${fav ? 'on' : ''}" data-fav="${esc(d.serial)}" data-tip="В избранное">&#9733;</button>` : ''}
      </div>
      <div class="dev-serial" data-copy="${esc(d.serial)}" data-tip="Нажмите, чтобы скопировать">${esc(d.serial)}${isNet ? '' : ' · USB'} <span id="info-${esc(d.serial).replace(/[:.]/g, '_')}"></span></div>
      <div class="dev-actions">
        ${!act ? `<button class="btn btn-tonal btn-sm" data-setact="${esc(d.serial)}" data-tip="Сделать активным (текущее не отключается)">Сделать активным</button>` : ''}
        <button class="btn btn-tonal btn-sm" data-tools="${esc(d.serial)}">Инструменты</button>
        <button class="btn btn-text btn-sm" data-info="${esc(d.serial)}">Об устройстве</button>
        ${isNet ? `<button class="btn btn-text btn-sm" data-disc="${esc(d.serial)}">Отключить</button>` : ''}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-tools]').forEach(b => b.onclick = () => {
    setActive(b.dataset.tools);
    goPage('tools');
  });
  box.querySelectorAll('[data-setact]').forEach(b => b.onclick = () => {
    setActive(b.dataset.setact);
    snack('Активное устройство: ' + nameOf(b.dataset.setact));
  });
  box.querySelectorAll('[data-info]').forEach(b => b.onclick = () => openDevInfo(b.dataset.info));
  box.querySelectorAll('[data-disc]').forEach(b => b.onclick = async () => {
    const r = await window.api.adbDisconnect(b.dataset.disc);
    snack(r.message || 'Отключено');
    if (activeSerial === b.dataset.disc) activeSerial = null;
    refreshDevices();
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  for (const d of online) {
    devInfoText(d.serial).then(t => {
      const el = document.getElementById('info-' + d.serial.replace(/[:.]/g, '_'));
      if (el) el.textContent = t ? '· ' + t : '';
    });
  }
  box.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.fav.split(':');
    const d = devices.find(x => x.serial === b.dataset.fav);
    state.favorites = await window.api.favToggle({ host, port: +port, model: d && d.model });
    renderDevices(); renderFavorites();
  });
}
function renderSavedChipsState() { /* placeholder: статусы списков обновляются в renderDevices */ }

function renderHistory() {
  const box = $('#hist-list');
  const h = state.history || [];
  $('#hist-empty').classList.toggle('hidden', h.length > 0);
  box.innerHTML = h.map(x => {
    const ser = x.host + ':' + x.port;
    return `<div class="list-row">
      <span class="mono grow2" data-copy="${esc(ser)}" style="cursor:copy">${esc(x.host)}:${esc(x.port)} ${x.model ? '<span class="muted">— ' + esc(x.model) + '</span>' : ''} <span class="${chipClass(ser)}">${stText(ser)}</span></span>
      <span class="muted">${fmtTs(x.lastTs)}</span>
      <button class="btn btn-tonal btn-sm" data-hc="${esc(ser)}">Подключить</button>
      <button class="btn btn-text btn-sm" data-hx="${esc(ser)}" data-tip="Убрать">&#x2715;</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-hc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.hc.split(':');
    doConnect(host, +port);
  });
  box.querySelectorAll('[data-hx]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.hx.split(':');
    state.history = await window.api.histRemove(host, +port);
    renderHistory(); renderRecents();
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  renderRecents();
}

// чипы «Недавно подключённые» — быстрый доступ без прокрутки к истории (A1)
function renderRecents() {
  const box = $('#recents-chips');
  const h = (state.history || []).slice(0, 3);
  box.innerHTML = h.length ? '<span class="muted small">Недавние:</span>' + h.map(x => {
    const ser = x.host + ':' + x.port;
    return `<button class="chip" data-rc="${esc(ser)}" data-tip="${esc(ser)}">${esc(x.model || x.host)} <span class="muted">${stText(ser)}</span></button>`;
  }).join('') : '';
  box.querySelectorAll('[data-rc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.rc.split(':');
    doConnect(host, +port);
  });
}

function renderFavorites() {
  const box = $('#fav-list');
  const f = state.favorites || [];
  $('#fav-empty').classList.toggle('hidden', f.length > 0);
  box.innerHTML = f.map(x => {
    const ser = x.host + ':' + x.port;
    return `<div class="card dev-card">
      <div class="dev-name"><span class="dot${isOnline(ser) ? (ser === activeSerial ? '' : ' off') : ' off'}"></span>${esc(x.model || x.host)}
        <span class="${chipClass(ser)}">${stText(ser)}</span>
        <button class="star on" data-favr="${esc(ser)}">&#9733;</button></div>
      <div class="dev-serial" data-copy="${esc(ser)}" style="cursor:copy">${esc(ser)}</div>
      <div class="dev-actions"><button class="btn btn-tonal btn-sm" data-fc="${esc(ser)}">Подключить</button></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-fc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.fc.split(':');
    doConnect(host, +port);
  });
  box.querySelectorAll('[data-favr]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.favr.split(':');
    state.favorites = await window.api.favToggle({ host, port: +port });
    renderDevices(); renderFavorites();
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
}

async function doConnect(host, port) {
  if (!host) return snack('Введите IP-адрес');
  snack('Подключение к ' + host + ':' + port + '…');
  const r = await window.api.adbConnect(host, +port);
  if (r.ok) {
    // v2.7.1: main может «самоисцелиться» — найти живой порт, если введённый закрыт
    const hp = r.host ? r.host : host, hport = r.port ? r.port : port;
    snack(r.healed ? (r.message || 'Подключено через другой порт') : 'Подключено: ' + hp + ':' + hport);
    state = await window.api.getState();
    setActive(hp + ':' + hport);
    renderHistory(); renderFavorites();
    refreshDevices();
    snd.play('connect');
  } else {
    snack('Не удалось подключиться: ' + (r.message || r.error || 'ошибка'), 7000);
  }
}

$('#btn-connect').onclick = () => {
  let host = $('#in-ip').value.trim();
  let port = $('#in-port').value.trim() || '5555';
  const m = host.match(/^([\d.]+):(\d+)$/);   // «192.168.1.6:44515» как на телефоне
  if (m) { host = m[1]; port = m[2]; $('#in-ip').value = host; $('#in-port').value = port; }
  doConnect(host, port);
};
$('#in-ip').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-connect').click(); });
$('#btn-hist-clear').onclick = async () => { state.history = await window.api.histClear(); renderHistory(); };
$('#btn-help').onclick = () => openDlg('dlg-help');
$('#adb-banner-link').onclick = (e) => { e.preventDefault(); goPage('settings'); };

/* активная карточка: кнопки */
$('#btn-ad-tools').onclick = () => goPage('tools');
$('#btn-ad-info').onclick = () => { if (activeSerial) openDevInfo(activeSerial); };
$('#btn-ad-disc').onclick = async () => {
  if (!activeSerial) return;
  const r = await window.api.adbDisconnect(activeSerial);
  snack(r.message || 'Отключено');
  activeSerial = null;
  refreshDevices();
};
$('#ad-serial').onclick = () => copyText($('#ad-serial').textContent);

/* ---------- сканирование ---------- */
function renderScanResults() {
  const box = $('#scan-results');
  if (!scanFound.length) {
    box.innerHTML = '<div class="empty">В локальной сети не найдено ни открытого порта 5555, ни mDNS-сервисов беспроводной отладки. Смотрите подсказку ниже.</div>';
    return;
  }
  box.innerHTML = scanFound.map((f, i) => `<div class="list-row">
      <span class="mono grow2">${esc(f.host)}:${esc(f.port)} <span class="muted">· ${esc(f.label || 'порт 5555')}${f.sid ? ' · ' + esc(f.sid) : ''}</span></span>
      <button class="btn btn-tonal btn-sm" data-sc="${i}">Подключить</button>
    </div>`).join('');
  box.querySelectorAll('[data-sc]').forEach(b => b.onclick = () => {
    const f = scanFound[+b.dataset.sc];
    doConnect(f.host, f.port);
  });
}

$('#btn-scan').onclick = async () => {
  $('#scan-card').classList.remove('hidden');
  $('#scan-card').classList.remove('scanning-done');
  $('#scan-progress').classList.remove('hidden');
  $('#scan-title').textContent = 'Сканирование локальной сети…';
  $('#scan-results').innerHTML = '';
  $('#scan-bar').style.width = '0%';
  $('#scan-progress-text').textContent = '0%';
  scanFound = [];
  const found = await window.api.scanSubnet();
  scanFound = (found || []).map(x => ({ host: x.host, port: x.port, label: x.label || 'порт 5555', sid: x.sid }));
  renderScanResults();
};

/* ---------- сопряжение (инлайн на странице, R4/R6) ---------- */
$('#btn-do-pair').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  const port = $('#pair-port').value.trim();
  const code = $('#pair-code').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Введите IP сопряжения');
  if (!port) return snack('Введите порт сопряжения или нажмите «Найти порт»');
  if (!/^\d{4,8}$/.test(code)) return snack('Введите код сопряжения (цифры)');
  $('#btn-do-pair').disabled = true;
  snack('Сопряжение…');
  const r = await window.api.adbPair(host, port, code);
  $('#btn-do-pair').disabled = false;
  if (r.ok) {
    snack('Сопряжение выполнено. Теперь найдём устройство…');
    await pairFindAndConnect(host);
  } else {
    snack('Сопряжение не удалось: ' + (r.error || r.message || ''));
  }
};

$('#btn-find-port').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Сначала введите IP');
  snack('Ищу порты на ' + host + '…');
  const ports = await window.api.adbPortScan(host);
  if (!ports.length) return snack('Открытых портов в диапазоне 30000–44999 нет');
  $('#pair-port').value = ports[0];
  snack('Найдены порты: ' + ports.join(', ') + ' — подставлен первый');
};

$('#btn-auto-pair').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  const code = $('#pair-code').value.trim();
  const port = $('#pair-port').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Введите IP');
  if (!/^\d{4,8}$/.test(code)) return snack('Введите код с телефона');
  $('#btn-auto-pair').disabled = true;
  snack('Авто: поиск портов, сопряжение, подключение…');
  const r = await window.api.adbAutoPair(host, code, port ? +port : null);
  $('#btn-auto-pair').disabled = false;
  if (r.ok) {
    snack('Подключено: ' + r.host + ':' + r.port);
    state = await window.api.getState();
    setActive(r.host + ':' + r.port);
    renderHistory(); refreshDevices();
  }
  else snack(r.error || 'Не удалось');
};

async function pairFindAndConnect(knownHost) {
  const md = await window.api.mdnsDiscover();
  const conn = (md || []).filter(x => (x.service || '').includes('connect'));
  if (conn.length) {
    for (const c of conn) await doConnect(c.host, c.port);
    return;
  }
  if (knownHost) {
    const ports = await window.api.adbPortScan(knownHost);
    const cand = ports.filter(p => p !== +$('#pair-port').value);
    for (const p of cand) { const r = await window.api.adbConnect(knownHost, p); if (r.ok) return; }
    if (cand.length) return snack('Порты найдены, но подключение не удалось — разрешите отладку на телефоне');
  }
  snack('Устройство не найдено по mDNS. Введите IP и порт с экрана «Беспроводная отладка».');
}

$('#btn-pair-mdns').onclick = () => pairFindAndConnect($('#pair-ip').value.trim() || null);

/* ---------- QR-подключение: ПК показывает код, телефон сканирует камерой (R2) ----------
   v2.8.0: QR показывается СРАЗУ на карточке сопряжения (панель #qr-inline ~156×149 px),
   без отдельного диалога и без повторных нажатий; шаги «поиск → сопряжение → подключено»
   видны мгновенно строкой под кодом. */
function qrSetStatus(text, cls) {
  const el = $('#qr-pc-status');
  el.textContent = text;
  el.className = 'qr-status' + (cls ? ' ' + cls : '');
  qrLog(text);
}
function qrLog(text) {
  const box = $('#qr-pc-log');
  if (!box) return;
  const div = document.createElement('div');
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
async function qrBegin() {
  const panel = $('#qr-inline');
  if (panel) panel.classList.remove('hidden');
  qrSetStatus('Готовим QR-код…', '');
  const r = await window.api.qrStart();
  if (!r.ok) { qrSetStatus(r.error || 'Не удалось запустить сессию', 'err'); return; }
  qrActive = true;
  QRCodeLib.toCanvas($('#qr-pc-canvas'), r.qrText, { width: 156, height: 149, margin: 0, color: { dark: '#000000', light: '#ffffff' } }, err => {
    if (err) qrSetStatus('Ошибка отрисовки QR: ' + err.message, 'err');
    else qrSetStatus('Сканируйте камерой телефона: «Беспроводная отладка» → «Подключить по QR-коду»', '');
  });
}
function qrHidePanel() { qrActive = false; const p = $('#qr-inline'); if (p) p.classList.add('hidden'); }
$('#btn-qr-show').onclick = () => { if (qrActive) { window.api.qrCancel(); } qrBegin(); };
$('#btn-qr-cancel-inline').onclick = () => { window.api.qrCancel(); qrHidePanel(); };

/* ---------- инструменты: состояние и общие ---------- */
function currentSerial() { return activeSerial; }
function updateToolsState() {
  const ok = !!activeSerial;
  $$('#tools-grid .btn, #tools-grid .chip').forEach(b => {
    if (b.id === 'btn-diag') return; // диагностика доступна и без устройства
    b.disabled = !ok;
    if (!ok && !b.dataset.tip) b.setAttribute('data-tip', 'Сначала подключите устройство на странице «Подключение»');
  });
  $('#tools-grid').style.opacity = ok ? '1' : '.5';
  $('#tools-nodevice').classList.toggle('hidden', ok);
}

$('#btn-devices-refresh').onclick = refreshDevices;

$('#btn-screenshot').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  snack('Делаю снимок…');
  const r = await window.api.toolScreenshot(s);
  if (r.ok) { snack('Сохранено: ' + r.file); window.api.showItem(r.file); }
  else if (!r.canceled) snack('Ошибка снимка: ' + (r.error || ''));
};

function recordUIReset() {
  $('#btn-record-stop').classList.add('hidden');
  $('#btn-record-start').classList.remove('hidden');
}
$('#btn-record-start').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const r = await window.api.toolRecordStart(s);
  if (!r.ok) return snack(r.error || 'Ошибка записи');
  recStart = Date.now();
  $('#btn-record-start').classList.add('hidden');
  $('#btn-record-stop').classList.remove('hidden');
  recTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - recStart) / 1000);
    $('#rec-timer').textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }, 500);
};
$('#btn-record-stop').onclick = async () => {
  clearInterval(recTimer); recTimer = null;
  recordUIReset();
  snack('Останавливаю запись и сохраняю…');
  const r = await window.api.toolRecordStop();
  if (r.ok) { snack('Видео сохранено: ' + r.file); window.api.showItem(r.file); }
  else if (!r.canceled) snack('Ошибка записи: ' + (r.error || ''));
};

/* ---------- сохранённые устройства ---------- */
async function renderSaved() {
  savedItems = await window.api.savedList();
  const list = savedItems;
  const box = $('#saved-list');
  $('#saved-empty').classList.toggle('hidden', list.length > 0);
  box.innerHTML = list.map(x => {
    const ser = x.host + ':' + x.port;
    return `<div class="card dev-card">
    <div class="dev-name"><span class="dot${ser === activeSerial ? '' : ' off'}"></span>${esc(x.name || x.host)}
      <span class="${chipClass(ser)}">${stText(ser)}</span></div>
    <div class="dev-serial" data-copy="${esc(ser)}" style="cursor:copy">${esc(ser)}${x.model ? ' · ' + esc(x.model) : ''}</div>
    <div class="dev-actions">
      <button class="btn btn-tonal btn-sm" data-sconn="${esc(x.id)}">${isOnline(ser) ? 'Сделать активным' : 'Подключить'}</button>
      <button class="btn btn-text btn-sm" data-sren="${esc(x.id)}">Переименовать</button>
      <button class="btn btn-text btn-sm" data-sdel="${esc(x.id)}">Удалить</button>
    </div></div>`;
  }).join('');
  box.querySelectorAll('[data-sconn]').forEach(b => b.onclick = async () => {
    const it = list.find(x => x.id === b.dataset.sconn);
    const ser = it.host + ':' + it.port;
    if (isOnline(ser)) { setActive(ser); snack('Активное устройство: ' + (it.name || ser)); }
    else doConnect(it.host, it.port);
  });
  box.querySelectorAll('[data-sren]').forEach(b => b.onclick = async () => {
    const it = list.find(x => x.id === b.dataset.sren);
    const name = await askText('Переименовать устройство', 'Имя устройства:', it.name || it.host);
    if (name) { await window.api.savedRename(it.id, name); renderSaved(); }
  });
  box.querySelectorAll('[data-sdel]').forEach(b => b.onclick = async () => {
    await window.api.savedRemove(b.dataset.sdel); renderSaved(); snack('Удалено из списка');
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  renderTbDevice();
}

$('#btn-saved-add').onclick = async () => {
  const online = onlineDevices();
  if (online.length) {
    const d = online[0];
    const [host, port] = d.serial.includes(':') ? d.serial.split(':') : [null, null];
    if (host) { await window.api.savedAdd({ host, port: +port, name: d.model || host, model: d.model }); }
    else snack('USB-устройства сохраняются автоматически при подключении по сети');
  } else {
    const s = await askText('Добавить устройство', 'IP:порт устройства (например 192.168.1.6:44515):', '');
    if (!s) return;
    const m = s.match(/^([\d.]+):(\d+)$/);
    if (!m) return snack('Формат: IP:порт');
    const name = (await askText('Имя устройства', 'Как назвать это устройство:', m[1])) || m[1];
    await window.api.savedAdd({ host: m[1], port: +m[2], name });
  }
  renderSaved(); snack('Сохранено');
};

/* ---------- инфо об устройстве ---------- */
const infoCache = {};
async function devInfoText(serial) {
  if (infoCache[serial] && Date.now() - infoCache[serial].ts < 30000) return infoCache[serial].text;
  try {
    const i = await window.api.devInfo(serial);
    const text = [i.manufacturer && i.model ? i.manufacturer + ' ' + i.model : '', i.android ? 'Android ' + i.android : '', i.battery && i.battery !== '?' ? i.battery + '%' : '', i.screen ? i.screen : ''].filter(Boolean).join(' · ');
    infoCache[serial] = { ts: Date.now(), text, info: i };
    return text;
  } catch (e) { return ''; }
}

async function openDevInfo(serial) {
  let i;
  try { i = await window.api.devFull(serial); } catch (e) { snack('Не удалось получить данные устройства: ' + (e.message || e)); return; }
  if (!i || !i.model && !i.manufacturer) { snack('Устройство не отвечает'); return; }
  const st = i.storage ? ('занято ' + i.storage.used + ' из ' + i.storage.total + ', свободно ' + i.storage.free) : '—';
  $('#devinfo-body').innerHTML = [
    ['Производитель', i.manufacturer], ['Модель', i.model], ['Android', i.android],
    ['Сборка', i.build], ['Патч безопасности', i.patch], ['Процессор (ABI)', i.abi],
    ['Экран', i.screen], ['Батарея', i.battery + '%'], ['Память /data', st],
    ['ОЗУ (всего)', i.memTotalKb ? Math.round(i.memTotalKb / 1024 / 1024 * 10) / 10 + ' ГБ' : '—'],
    ['Имя в сети', i.hostname], ['Адрес подключения', serial]
  ].map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1] || '—') + '</div>').join('');
  openDlg('dlg-devinfo');
}

/* ---------- logcat: пауза + фильтр (R14) ---------- */
function logcatButtons() {
  $('#btn-logcat-start').classList.toggle('hidden', logcatOn);
  $('#btn-logcat-stop').classList.toggle('hidden', !logcatOn);
}
$('#btn-logcat-start').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  $('#logcat-view').textContent = '';
  logcatBuf = [];
  await window.api.toolLogcatStart(s);
  logcatOn = true; logcatPaused = false;
  $('#btn-logcat-pause').textContent = 'Пауза';
  logcatButtons();
};
$('#btn-logcat-stop').onclick = async () => {
  await window.api.toolLogcatStop();
  logcatOn = false;
  logcatButtons();
};
$('#btn-logcat-pause').onclick = () => {
  if (!logcatOn) return;
  logcatPaused = !logcatPaused;
  $('#btn-logcat-pause').textContent = logcatPaused ? 'Продолжить' : 'Пауза';
};
$('#btn-logcat-clear').onclick = async () => {
  $('#logcat-view').textContent = '';
  logcatBuf = [];
  const s = currentSerial(); if (s) await window.api.toolLogcatClear(s);
};
window.api.onLogcat(lines => {
  if (!logcatOn || logcatPaused) return;
  const q = ($('#logcat-filter').value || '').toLowerCase();
  const v = $('#logcat-view');
  let add = lines;
  if (q) add = lines.filter(l => l.toLowerCase().includes(q));
  if (add.length) {
    v.textContent += add.join('\n') + '\n';
    if (v.textContent.length > 200000) v.textContent = v.textContent.slice(-150000);
    v.scrollTop = v.scrollHeight;
  }
});

/* ---------- терминал: библиотека команд + свои команды + автодополнение (F16/F17) ---------- */
let shellOn = false;
const shellHist = []; let shellHistIdx = -1;
const ERR_RE = /\b(error|failed|failure|exception|not found|denied|invalid|unable|cannot|no such)\b/i;
function appendShell(text) {
  const v = $('#shell-view');
  for (const line of text.split('\n')) {
    const div = document.createElement('div');
    if (ERR_RE.test(line)) div.className = 'line-err';
    div.textContent = line;
    v.appendChild(div);
  }
  while (v.children.length > 1500) v.removeChild(v.firstChild);
  v.scrollTop = v.scrollHeight;
}
window.api.onShellOut(t => appendShell(t));
$('#btn-shell-toggle').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  if (shellOn) { await window.api.shellStop(); shellOn = false; $('#shell-view').textContent += '\n[сессия остановлена]\n'; }
  else { await window.api.shellStart(s); shellOn = true; $('#shell-view').textContent = '[сессия adb shell запущена]\n'; }
};
function shellSend() {
  const inp = $('#shell-input');
  const line = inp.value.trim();
  if (!line) return;
  $('#shell-view').textContent += '$ ' + line + '\n';
  shellHist.push(line); if (shellHist.length > 100) shellHist.shift();
  shellHistIdx = shellHist.length;
  window.api.shellWrite(line);
  inp.value = '';
  shellAcClose();
}
$('#btn-shell-send').onclick = shellSend;
$('#btn-shell-clear').onclick = () => { $('#shell-view').textContent = ''; };

// все варианты: библиотека по производителям + свои (Сохранения/Мои команды.json) + старые избранные
let customCmds = [];
function shellCmdOptions() {
  const lib = (window.CMDLIB || []).map(g => ({
    group: g.group,
    cmds: (g.cmds || []).map(c => ({ name: c.name, cmd: c.cmd, desc: c.desc || '', danger: !!c.danger, custom: false }))
  }));
  if (customCmds.length) {
    lib.unshift({ group: 'Мои команды (Сохранения)', cmds: customCmds.map(c => ({ name: c.name, cmd: c.cmd, desc: 'Своя команда — хранится в папке «Сохранения»', danger: false, custom: true })) });
  }
  return lib;
}
function allCmdFlat() {
  const out = [];
  for (const g of shellCmdOptions()) for (const c of g.cmds) out.push(c);
  return out;
}
function renderShellSelect() {
  const sel = $('#shell-cmd-select');
  sel.innerHTML = shellCmdOptions().map(g =>
    '<optgroup label="' + esc(g.group) + '">' +
    g.cmds.map(o => '<option title="' + esc(o.desc) + '" value="' + esc(o.cmd) + '">' + esc(o.name) + (o.danger ? ' ⚠' : '') + (o.custom ? ' ★' : '') + '</option>').join('') +
    '</optgroup>').join('');
  shellDesc();
}
function shellDesc() {
  const sel = $('#shell-cmd-select');
  const o = allCmdFlat().find(x => x.cmd === sel.value);
  $('#shell-cmd-desc').innerHTML = o
    ? (o.danger ? '<b style="color:var(--warn)">⚠ Внимание:</b> ' : '') + esc(o.desc)
    : '';
}
$('#shell-cmd-select').onchange = () => { shellDesc(); $('#shell-input').value = $('#shell-cmd-select').value; shellAcClose(); };
$('#shell-cmd-select').onmouseover = shellDesc;

// сохранить свою команду с именем (F16) — файл «Сохранения/Мои команды.json»
$('#btn-shell-cmd-save').onclick = async () => {
  const v = $('#shell-input').value.trim();
  if (!v) return snack('Сначала введите команду в поле ниже');
  const name = await askText('Своя команда', 'Как назвать команду для списка:', v.slice(0, 40));
  if (!name) return;
  const r = await window.api.cmdsAdd(name, v);
  if (!r.ok) return snack('Не удалось сохранить: ' + (r.error || ''));
  customCmds = r.list;
  renderShellSelect();
  snack('Сохранено в «Сохранения/Мои команды.json» ★');
};
// удалить выбранную свою команду
$('#btn-shell-cmd-del').onclick = async () => {
  const v = $('#shell-cmd-select').value;
  const c = customCmds.find(x => x.cmd === v);
  if (!c) return snack('Выберите в списке СВОЮ команду (группа «Мои команды»), чтобы удалить');
  const r = await window.api.cmdsRemove(v);
  customCmds = r.list;
  renderShellSelect();
  snack('Удалено из списка');
};

/* автодополнение ввода команд (F17): подсказки из всей библиотеки + своих */
const shellAc = $('#shell-ac');
let shellAcItems = [], shellAcIdx = -1;
function shellAcClose() { shellAc.classList.add('hidden'); shellAc.innerHTML = ''; shellAcItems = []; shellAcIdx = -1; }
function shellAcPick(i) {
  const it = shellAcItems[i];
  if (!it) return;
  $('#shell-input').value = it.cmd;
  shellAcClose();
  $('#shell-input').focus();
}
function shellAcRender() {
  shellAc.innerHTML = shellAcItems.map((it, i) =>
    '<div class="shell-ac-item' + (i === shellAcIdx ? ' sel' : '') + '" data-i="' + i + '">' +
    '<span class="ac-name">' + esc(it.name) + (it.danger ? ' ⚠' : '') + '</span>' +
    '<span class="ac-cmd mono">' + esc(it.cmd) + '</span></div>').join('');
  shellAc.classList.remove('hidden');
  shellAc.querySelectorAll('.shell-ac-item').forEach(el => {
    el.onmousedown = (e) => { e.preventDefault(); shellAcPick(+el.dataset.i); };
  });
}
$('#shell-input').addEventListener('input', () => {
  const q = $('#shell-input').value.trim().toLowerCase();
  if (!q) return shellAcClose();
  const flat = allCmdFlat();
  const starts = [], has = [];
  for (const c of flat) {
    const hay = (c.name + ' ' + c.cmd).toLowerCase();
    if (c.cmd.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q)) starts.push(c);
    else if (hay.includes(q)) has.push(c);
    if (starts.length >= 8) break;
  }
  shellAcItems = starts.concat(has).slice(0, 8);
  shellAcIdx = shellAcItems.length ? 0 : -1;
  shellAcItems.length ? shellAcRender() : shellAcClose();
});
$('#shell-input').addEventListener('keydown', e => {
  if (shellAcItems.length) {
    if (e.key === 'ArrowDown') { shellAcIdx = (shellAcIdx + 1) % shellAcItems.length; shellAcRender(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { shellAcIdx = (shellAcIdx - 1 + shellAcItems.length) % shellAcItems.length; shellAcRender(); e.preventDefault(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { if (shellAcIdx >= 0) { shellAcPick(shellAcIdx); e.preventDefault(); return; } }
    if (e.key === 'Escape') { shellAcClose(); return; }
  }
  if (e.key === 'Enter') shellSend();
  else if (e.key === 'ArrowUp') {
    if (shellHistIdx > 0) { shellHistIdx--; $('#shell-input').value = shellHist[shellHistIdx] || ''; }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (shellHistIdx < shellHist.length - 1) { shellHistIdx++; $('#shell-input').value = shellHist[shellHistIdx] || ''; }
    else { shellHistIdx = shellHist.length; $('#shell-input').value = ''; }
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#shell-ac, #shell-input')) shellAcClose(); });

async function initTerminalLib() {
  try { customCmds = await window.api.cmdsList() || []; } catch (e) { customCmds = []; }
  // одноразовая миграция старых «избранных» (config.favCmds) в «Мои команды» с именем
  const favs = (state && state.config && state.config.favCmds) || [];
  for (const f of favs) {
    if (!customCmds.some(c => c.cmd === f)) {
      try {
        const r = await window.api.cmdsAdd(f.length > 40 ? f.slice(0, 40) + '…' : f, f);
        if (r.ok) customCmds = r.list;
      } catch (e) {}
    }
  }
  if (favs.length) { try { await window.api.setSetting('favCmds', []); } catch (e) {} }
  renderShellSelect();
}
renderShellSelect(); // сразу — библиотека доступна без ожидания конфига

/* ---------- зеркало экрана (R9): h264 + смена SPS + простой режим + FPS ---------- */
let mirrorOn = false, mirrorMode = 'h264', mirrorDec = null, mirrorPts = 0;
let mirrorCarry = new Uint8Array(0);
let mirrorSPS = null, mirrorPPS = null, mirrorDev = null, mirrorWaitingKey = false;
let mirrorFrames = 0, mirrorFpsLast = 0, mirrorFpsTimer = null, mirrorJpegSeq = 0;
let mirrorStallHandled = false, mirrorBlackRun = 0, mirrorGen = 0;
// v2.7.1: лестница декодера — жалоба «данные идут, но ни одного кадра не выдано»: на части
// машин аппаратный декодер WebCodecs молча не выдаёт кадры. Раньше мы сразу уезжали в
// снимки экрана; теперь пробуем ступени: 0 — avcC (как было), 1 — Annex-B без description,
// 2 — Annex-B + ПРОГРАММНОЕ декодирование (работает везде), и лишь потом — простой режим.
let mirrorDecStage = 0, mirrorQueued = 0, mirrorFirstQueueAt = 0;
let mirrorBounced = false;   // v2.7.2: однократный перезапуск потока, если заголовок/кадры не приходят
const SC4 = new Uint8Array([0, 0, 0, 1]);
// вотчдог «данные идут, а кадров нет»: реальный кейс владельца — декодер сконфигурирован,
// байты капают, но ни один кадр так и не выдан → вечный чёрный экран (F15)
let mirrorLastChunkAt = 0, mirrorLastFrameAt = 0;
const mcanvas = () => $('#mirror-canvas');

function avccConfig(sps, pps) {
  const d = new Uint8Array(11 + sps.length + pps.length);
  const v = new DataView(d.buffer);
  d.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1], 0);
  v.setUint16(6, sps.length); d.set(sps, 8);
  const pos = 8 + sps.length;
  d[pos] = 1;
  v.setUint16(pos + 1, pps.length); d.set(pps, pos + 3);
  return d;
}
function hex(b) { return b.toString(16).padStart(2, '0'); }
function sameBytes(a, b) { return a && b && a.length === b.length && a.every((x, i) => x === b[i]); }
function mirrorDecClose() { if (mirrorDec) { try { mirrorDec.close(); } catch (e) {} mirrorDec = null; } }

function mirrorFpsLabel(extra) {
  $('#mirror-fps').textContent = extra || '';
}
function mirrorFpsTick() {
  if (!mirrorOn) return;
  const now = Date.now();
  const fps = Math.round((mirrorFrames - mirrorFpsLast) * 1000 / Math.max(1, now - (mirrorFpsTick._t || now - 1000)));
  mirrorFpsLast = mirrorFrames;
  mirrorFpsTick._t = now;
  const c = mcanvas();
  const modeTxt = mirrorMode === 'jpeg' ? 'снимки' : 'h264 · 8 Мбит/с';
  const q = (mirrorDec && mirrorDec.decodeQueueSize) || 0;
  mirrorFpsLabel((fps >= 0 ? fps : 0) + ' к/с · ' + c.width + '×' + c.height + ' · ' + modeTxt + (q > 8 ? ' · буфер ' + q : ''));
  // F15/v2.7.1: поток живой (байты капают), а кадров нет → сначала пробуем ДРУГИЕ способы
  // декодирования (Annex-B → программный декодер, каждый раз со свежим потоком), и только
  // после них — снимки экрана. В v2.7.0 сразу включался простой режим — выглядело как «сломалось».
  // v2.7.2: если в потоке ВООБЩЕ не появились SPS/PPS (заголовок кодека) или декодер ни разу
  // не принял кадр — сначала ОДИН раз перезапускаем поток (bounce — свежий SPS/PPS/IDR):
  // частая причина «данные идут, но декодер не принял поток» — пропущенное начало потока.
  if (mirrorMode === 'h264' && mirrorLastChunkAt && now - mirrorLastChunkAt < 3000 && !mirrorFrames) {
    if (!mirrorSPS && now - mirrorLastChunkAt > 3200 && !mirrorBounced) {
      mirrorBounced = true;
      $('#mirror-status').textContent = 'Перезапускаю поток — жду заголовок кодека (SPS/PPS)…';
      window.api.mirrorBounce().catch(() => {});
    } else if (mirrorQueued > 0 && mirrorFirstQueueAt && now - mirrorFirstQueueAt > 2200) mirrorEscalate();
    else if (mirrorLastFrameAt && now - mirrorLastFrameAt > 6000 && !mirrorQueued) {
      if (!mirrorBounced) {
        mirrorBounced = true;
        $('#mirror-status').textContent = 'Перезапускаю поток — декодер не принял ни кадра…';
        window.api.mirrorBounce().catch(() => {});
      } else scheduleFallback('данные идут, но декодер так и не принял поток');
    }
  }
}
function mirrorEscalate() {
  if (!mirrorOn || mirrorMode !== 'h264' || mirrorStallHandled) return;
  if (mirrorDecStage >= 2) { scheduleFallback('декодер так и не выдал кадр (проверены Annex-B и программное декодирование)'); return; }
  mirrorDecStage++;
  mirrorDecClose();
  mirrorSPS = mirrorPPS = null;   // реконфиг из СВЕЖЕГО потока после bounce
  mirrorWaitingKey = true;
  mirrorCarry = new Uint8Array(0);
  mirrorQueued = 0; mirrorFirstQueueAt = 0;
  const how = mirrorDecStage === 1 ? 'Annex-B' : 'программный декодер';
  $('#mirror-status').textContent = 'Кадров нет — переключаю способ декодирования (' + how + ')…';
  snack('Видео не декодируется — пробую другой способ (' + how + ')…');
  window.api.mirrorBounce().catch(() => {}); // свежий SPS/PPS/IDR для нового декодера
}

function mirrorFeed(buf) {
  // NAL-юнит может быть разрезан между chunk'ами потока: держим хвост до следующего start-кода
  // (W8-ревизор: общий потолок carry — мусорный поток без start-кодов не должен расти бесконечно)
  let data = buf;
  if (mirrorCarry.length > 4 * 1024 * 1024) mirrorCarry = new Uint8Array(0);
  if (mirrorCarry.length) {
    data = new Uint8Array(mirrorCarry.length + buf.length);
    data.set(mirrorCarry, 0); data.set(buf, mirrorCarry.length);
  }
  let lastSC = -1, lastSCLen = 0;
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { lastSC = i; lastSCLen = 3; }
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) { lastSC = i; lastSCLen = 4; }
  }
  if (lastSC >= 0) {
    mirrorCarry = data.slice(lastSC + lastSCLen);
    if (mirrorCarry.length > 4 * 1024 * 1024) mirrorCarry = new Uint8Array(0);
    data = data.subarray(0, lastSC);
  } else {
    mirrorCarry = data.length ? mirrorCarry : new Uint8Array(0);
    if (!data.length) return;
    return; // ждём продолжения NAL
  }
  if (!data.length) return;
  let i = 0;
  const nalus = [];
  while (i < data.length - 4) {
    let sc = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) sc = 3;
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) sc = 4;
    if (sc) {
      if (nalus.length) nalus[nalus.length - 1].end = i;
      nalus.push({ start: i + sc, end: data.length });
      i += sc;
    } else i++;
  }
  for (const n of nalus) {
    const nal = data.subarray(n.start, n.end);
    if (!nal.length) continue;
    const type = nal[0] & 0x1f;
    if (type === 7) {
      if (!sameBytes(nal, mirrorSPS)) {
        // смена формата (например, поворот экрана): переинициализация декодера —
        // иначе «чёрный экран, но управление работает» (корень R9-2)
        mirrorSPS = nal; mirrorPPS = null;
        mirrorDecClose();
        mirrorWaitingKey = true;
      }
      continue;
    }
    if (type === 8) { mirrorPPS = nal; continue; }
    if (type === 6) continue; // SEI: часть декодеров даёт на ней Decoding error
    if (mirrorSPS && mirrorPPS && !mirrorDec) mirrorInitDecoder();
    if (type === 5) mirrorWaitingKey = false;     // keyframe: после reconfig можно декодировать
    if (mirrorWaitingKey) continue;               // delta-кадры до keyframe — пропускаем
    if (mirrorDec && mirrorDec.state === 'configured' && (type === 1 || type === 5)) {
      // v2.6.0 (L1): АНТИ-ЛАГ. Если декодер не успевает (слабый ПК/шквал кадров после затыка
      // в Wi-Fi), очередь растёт и картинка отстаёт от реального времени на секунды.
      // Промежуточные кадры пропускаем, пока очередь не рассосётся; при глубоком
      // отставании пересобираем декодер — картинка подскакивает к «сейчас» на IDR-кадре.
      if (type === 1) {
        const q = mirrorDec.decodeQueueSize || 0;
        if (q > 40) { mirrorDecClose(); mirrorWaitingKey = true; continue; }
        if (q > 12) { mirrorFrames++; continue; }  // кадр пропущен осознанно — не фолбэк
      }
      const avcc = new Uint8Array(4 + nal.length);
      new DataView(avcc.buffer).setUint32(0, nal.length);
      avcc.set(nal, 4);
      let chunkData = avcc;
      // v2.7.1: на ступенях 1/2 кормим декодер чистым Annex-B; ключевой кадр несёт SPS+PPS с собой
      if (mirrorDecStage >= 1) {
        const segs = (type === 5 && mirrorSPS && mirrorPPS) ? [SC4, mirrorSPS, SC4, mirrorPPS] : [];
        segs.push(SC4, nal);
        let total = 0; for (const s of segs) total += s.length;
        chunkData = new Uint8Array(total);
        let off = 0; for (const s of segs) { chunkData.set(s, off); off += s.length; }
      }
      if (!mirrorFirstQueueAt) mirrorFirstQueueAt = Date.now();
      mirrorQueued++;
      try {
        mirrorDec.decode(new EncodedVideoChunk({ type: type === 5 ? 'key' : 'delta', timestamp: mirrorPts += 33000, data: chunkData }));
      } catch (e) {}
    }
  }
}
function mirrorInitDecoder() {
  const sps = mirrorSPS;
  const codec = 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
  mirrorDec = new VideoDecoder({
    output: (frame) => {
      const c = mcanvas();
      if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
      const ctx = c.getContext('2d');
      ctx.drawImage(frame, 0, 0);
      frame.close();
      mirrorFrames++;
      mirrorLastFrameAt = Date.now();
      mirrorBlackDetect(ctx, c);
    },
    error: (e) => { $('#mirror-status').textContent = 'Ошибка декодера: ' + e.message; scheduleFallback('ошибка декодера'); }
  });
  try {
    // v2.7.1: ступени декодера (см. mirrorDecStage): 0 — avcC, 1 — Annex-B, 2 — Annex-B + software
    const cfg = { codec, optimizeForLatency: true };
    if (mirrorDecStage === 0) cfg.description = avccConfig(mirrorSPS, mirrorPPS);
    else cfg.hardwareAcceleration = mirrorDecStage === 2 ? 'prefer-software' : 'no-preference';
    mirrorDec.configure(cfg);
    $('#mirror-status').textContent = 'Трансляция идёт (кодек ' + codec +
      (mirrorDecStage === 1 ? ' · Annex-B' : mirrorDecStage === 2 ? ' · программный декодер' : '') + ')';
  } catch (e) { $('#mirror-status').textContent = 'Не удалось настроить декодер: ' + e.message; scheduleFallback('декодер не настроился'); }
}
// «чёрный экран» детектим сам: 3 кадра подряд почти чёрные → просим простой режим (A3-ревью)
const blackCnv = document.createElement('canvas'); blackCnv.width = 64; blackCnv.height = 64;
const blackCtx = blackCnv.getContext('2d', { willReadFrequently: true });
function mirrorBlackDetect(ctx, c) {
  try {
    blackCtx.drawImage(c, 0, 0, 64, 64);
    const d = blackCtx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let k = 0; k < d.length; k += 16) sum += (d[k] + d[k + 1] + d[k + 2]) / 3;
    const avg = sum / (d.length / 16);
    if (avg < 10) { if (++mirrorBlackRun >= 3) { mirrorBlackRun = 0; scheduleFallback('чёрный экран'); } }
    else mirrorBlackRun = 0;
  } catch (e) {}
}
function scheduleFallback(reason) {
  if (!mirrorOn || mirrorMode !== 'h264' || mirrorStallHandled) return;
  mirrorStallHandled = true;
  snack('Видеопоток недоступен (' + reason + ') — включаю простой режим (снимки экрана)');
  switchMirrorMode('jpeg');
}
window.api.onMirrorChunk(buf => { if (mirrorOn && mirrorMode === 'h264') { mirrorLastChunkAt = Date.now(); if (!mirrorLastFrameAt) mirrorLastFrameAt = mirrorLastChunkAt; mirrorFeed(new Uint8Array(buf)); } });
// простой режим: PNG/JPEG-кадры из main (самопланирующийся цикл screencap -j, v2.5.0)
window.api.onMirrorJpeg(frame => {
  if (!mirrorOn || mirrorMode !== 'jpeg') return;
  if (!frame || frame.seq <= mirrorJpegSeq) return; // устаревшие кадры дропаем
  mirrorJpegSeq = frame.seq;
  mirrorLastChunkAt = Date.now();
  // формат определяем по сигнатуре: FF D8 = JPEG, иначе PNG (screencap -j мог не сработать)
  const b = frame.buf;
  const isJpeg = b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8;
  const blob = new Blob([b], { type: isJpeg ? 'image/jpeg' : 'image/png' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const c = mcanvas();
    if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    mirrorFrames++;
    mirrorLastFrameAt = Date.now();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
});

async function startMirror(serial, mode) {
  mirrorMode = mode || 'h264';
  mirrorDev = (infoCache[serial] && infoCache[serial].info) || null;
  if (!mirrorDev) { try { mirrorDev = (await window.api.devInfo(serial)); } catch (e) {} }
  mirrorOn = true; mirrorSPS = mirrorPPS = null; mirrorPts = 0; mirrorCarry = new Uint8Array(0);
  mirrorWaitingKey = false; mirrorStallHandled = false; mirrorBlackRun = 0;
  mirrorFrames = 0; mirrorFpsLast = 0; mirrorJpegSeq = 0;
  mirrorDecStage = 0; mirrorQueued = 0; mirrorFirstQueueAt = 0;
  mirrorBounced = false;
  mirrorLastChunkAt = 0; mirrorLastFrameAt = 0;
  mirrorDecClose();
  // сбрасываем канвас: кадр прошлой сессии/устройства не должен выдаваться за новый
  try { const c0 = mcanvas(); c0.width = 720; c0.height = 1600; c0.getContext('2d').clearRect(0, 0, 720, 1600); } catch (e) {}
  $('#mirror-canvas').classList.remove('hidden');
  $('#mirror-placeholder').classList.add('hidden');
  $('#btn-mirror-start').classList.add('hidden');
  $('#btn-mirror-stop').classList.remove('hidden');
  $('#mirror-status').textContent = mirrorMode === 'jpeg' ? 'Простой режим (снимки экрана)…' : 'Запускаю трансляцию…';
  if (mirrorFpsTimer) clearInterval(mirrorFpsTimer);
  mirrorFpsTick._t = Date.now();
  mirrorFpsTimer = setInterval(mirrorFpsTick, 1000);
  const r = await window.api.mirrorStart(serial, mirrorMode);
  if (!r.ok) { snack(r.error || 'Не удалось начать трансляцию'); mirrorStopUI(); }
  else mirrorGen = (r.gen != null) ? r.gen : mirrorGen + 1;
}
function mirrorStopUI(silent) {
  mirrorOn = false;
  mirrorGen = -1; // маркер «сессии нет»: поздний mirror-stopped от старой сессии не убьёт новую
  mirrorCarry = new Uint8Array(0);
  mirrorDecClose();
  if (mirrorFpsTimer) { clearInterval(mirrorFpsTimer); mirrorFpsTimer = null; }
  mirrorFpsLabel('');
  $('#mirror-canvas').classList.add('hidden');
  $('#mirror-placeholder').classList.remove('hidden');
  $('#btn-mirror-stop').classList.add('hidden');
  $('#btn-mirror-start').classList.remove('hidden');
  if (!silent) $('#mirror-status').textContent = '';
}
async function switchMirrorMode(mode) {
  const s = currentSerial(); if (!s) return;
  await window.api.mirrorStop();
  mirrorStopUI(true);
  startMirror(s, mode);
}
$('#btn-mirror-start').onclick = () => { const s = currentSerial(); if (!s) return snack('Нет подключённого устройства'); startMirror(s, 'h264'); };
$('#btn-mirror-stop').onclick = async () => { await window.api.mirrorStop(); mirrorStopUI(); };
$('#btn-mirror-fallback').onclick = () => {
  if (!mirrorOn) { snack('Трансляция не запущена — кнопка включает режим при запуске'); return; }
  switchMirrorMode(mirrorMode === 'h264' ? 'jpeg' : 'h264');
};
$('#btn-mirror-ext').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const r = await window.api.toolScrcpy(s);
  if (!r.ok) snack(r.error || 'Не удалось запустить scrcpy');
  else snack('scrcpy запущен во внешнем окне');
};
$('#btn-mirror-back').onclick = () => { const s = currentSerial(); if (s) window.api.inputKey(s, 4); };
$('#btn-mirror-home').onclick = () => { const s = currentSerial(); if (s) window.api.inputKey(s, 3); };

function mirrorCoords(e) {
  const c = mcanvas();
  const r = c.getBoundingClientRect();
  const w = mirrorDev && mirrorDev.screen ? parseInt(mirrorDev.screen.split('x')[0], 10) : c.width;
  const h = mirrorDev && mirrorDev.screen ? parseInt(mirrorDev.screen.split('x')[1], 10) : c.height;
  return { x: Math.round((e.clientX - r.left) / r.width * w), y: Math.round((e.clientY - r.top) / r.height * h) };
}
let mDown = null;
document.addEventListener('mousedown', e => { if (e.target === mcanvas()) mDown = { e, t: Date.now() }; });
document.addEventListener('mouseup', e => {
  if (!mDown || e.target !== mcanvas()) { mDown = null; return; }
  const s = currentSerial();
  const a = mirrorCoords(mDown.e), b = mirrorCoords(e);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (s) {
    if (dist > 30) window.api.inputSwipe(s, a.x, a.y, b.x, b.y, 250);
    else window.api.inputTap(s, a.x, a.y);
  }
  mDown = null;
});

/* ---------- v2.6: вкладка «Установка APK» — очередь с иконками/именами/версиями ---------- */
const APKQ_EXTS = /\.(apk|aab|apks|xapk|apkm|obb|apk\.1|apk\+|apup|apks\.zip|apk\.zip)$/i;
let apkQueue = [];        // [{path, name, meta:{icon,label,package,versionName,size}, status, msg}]
let apkInstalling = false;
function renderApkTargets() {
  const sel = $('#apk-target');
  const online = onlineDevices();
  sel.innerHTML = online.length
    ? online.map(d => `<option value="${esc(d.serial)}">${esc(d.model || d.serial)}${isUsb(d.serial) ? ' [USB]' : ''}</option>`).join('')
    : '<option value="">Нет подключённых устройств</option>';
  if (activeSerial && online.some(d => d.serial === activeSerial)) sel.value = activeSerial;
  // мини-окно установки — тот же список
  const sel2 = $('#apkmini-target');
  sel2.innerHTML = sel.innerHTML;
  if (activeSerial && online.some(d => d.serial === activeSerial)) sel2.value = activeSerial;
}
function apkQRender() {
  const box = $('#apk2-list');
  // v2.8.0: зона перетаскивания СЖИМАЕТСЯ, когда в списке уже есть файлы — раньше она
  // оставалась «в полэкрана» и один файл с большой иконкой выглядел как сломанная вёрстка
  const dz = $('#apk2-drop');
  if (dz) {
    dz.classList.toggle('compact', apkQueue.length > 0);
    dz.innerHTML = apkQueue.length
      ? 'Можно добавить ещё: перетащите файлы сюда или <button class="btn btn-text btn-sm" id="btn-apk2-pick2">выберите…</button>'
      : 'Перетащите APK / XAPK / APKS / APKM / OBB сюда<br><span class="muted small">или</span><br><button class="btn btn-tonal" id="btn-apk2-pick" style="margin-top:8px">Выбрать файлы…</button>';
    const pk2 = document.getElementById('btn-apk2-pick2');
    if (pk2) pk2.onclick = apkPickFiles;
    const pk1 = document.getElementById('btn-apk2-pick');
    if (pk1) pk1.onclick = apkPickFiles;   // v2.8.0: кнопка пересоздаётся вместе с dropzone — перепривязываем каждый раз
  }
  box.innerHTML = apkQueue.map((f, i) => {
    const st = f.status === 'ok' ? '<span class="st-chip st-active apkq-status">✓ установлено</span>'
      : f.status === 'fail' ? '<span class="st-chip st-off apkq-status st-fail" data-tip="' + esc(f.msg || '') + '">✗ ошибка</span>'
      : f.status === 'run' ? '<span class="st-chip st-online apkq-status">устанавливаю…</span>'
      : '<span class="st-chip st-off apkq-status">в очереди</span>';
    const m = f.meta || {};
    const sub = [m.versionName ? 'v' + m.versionName : null, m.package, m.size ? fmtBytesLong(m.size) : null].filter(Boolean).join(' · ');
    return `<div class="list-row apkq-row">
      <img class="apkq-ico" src="${m.icon || (window.FSICONS.iconFor(f.name, false).src)}" alt="">
      <span class="apkq-main"><span class="apkq-name">${esc(m.label || f.name)}</span><span class="apkq-sub">${esc(sub || f.name)}</span></span>
      ${st}
      ${apkInstalling ? '' : '<button class="btn btn-text btn-sm" data-apkqdel="' + i + '" data-tip="Убрать из списка">✕</button>'}
      ${f.msg ? '<div class="apkq-msg">' + esc(f.msg) + '</div>' : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-apkqdel]').forEach(b => b.onclick = () => { apkQueue.splice(+b.dataset.apkqdel, 1); apkQRender(); });
  $('#btn-apk2-installall').disabled = !apkQueue.length || !$('#apk-target').value || apkInstalling;
  $('#apk2-summary').textContent = apkQueue.length
    ? 'В очереди: ' + apkQueue.length + ' · ' + fmtBytesLong(apkQueue.reduce((a, f) => a + ((f.meta && f.meta.size) || 0), 0))
    : 'Список пуст — добавьте файлы, и я покажу имена, иконки, версии и пакеты.';
}
async function apkAddFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (!APKQ_EXTS.test(p)) continue;
    if (apkQueue.some(f => f.path === p)) continue;
    const item = { path: p, name: p.split(/[\\/]/).pop(), meta: null, status: 'wait', msg: '' };
    apkQueue.push(item); added++;
    apkQRender();
    const m = await window.api.apkLocalMeta(p);
    if (m && m.ok) {
      item.meta = { icon: m.icon, label: m.label, package: m.package, versionName: m.versionName, size: m.size };
      item.msg = (!m.icon && !m.label) ? 'иконку/имя извлечь не удалось — установится как есть' : '';
    } else {
      item.msg = (m && m.error) || 'не удалось разобрать APK';
      if (m && m.size) item.meta = { size: m.size };
    }
    apkQRender();
  }
  if (added) { snd.play('drop'); snack('Добавлено файлов: ' + added); }
  else snack('Подходящих файлов нет (нужны .apk/.apks/.xapk/.apkm/.obb/.aab)');
}
async function apkPickFiles() {
  const files = await window.api.pickFile({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Android пакеты', extensions: ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'] }] });
  if (files && files.length) apkAddFiles(files);
}
// v2.8.0: стартовая привязка для СТАТИЧЕСКОЙ кнопки из разметки (apkQRender перепривяжет
// её при каждой перерисовке dropzone — кнопка пересоздаётся вместе с ней)
$('#btn-apk2-pick').onclick = apkPickFiles;
const apk2Drop = $('#apk2-drop');
apk2Drop.ondragover = e => { e.preventDefault(); apk2Drop.classList.add('over'); };
apk2Drop.ondragleave = () => apk2Drop.classList.remove('over');
apk2Drop.ondrop = async e => {
  e.preventDefault(); apk2Drop.classList.remove('over');
  const paths = [];
  for (const f of Array.from(e.dataTransfer.files || [])) {
    const p = await window.api.pathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) apkAddFiles(paths);
};
$('#btn-apk2-clear').onclick = () => { if (apkInstalling) return snack('Идёт установка — сначала прервите'); apkQueue = []; apkQRender(); };
$('#btn-apk-target-refresh').onclick = () => { refreshDevices().then(renderApkTargets); };
$('#btn-apk2-installall').onclick = async () => {
  const serial = $('#apk-target').value;
  if (!serial) return snack('Сначала подключите устройство и выберите его в списке');
  if (!apkQueue.length) return;
  const yes = await uiConfirm('Установка ' + apkQueue.length + ' файл(ов)', 'Установить на «' + nameOf(serial) + '»? Очередь пойдёт по порядку, по каждому файлу будет видно статус.');
  if (!yes || !yes.ok) return;
  apkInstalling = true;
  apkQueue.forEach(f => { f.status = 'wait'; f.msg = ''; });
  $('#btn-apk2-cancel').classList.remove('hidden');
  apkQRender();
  window.api.apkInstallBatch(serial, apkQueue.map(f => ({ path: f.path, meta: f.meta }))).then(r => {
    apkInstalling = false;
    $('#btn-apk2-cancel').classList.add('hidden');
    if (r && r.canceled) snack('Установка прервана');
    else if (r && r.ok) snack('Установлено: ' + r.installed + (r.failed ? ', ошибок: ' + r.failed : ''));
    else snack('Установка не удалась' + (r && r.error ? ': ' + r.error : ''));
    apkQRender();
  });
};
$('#btn-apk2-cancel').onclick = () => window.api.apkInstallCancel();

/* ---------- v2.6: мини-окно установки (двойной клик по файлу при ассоциации) ---------- */
let apkMiniBusy = false;
async function openApkMini(filePath) {
  goPage('apk');
  openDlg('dlg-apkmini');
  renderApkTargets();
  $('#apkmini-file').textContent = filePath;
  $('#apkmini-body').innerHTML = '<div>Читаю файл…</div>';
  $('#apkmini-icon').src = '';
  $('#apkmini-install').disabled = true;
  const m = await window.api.apkLocalMeta(filePath);
  if (!m || !m.ok) {
    $('#apkmini-body').innerHTML = '<div>Не удалось прочитать файл: ' + esc((m && m.error) || 'ошибка') + '</div>';
    return;
  }
  $('#apkmini-title').textContent = m.label || filePath.split(/[\\/]/).pop();
  if (m.icon) $('#apkmini-icon').src = m.icon;
  $('#apkmini-body').innerHTML = [
    ['Версия', m.versionName || '—'],
    ['Пакет', m.package || '—'],
    ['Размер', m.size ? fmtBytesLong(m.size) : '—']
  ].map(r2 => '<div><b>' + esc(r2[0]) + ':</b> ' + esc(r2[1]) + '</div>').join('') +
    '<div class="muted" style="margin-top:6px">Выберите устройство и нажмите «Установить».</div>';
  $('#apkmini-install').disabled = !$('#apkmini-target').value;
  $('#apkmini-install').onclick = async () => {
    if (apkMiniBusy) return;
    const serial = $('#apkmini-target').value;
    if (!serial) return snack('Нет подключённых устройств — сначала подключите телефон');
    apkMiniBusy = true;
    $('#apkmini-install').disabled = true;
    $('#apkmini-install').textContent = 'Устанавливаю…';
    const r = await window.api.apkInstallBatch(serial, [{ path: filePath, meta: { package: m.package } }]);
    apkMiniBusy = false;
    $('#apkmini-install').disabled = false;
    $('#apkmini-install').textContent = 'Установить';
    if (r && r.ok && r.installed) { snack('Установлено: ' + (m.label || filePath)); closeDlg('dlg-apkmini'); }
    else snack('Не удалось установить: ' + ((r && r.error) || 'ошибка'));
  };
}

/* ---------- быстрые команды + опасные ---------- */
const DANGER = { reboot: 'Перезагрузка устройства', bootloader: 'Перезагрузка в bootloader', recovery: 'Перезагрузка в recovery' };
$$('.chip[data-cmd]').forEach(c => c.onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const cmd = c.dataset.cmd;
  const run = async () => {
    const r = await window.api.toolQuick(s, cmd);
    snack(r.ok ? 'Команда выполнена' : 'Ошибка: ' + (r.message || r.error || ''));
  };
  if (DANGER[cmd]) {
    const yes = await uiConfirm(DANGER[cmd], 'Выполнить «' + DANGER[cmd] + '» для ' + s + '?');
    if (yes) run();
  } else run();
});

$('#btn-diag').onclick = async () => {
  const s = currentSerial();
  $('#diag-report').innerHTML = '<div class="muted">Выполняется…</div>';
  const rep = await window.api.toolDiagnostics(s);
  // v2.7.1: КОМПАКТНО и без вылезания за экран: сетка в 2 колонки, каждая строка — отдельный
  // div с переносом длинных слов (в v2.7.0 <pre> не переносил длинные mDNS-имена — строка
  // уезжала за границу окна); рекомендации — обычным списком, тоже с переносом.
  // v2.7.0: три состояния — ок (зелёный), предупреждение (жёлтый), ошибка (красный)
  const ico = sec => sec.ok
    ? (sec.warn ? '<span class="d-warn">&#9888;</span>' : '<span class="d-ok">&#10004;</span>')
    : '<span class="d-err">&#10008;</span>';
  $('#diag-report').innerHTML =
    '<div class="diag-grid">' +
    rep.sections.map(sec => `<div class="diag-sec ${sec.ok ? (sec.warn ? 'is-warn' : 'is-ok') : 'is-err'}">` +
      `<b>${ico(sec)} ${esc(sec.title)}</b>` +
      `<div class="diag-lines">${sec.lines.map(l => '<div class="diag-line">' + esc(l) + '</div>').join('')}</div></div>`).join('') +
    '</div>' +
    (rep.suggestions.length ? `<div class="diag-sugg"><b>Рекомендации</b><ul class="diag-sugg-list">${rep.suggestions.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>` : '');
};

/* ---------- файловый менеджер: файлы видны СРАЗУ (R11); v2.5.0 — F4–F8 ---------- */
let fsDir = '/sdcard';
let fsHist = [];            // история переходов для кнопки «Назад» (F5)
let fsItems = [];           // кэш последнего списка — для просмотрщика/плеера/флешки
let fsFlash = null;         // v2.6: путь смонтированной OTG-флешки (/storage/XXXX-XXXX) или null
let fsCatKind = null;       // v2.8.0: категория «со всех папок» (photo/music/video/docs) или null
let fsCatItems = [];        // результаты категории (полные пути)
// v2.8.0: буфер обмена проводника — Копировать/Вырезать → Вставить в любую папку
// (в т.ч. с памяти телефона на флешку и обратно)
let fsClip = { paths: [], cut: false };
const FS_QUICK = [
  { label: 'Внутренняя память', dir: '/sdcard' },
  { label: 'Download', dir: '/sdcard/Download' },
  { label: 'DCIM', dir: '/sdcard/DCIM' },
  { label: 'Documents', dir: '/sdcard/Documents' },
  { label: 'Music', dir: '/sdcard/Music' },
  { label: 'Pictures', dir: '/sdcard/Pictures' },
  { label: 'Movies', dir: '/sdcard/Movies' }
];
// v2.6 (L2): та же нормализация, что в main.js — чтобы крошки/операции совпадали с реальностью
function fsNormalize(p) {
  let d = String(p == null ? '/' : p).trim();
  if (!d) d = '/';
  if (!d.startsWith('/')) d = '/' + d;
  d = d.replace(/\/{2,}/g, '/');
  d = d.replace(/\/+$/, '') || '/';
  d = d.replace(/^\/sdcard\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/emulated(?=\/|$)/, '/storage/emulated');
  d = d.replace(/^\/storage\/emulated\/0\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/storage\/emulated\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/0(?=\/|$)/, '/storage/emulated/0');
  return d || '/';
}
function renderFsQuick() {
  const box = $('#fs-quick');
  const catChips = [
    { kind: 'photo', label: 'Все фото', ico: '&#128444;' },
    { kind: 'music', label: 'Вся музыка', ico: '&#9835;' },
    { kind: 'video', label: 'Всё видео', ico: '&#127909;' },
    { kind: 'docs', label: 'Документы', ico: '&#128196;' }
  ];
  box.innerHTML = FS_QUICK.map(q => `<button class="chip${fsCatKind ? '' : (fsDir === q.dir ? ' view-chip active' : '')}" data-qdir="${esc(q.dir)}">${esc(q.label)}</button>`).join('') +
    catChips.map(c => `<button class="chip${fsCatKind === c.kind ? ' view-chip active' : ''}" data-qcat="${c.kind}" data-tip="Показать ${esc(c.label.toLowerCase())} СО ВСЕХ папок телефона">${c.ico} ${esc(c.label)}</button>`).join('');
  box.querySelectorAll('[data-qdir]').forEach(b => b.onclick = () => fsNavigate(b.dataset.qdir));
  box.querySelectorAll('[data-qcat]').forEach(b => b.onclick = () => fsNavigate('cat:' + b.dataset.qcat));
}
// v2.7.1: ОДНА кнопка «Вид» с выпадающим меню как в Проводнике Windows 11 — пункты + ползунок
// размера значков. ВАЖНО: в v2.7.0 здесь был crash-баг всего приложения: IIFE syncFsViewChips
// читала let fsView ДО его объявления (TDZ ReferenceError) — app.js умирал на этой строке,
// и ВСЁ, что объявлено ниже, оставалось неинициализированным: не работали файлы, приложения,
// ассоциации, плеер, половина кнопок. Теперь fsView объявлен ЗДЕСЬ, выше использования.
// v2.8.0: ползунок ПЛАВНЫЙ, как в Проводнике Windows: 0–34 — список, 35–67 — значки
// (ячейка растёт 76→130 px), 68–100 — огромные (130→250 px). Останавливаться можно на ЛЮБОЙ
// позиции — размер ячейки меняется непрерывно, а не тремя ступенями.
let fsView = 'list';
let fsSlider = 0;             // 0..100 — позиция ползунка
try { fsSlider = Math.max(0, Math.min(100, parseInt(localStorage.getItem('fs.slider') || '0', 10) || 0)); } catch (e) {}
fsView = fsSliderViewOf(fsSlider);
function fsSliderViewOf(v) { return v <= 34 ? 'list' : (v <= 67 ? 'icons' : 'xl'); }
function fsCellPxOf(v) {
  if (v <= 34) return 0;
  if (v <= 67) return Math.round(76 + (v - 35) / 32 * 54);   // 76..130
  return Math.round(130 + (v - 67) / 33 * 120);              // 130..250
}
const VIEW_NAMES = { list: 'Список', icons: 'Значки', xl: 'Огромные' };
function syncFsViewUI() {
  fsView = fsSliderViewOf(fsSlider);
  const name = $('#fs-view-name'); if (name) name.textContent = VIEW_NAMES[fsView];
  $$('#fs-view-menu .view-item').forEach(x => x.classList.toggle('active', x.dataset.view === fsView));
  const r = $('#fs-view-range'); if (r) r.value = String(fsSlider);
}
function setFsSlider(v) {
  fsSlider = Math.max(0, Math.min(100, v | 0));
  try { localStorage.setItem('fs.slider', String(fsSlider)); } catch (e) {}
  syncFsViewUI();
  fsRender();
}
setFsViewAnchors();
function setFsViewAnchors() {
  // пункты меню = якоря ползунка: Список=0, Значки=50, Огромные=100
  $$('#fs-view-menu .view-item').forEach(c => {
    c.onclick = () => { setFsSlider(c.dataset.view === 'list' ? 0 : c.dataset.view === 'icons' ? 50 : 100); $('#fs-view-menu').classList.add('hidden'); };
  });
}
syncFsViewUI();
$('#btn-fs-view').onclick = (e) => { e.stopPropagation(); $('#fs-view-menu').classList.toggle('hidden'); };
(function viewSlider() {
  const r = $('#fs-view-range');
  let deb = null;
  r.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => setFsSlider(+r.value), 60); });
})();
document.addEventListener('click', (e) => { const m = $('#fs-view-menu'); if (m && !e.target.closest('#fs-views')) m.classList.add('hidden'); });

// навигация С историей: кнопка «Назад» возвращает на предыдущую папку (F5)
// v2.8.0: 'cat:photo|music|video|docs' — виртуальная категория со ВСЕХ папок телефона
const CAT_TITLES = { photo: 'Все фото устройства', music: 'Вся музыка устройства', video: 'Всё видео устройства', docs: 'Все документы устройства' };
function fsNavigate(newDir, { back } = {}) {
  if (newDir && String(newDir).startsWith('cat:')) {
    const kind = String(newDir).slice(4);
    if (!CAT_TITLES[kind]) return;
    if (fsCatKind !== kind || fsDir) { if (fsDir || fsCatKind) fsHist.push(fsCatKind ? 'cat:' + fsCatKind : fsDir); }
    fsCatKind = kind;
    $('#btn-fs-back').disabled = !fsHist.length;
    renderFsQuick();
    fsRender();
    return;
  }
  if (back) {
    const prev = fsHist.pop();
    if (prev && String(prev).startsWith('cat:')) {
      fsCatKind = prev.slice(4); fsDir = '/sdcard';
    } else {
      fsCatKind = null;
      fsDir = fsNormalize(prev || '/sdcard');
    }
  } else {
    const target = fsNormalize(newDir || '/sdcard');
    if (target !== fsDir || fsCatKind) fsHist.push(fsCatKind ? 'cat:' + fsCatKind : fsDir);
    if (fsHist.length > 60) fsHist.shift();
    fsCatKind = null;
    fsDir = target;
  }
  $('#btn-fs-back').disabled = !fsHist.length;
  renderFsQuick();
  fsRender();
}

function fmtBytesLong(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' ГБ';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' КБ';
  return n + ' Б';
}

let fsSeq = 0; // защита от гонок: ответ устаревшего ls не должен перезаписать свежую папку
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|avif)$/i;
const VID_RE = /\.(mp4|mkv|webm|avi|mov|3gp|m4v|ts)$/i;
const AUD_RE = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|wma)$/i;
// v2.7.0: категории для новых просмотрщиков/действий
const TXT_RE = /\.(txt|log|md|xml|json|js|css|htm|html|ini|conf|cfg|csv|nfo|srt|ass|ssa|lua|py|sh|bat|java|c|cpp|h|hpp|cs|yml|yaml|toml|properties|prop|rc|gitignore|sql|reg|vtt)$/i;
const PDF_RE = /\.pdf$/i;
const HTML_RE = /\.(html?|xhtml)$/i;
const ARC_RE = /\.(zip|jar|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|rar|7z)$/i;
const APK_RE = /\.(apk|apks|xapk|apkm)$/i;
const DOCX_RE = /\.docx$/i;   // v2.8.0: просмотр DOCX внутри программы
const VCF_RE = /\.vcf$/i;     // v2.8.0: просмотр контактов vCard
// v2.7.1: fsView объявлен и инициализирован ВЫШЕ (блок кнопки «Вид») — здесь больше не дублируется
const thumbCache = new Map();     // путь → dataURL (миниатюры фото в режиме значков)
const thumbFail = new Set();
let thumbQueue = [], thumbRun = 0;
const THUMB_CONC = 2;
function queueThumbs(cells) { thumbQueue.push(...cells); pumpThumbs(); }
function pumpThumbs() {
  while (thumbRun < THUMB_CONC) {
    const job = thumbQueue.shift();
    if (!job) return;
    thumbRun++;
    loadThumb(job).finally(() => { thumbRun--; pumpThumbs(); });
  }
}
async function loadThumb(job) {
  const { path: p, el } = job;
  if (thumbCache.has(p)) { if (el && el.isConnected) el.src = thumbCache.get(p); return; }
  if (thumbFail.has(p)) return;
  const s = currentSerial(); if (!s) return;
  try {
    const r = await window.api.fsCat(s, p, 12);
    // v2.7.1: элемент мог уйти (переход в другую папку) — чужой src не трогаем
    if (!el || !el.isConnected || el.dataset.path !== p) return;
    if (!r.ok || !r.buf || !r.buf.length) { thumbFail.add(p); return; }
    const blob = new Blob([r.buf], { type: /jpe?g$/i.test(p) ? 'image/jpeg' : /png$/i.test(p) ? 'image/png' : /gif$/i.test(p) ? 'image/gif' : /webp$/i.test(p) ? 'image/webp' : /bmp$/i.test(p) ? 'image/bmp' : 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    await new Promise((res, rej) => { el.onload = res; el.onerror = rej; el.src = url; });
    thumbCache.set(p, el.src);
  } catch (e) { thumbFail.add(p); }
}
// отложенные иконки APK-файлов с телефона (родная иконка приложения) — очередь на 1 поток
const fsApkIconDone = new Set();
let fsApkQueue = [], fsApkRun = 0;
function queueFsApkIcons(jobs) { fsApkQueue.push(...jobs); pumpFsApkIcons(); }
function pumpFsApkIcons() {
  while (fsApkRun < 1) {
    const job = fsApkQueue.shift();
    if (!job) return;
    if (fsApkIconDone.has(job.path)) continue;
    fsApkRun++;
    (async () => {
      const s = currentSerial(); if (!s) return;
      const r = await window.api.apkRemoteMeta(s, job.path).catch(() => null);
      fsApkIconDone.add(job.path);
      // v2.7.1: защита от «переехавшей» папки: обновляем элемент ТОЛЬКО если это тот же файл
      const img = document.getElementById(job.id);
      if (r && r.ok && r.dataUrl && img && img.dataset.path === job.path && img.isConnected) {
        img.src = r.dataUrl; const b = document.getElementById(job.id + '-badge'); if (b) b.style.display = 'block';
        if (r.label) { const t = document.getElementById(job.id + '-name'); if (t && t.dataset.path === job.path) t.textContent = r.label + ' (' + job.name + ')'; }
      }
    })().finally(() => { fsApkRun--; pumpFsApkIcons(); });
  }
}
function fsBadgeHtml(isApk) {
  return isApk ? '<img class="android-badge" src="' + window.FSICONS.ANDROID_BADGE + '" data-tip="Приложение Android — иконка подгружается из APK" alt="">'
    : '';
}
async function fsRender() {
  const seq = ++fsSeq;
  // v2.7.1: сбрасываем очереди миниатюр/иконок ПРОШЛОЙ папки — иначе догоняющие задачи
  // занимали канал и (для APK-иконок, поиск по индексному id) рисовали иконки/имена
  // из ПРЕДЫДУЩЕЙ папки в текущей («перешёл в другую папку — а там как было»)
  thumbQueue.length = 0;
  fsApkQueue.length = 0;
  const s = currentSerial();
  const box = $('#fs-list');
  const empty = $('#fs-empty');
  // v2.8.0: РЕЖИМ КАТЕГОРИИ — «Все фото / Вся музыка / Всё видео / Документы» со ВСЕХ папок
  if (fsCatKind) {
    $('#fs-path').value = CAT_TITLES[fsCatKind] || fsCatKind;
    $('#fs-crumb').textContent = CAT_TITLES[fsCatKind] + ' (виртуальная папка — файлы лежат по своим местам)';
    if (!s) { box.innerHTML = ''; box.classList.add('hidden'); empty.classList.remove('hidden'); return; }
    if (seq !== fsSeq) return;
    empty.classList.add('hidden');
    box.classList.remove('hidden');
    box.classList.remove('fs-grid', 'fs-xl');
    box.innerHTML = '<div class="empty">Ищу файлы по всему телефону… (до 15 секунд)</div>';
    const r = await window.api.fsSearch(s, fsCatKind, ['/sdcard']).catch(() => null);
    if (seq !== fsSeq) return;
    fsCatItems = (r && r.items) || [];
    fsItems = fsCatItems;
    const q2 = ($('#fs-filter').value || '').toLowerCase();
    let items2 = fsCatItems;
    if (q2) items2 = items2.filter(it => it.name.toLowerCase().includes(q2));
    if (!items2.length) {
      box.innerHTML = '<div class="empty">Файлов этой категории не найдено на внутренней памяти</div>';
      return;
    }
    // сортировка по имени; клик открывает просмотрщик по ПОЛНОМУ пути
    items2 = items2.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    box.innerHTML = items2.map((it, i) => `<div class="list-row fs-row" data-fs-i="${i}">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor(it.name, false).src}" alt=""></span>
      <span class="mono grow2 fs-name" data-fscat="${esc(it.path)}" style="cursor:pointer" data-tip="${esc(it.path)}">${esc(it.name)}</span>
      <span class="muted small" style="max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.path.replace(/^\/sdcard\/?/, ''))}</span>
      <button class="btn btn-text btn-sm" data-fsgetp="${esc(it.path)}" data-tip="Скачать файл с телефона">Скачать</button>
      <button class="btn btn-text btn-sm" data-fspropp="${esc(it.path)}" data-isdir="0" data-tip="Свойства">Свойства</button>
    </div>`).join('');
    box.querySelectorAll('[data-fscat]').forEach(el => el.onclick = () => {
      const p = el.dataset.fscat; const nm = p.split('/').pop();
      const fake = { name: nm, dir: false, path: p };
      if (IMG_RE.test(nm)) openImgViewer(p);
      else if (VID_RE.test(nm) || AUD_RE.test(nm)) openMediaPlayer(p);
      else openTextViewer(p);
      void fake;
    });
    box.querySelectorAll('[data-fsgetp]').forEach(b => b.onclick = async () => {
      snack('Скачиваю ' + b.dataset.fsgetp.split('/').pop() + '…');
      const res = await window.api.fsPull(s, b.dataset.fsgetp);
      if (res.ok) snack('Сохранено: ' + res.file);
    });
    box.querySelectorAll('[data-fspropp]').forEach(b => b.onclick = () => {
      const p = b.dataset.fspropp; const nm = p.split('/').pop();
      openFsProps({ name: nm, dir: false, path: p });
    });
    return;
  }
  $('#fs-path').value = fsDir;
  $('#fs-crumb').textContent = fsDir;
  if (!s) {
    if (seq !== fsSeq) return;
    box.innerHTML = '';
    box.classList.add('hidden');
    empty.classList.remove('hidden');
    $('#fs-empty-title').textContent = 'Файлы появятся здесь сразу после подключения';
    $('#fs-empty-text').textContent = 'Подключите телефон на странице «Подключение» — список откроется сам, нажимать ничего не нужно.';
    return;
  }
  if (seq !== fsSeq) return;
  empty.classList.add('hidden');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty">Загружаю список файлов…</div>';
  const r = await window.api.fsList(s, fsDir);
  if (seq !== fsSeq) return; // пока грузили — пользователь уже ушёл в другую папку
  // v2.6 (L2): main нормализует путь (/sdcard/emulated/0 → /storage/emulated/0 и т.п.) —
  // синхронизируем, чтобы крошки и операции работали по настоящему пути
  if (r.path && r.path !== fsDir) { fsDir = r.path; $('#fs-path').value = fsDir; $('#fs-crumb').textContent = fsDir; }
  if (!r.ok) {
    box.innerHTML = '<div class="empty">Не удалось открыть папку: ' + esc(r.error || '') + '</div>';
    try { window.api.uiLog('fs:list ' + fsDir + ' → ' + (r.error || 'ошибка')); } catch (e) {}
    return;
  }
  fsItems = r.items || [];
  const q = ($('#fs-filter').value || '').toLowerCase();
  let items = fsItems;
  if (q) items = items.filter(it => it.name.toLowerCase().includes(q));
  // v2.6: контекст флешки — кнопки «на флешку/на телефон» видны ТОЛЬКО когда флешка вставлена
  const onFlash = !!(fsFlash && fsDir.startsWith(fsFlash));
  const full = (name) => fsDir.replace(/\/+$/, '') + '/' + name;
  const flashBtns = (name) => fsFlash ? (
    onFlash
      ? `<button class="btn btn-text btn-sm" data-fs2phone="${esc(name)}" data-tip="Скопировать на телефон в /sdcard/Download">На телефон</button>
         <button class="btn btn-text btn-sm" data-fs2phonemv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на телефон в /sdcard/Download">На телефон ✂</button>`
      : `<button class="btn btn-text btn-sm" data-fs2flash="${esc(name)}" data-tip="Скопировать на флешку (${esc(fsFlash)})">На флешку</button>
         <button class="btn btn-text btn-sm" data-fs2flashmv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на флешку (${esc(fsFlash)})">На флешку ✂</button>`
  ) : '';

  const bindCommon = (root) => {
    const byIdx = i => items[i];
    const openItem = (it) => {
      if (it.dir) return fsNavigate(fsDir.replace(/\/+$/, '') + '/' + it.name);
      const fp = full(it.name);
      if (IMG_RE.test(it.name)) openImgViewer(fp);
      else if (VID_RE.test(it.name) || AUD_RE.test(it.name)) openMediaPlayer(fp);
      else if (TXT_RE.test(it.name) || PDF_RE.test(it.name)) openTextViewer(fp);
      else if (HTML_RE.test(it.name)) openTextViewer(fp); // v2.7.2: HTML — встроенный просмотр (Превью/Код), «Открыть на ПК» внутри
      else openFsProps(it);
    };
    root.querySelectorAll('[data-fsopen]').forEach(el => el.onclick = () => openItem(byIdx(+el.dataset.fsI)));
    root.querySelectorAll('[data-fsopen-i]').forEach(el => el.onclick = () => openItem(byIdx(+el.dataset.fsopenI)));
    root.querySelectorAll('[data-fsprop]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openFsProps(byIdx(+(b.closest('[data-fs-i]') || b.closest('.fs-row')).querySelector('[data-fs-i]').dataset.fsI)); });
    root.querySelectorAll('[data-fsget]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      snack('Скачиваю ' + b.dataset.fsget + '…');
      const res = await window.api.fsPull(s, full(b.dataset.fsget));
      if (res.ok) snack('Сохранено: ' + res.file);
    });
    const doTransfer = async (name, mv, dstDirOverride) => {
      const src = full(name);
      const dstDir = dstDirOverride || (onFlash ? '/sdcard/Download' : (() => {
        const rel = fsDir === fsFlash ? '' : fsDir.slice(fsFlash.length).replace(/^\/+/, '');
        return fsFlash + (rel ? '/' + rel : '');
      })());
      const verb = mv ? 'Перемещаю' : 'Копирую';
      snack(verb + ' ' + name + ' → ' + dstDir + '…');
      await window.api.fsCmd(s, ['mkdir', '-p', dstDir]);
      // v2.8.0: mv между РАЗНЫМИ томами (память ⟷ флешка) даёт EXDEV — тогда копируем и удаляем источник
      let r2 = await window.api.fsCmd(s, [mv ? 'mv' : 'cp', '-rf', src, dstDir + '/']);
      if (!r2.ok && mv) {
        const rc = await window.api.fsCmd(s, ['cp', '-rf', src, dstDir + '/']);
        if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', src]); r2 = { ok: true }; }
        else r2 = rc;
      }
      if (r2.ok) snack((mv ? 'Перемещено: ' : 'Скопировано: ') + name + ' → ' + dstDir);
      else snack('Не удалось: ' + ((r2.stderr || r2.stdout || 'ошибка').slice(0, 120)));
      fsRender();
    };
    root.querySelectorAll('[data-fs2flash]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2flash, false); });
    root.querySelectorAll('[data-fs2flashmv]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2flashmv, true); });
    root.querySelectorAll('[data-fs2phone]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2phone, false); });
    root.querySelectorAll('[data-fs2phonemv]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2phonemv, true); });
    // v2.8.0: ПРАВАЯ КНОПКА — контекстное меню (Открыть/Копировать/Вырезать/Переименовать/
    // Скачать/В архив/Свойства/Удалить) для файлов И папок
    root.querySelectorAll('.fs-row[data-fs-i], .fs-cell[data-fs-i]').forEach(rowEl => {
      rowEl.oncontextmenu = (e) => {
        const it = byIdx(+(rowEl.dataset.fsI));
        if (!it) return;
        e.preventDefault(); e.stopPropagation();
        openFsContextMenu(e.clientX, e.clientY, it, {
          path: it.path || full(it.name),
          open: () => openItem(it),
          props: () => openFsProps(it),
          download: it.dir ? null : () => window.api.fsPull(s, it.path || full(it.name)).then(res => { if (res.ok) snack('Сохранено: ' + res.file); }),
          refresh: fsRender
        });
      };
    });
    root.querySelectorAll('[data-fsdel]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      const yes = await uiConfirm('Удаление', 'Удалить ' + b.dataset.fsdel + ' с устройства? (папки — с содержимым)');
      if (!yes || !yes.ok) return;
      await window.api.fsCmd(s, ['rm', '-rf', full(b.dataset.fsdel)]);
      fsRender(); snack('Удалено');
    });
  };

  const thumbJobs = [], apkJobs = [];
  if (fsView === 'list') {
    box.classList.remove('fs-grid', 'fs-xl');
    box.innerHTML = items.map((it, i) => {
      const ic = window.FSICONS.iconFor(it.name, it.dir);
      const isApk = !it.dir && APK_RE.test(it.name);
      const media = !it.dir && (IMG_RE.test(it.name) || VID_RE.test(it.name) || AUD_RE.test(it.name));
      if (isApk) apkJobs.push({ path: full(it.name), name: it.name, id: 'fsapk-' + i });
      return `<div class="list-row fs-row" data-fs-i="${i}">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${ic.src}" alt="" data-fsopen-i="${i}" id="fsapk-${i}" data-path="${esc(full(it.name))}">${fsBadgeHtml(isApk)}</span>
      <span class="mono grow2 fs-name" data-fsopen="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-fs-i="${i}" style="cursor:pointer" id="fsapk-${i}-name" data-path="${esc(full(it.name))}" data-tip="${it.dir ? 'Открыть папку' : (media ? 'Открыть в просмотрщике/плеере' : 'Двойной клик — свойства')}">${esc(it.name)}</span>
      <span class="muted fs-size">${it.dir ? '' : fmtBytes(it.size)}</span>
      <span class="muted fs-date">${esc(it.date || '')}</span>
      <button class="btn btn-text btn-sm" data-fsprop="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-tip="Свойства: размер, дата, права доступа, содержимое">Свойства</button>
      ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsget="' + esc(it.name) + '" data-tip="Скачать файл с телефона на компьютер">Скачать</button>'}
      ${flashBtns(it.name)}
      <button class="btn btn-text btn-sm" data-fsdel="${esc(it.name)}" data-tip="Удалить с телефона (папки — с содержимым)">Удалить</button>
    </div>`;
    }).join('') || '<div class="empty">Папка пуста</div>';
  } else {
    // v2.7.0: значки / огромные значки — сетка как в Проводнике
    // v2.8.0: размер ячейки ПЛАВНЫЙ (ползунок 35–100 → 76..250 px), как в Windows
    const cellPx = fsCellPxOf(fsSlider) || 110;
    const xl = fsView === 'xl';
    const bigEnoughForThumbs = cellPx >= 120;
    box.classList.add('fs-grid'); box.classList.toggle('fs-xl', xl);
    box.style.setProperty('--fs-cell', cellPx + 'px');
    box.innerHTML = items.map((it, i) => {
      const ic = window.FSICONS.iconFor(it.name, it.dir);
      const isApk = !it.dir && APK_RE.test(it.name);
      const isImg = !it.dir && IMG_RE.test(it.name);
      const isVid = !it.dir && VID_RE.test(it.name);
      const id = bigEnoughForThumbs ? ('fscell-' + i) : ('fscell-s-' + i);
      if (isImg && bigEnoughForThumbs && it.size < 25 * 1024 * 1024) thumbJobs.push({ path: full(it.name), el: null, id });
      if (isApk) apkJobs.push({ path: full(it.name), name: it.name, id });
      return `<div class="fs-cell" data-fsopen="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-fs-i="${i}" data-tip="${it.dir ? 'Открыть папку (правая кнопка — меню)' : 'Клик — открыть, правая кнопка — меню'}">
      ${isImg && bigEnoughForThumbs
        ? '<img class="fs-cell-ico" id="' + id + '" src="' + ic.src + '" alt="" data-path="' + esc(full(it.name)) + '">'
        : '<span style="position:relative;display:inline-block"><img class="fs-cell-ico" id="' + id + '" src="' + ic.src + '" alt="" data-path="' + esc(full(it.name)) + '">' + fsBadgeHtml(isApk) + '</span>'}
      <span class="fs-cell-name" id="${id}-name" data-path="${esc(full(it.name))}">${esc(it.name)}</span>
      <span class="fs-cell-sub">${it.dir ? 'папка' : fmtBytes(it.size) + (isVid ? ' · видео' : isApk ? ' · приложение' : '')}</span>
      <span class="fs-cell-actions">
        <button class="btn btn-text btn-sm" data-fsprop="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-tip="Свойства">ℹ</button>
        ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsget="' + esc(it.name) + '" data-tip="Скачать на компьютер">⭳</button>'}
        ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsdel="' + esc(it.name) + '" data-tip="Удалить">✕</button>'}
      </span>
    </div>`;
    }).join('') || '<div class="empty">Папка пуста</div>';
  }
  bindCommon(box);
  if (thumbJobs.length) {
    // миниатюры: подставляем реальные <img> после вставки разметки
    for (const j of thumbJobs) { const el = document.getElementById(j.id); if (el) { j.el = el; queueThumbs([j]); } }
  }
  if (apkJobs.length) {
    for (const j of apkJobs) { const el = document.getElementById(j.id); if (el && el.dataset.path === j.path) queueFsApkIcons([{ ...j, id: el.id }]); }
  }
}

/* ================= v2.8.0: КОНТЕКСТНОЕ МЕНЮ (правая кнопка) =================
   Для файлов и папок: Открыть · Скачать · Копировать · Вырезать · Переименовать ·
   В архив ZIP · Открыть архив (для архивов) · Свойства · Удалить. Закрытие — клик мимо/Esc. */
function closeFsCtx() { const m = $('#fs-ctx'); if (m) { m.classList.add('hidden'); m.innerHTML = ''; } }
document.addEventListener('click', closeFsCtx);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFsCtx(); });
window.addEventListener('blur', closeFsCtx);
function openFsContextMenu(x, y, it, act) {
  const m = $('#fs-ctx');
  const items = [];
  const isArc = !it.dir && ARC_RE.test(it.name);
  const isApk = !it.dir && APK_RE.test(it.name);
  const p = act.path;
  items.push({ t: it.dir ? '&#128449; Открыть папку' : '&#128196; Открыть', fn: act.open });
  if (isArc) items.push({ t: '&#128230; Открыть архив (не распаковывая)', fn: () => openArcViewer(p, it.name) });
  if (!it.dir && act.download) items.push({ t: '&#11015; Скачать на компьютер', fn: act.download });
  items.push({ sep: true });
  items.push({ t: '&#128203; Копировать', fn: () => { fsClip = { paths: [p], cut: false }; showFsClipbar(); snack('Скопировано в буфер: ' + it.name); } });
  items.push({ t: '&#9986; Вырезать', fn: () => { fsClip = { paths: [p], cut: true }; showFsClipbar(); snack('Вырезано: ' + it.name); } });
  items.push({ t: '&#128193; Переместить в…', fn: () => openFsMoveDialog([p], true, it.name) });
  if (!it.dir) items.push({ t: '&#128193; Копировать в…', fn: () => openFsMoveDialog([p], false, it.name) });
  items.push({ t: '&#9998; Переименовать', fn: () => fsRename(p, it.name) });
  items.push({ sep: true });
  items.push({ t: '&#128230; Добавить в архив ZIP', fn: () => fsZipItems([p], it.name) });
  items.push({ t: '&#9432; Свойства', fn: act.props });
  items.push({ sep: true });
  items.push({ t: '&#10060; Удалить', danger: true, fn: async () => {
    const yes = await uiConfirm('Удаление', 'Удалить ' + it.name + (it.dir ? ' (папка — с содержимым)' : '') + ' с устройства?');
    if (!yes || !yes.ok) return;
    await window.api.fsCmd(currentSerial(), ['rm', '-rf', p]);
    snack('Удалено: ' + it.name);
    (act.refresh || fsRender)();
  } });
  m.innerHTML = items.map((x, i) => x.sep ? '<div class="fs-ctx-sep"></div>' :
    `<button class="fs-ctx-item${x.danger ? ' danger' : ''}" data-i="${i}">${x.t}</button>`).join('');
  m.querySelectorAll('.fs-ctx-item').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    closeFsCtx();
    const fn = items[+b.dataset.i].fn;
    if (fn) fn();
  });
  m.classList.remove('hidden');
  const w = m.offsetWidth || 240, h = m.offsetHeight || 200;
  m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  m.style.zIndex = '500';
}
/* ---------- буфер обмена проводника: панель + вставка (в любую папку, любой том) ---------- */
function showFsClipbar() {
  const bar = $('#fs-clipbar');
  if (!fsClip.paths.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const names = fsClip.paths.map(p => p.split('/').pop());
  const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' + ещё ' + (names.length - 3) : names.join(', ');
  $('#fs-cliptext').textContent = (fsClip.cut ? 'Вырезано: ' : 'Скопировано: ') + shown + ' → вставьте в нужной папке';
}
async function fsPasteInto(dstDir) {
  const s = currentSerial(); if (!s || !fsClip.paths.length) return;
  snack((fsClip.cut ? 'Перемещаю ' : 'Копирую ') + fsClip.paths.length + ' объект(ов) → ' + dstDir + '…');
  await window.api.fsCmd(s, ['mkdir', '-p', dstDir]);
  let okN = 0;
  for (const p of fsClip.paths) {
    const name = p.split('/').filter(Boolean).pop() || 'file';
    let dest = dstDir.replace(/\/+$/, '') + '/' + name;
    if (p.replace(/\/+$/, '') === dest) dest = dstDir.replace(/\/+$/, '') + '/копия_' + name; // вставка в ту же папку
    let r = await window.api.fsCmd(s, [fsClip.cut ? 'mv' : 'cp', '-rf', p, dest]);
    if (!r.ok && fsClip.cut) {
      const rc = await window.api.fsCmd(s, ['cp', '-rf', p, dest]);
      if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', p]); r = { ok: true }; }
    }
    if (r.ok) okN++;
    else snack('Не удалось: ' + name + ' — ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 100)));
  }
  if (fsClip.cut && okN === fsClip.paths.length) fsClip = { paths: [], cut: false };
  showFsClipbar();
  snack('Готово: ' + okN + ' из ' + fsClip.paths.length);
  fsRender();
}
async function fsRename(p, oldName) {
  const s = currentSerial(); if (!s) return;
  const newName = await askText('Переименовать', 'Новое имя:', oldName);
  if (!newName || newName === oldName) return;
  if (/[\/\\]/.test(newName)) return snack('Имя не может содержать / или \\');
  const parent = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  const r = await window.api.fsCmd(s, ['mv', p, (parent === '/' ? '' : parent) + '/' + newName]);
  if (r.ok) { snack('Переименовано: ' + oldName + ' → ' + newName); fsRender(); }
  else snack('Не удалось переименовать: ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 120)));
}
async function fsZipItems(paths, firstName) {
  const s = currentSerial(); if (!s) return;
  const base = (firstName || 'архив').replace(/\.[a-z0-9]+$/i, '');
  let dest = (fsCatKind ? '/sdcard' : fsDir).replace(/\/+$/, '') + '/' + base + '.zip';
  const ex = await window.api.fsStat(s, dest);
  if (ex && ex.ok) dest = dest.replace(/\.zip$/, '') + '-' + Date.now().toString(36).slice(-4) + '.zip';
  snack('Собираю ZIP: ' + dest.split('/').pop() + '…');
  const r = await window.api.fsZipCreate(s, paths, dest);
  if (r.ok) { snack('Архив создан: ' + r.dest + ' (' + r.files + ' файлов, ' + fmtBytesLong(r.bytes) + ')'); fsRender(); }
  else snack('Не удалось собрать архив: ' + (r.error || ''), 6000);
}
$('#btn-fs-mkdir').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const name = await askText('Новая папка', 'Имя новой папки:', '');
  if (!name) return;
  await window.api.fsCmd(s, ['mkdir', '-p', fsDir.replace(/\/+$/, '') + '/' + name]);
  fsRender();
};
$('#btn-fs-newfile').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const name = await askText('Новый файл', 'Имя файла (например заметка.txt):', 'новый.txt');
  if (!name) return;
  if (/[\/\\]/.test(name)) return snack('Имя не может содержать / или \\');
  const target = (fsCatKind ? '/sdcard' : fsDir).replace(/\/+$/, '') + '/' + name;
  const r = await window.api.fsCmd(s, ['sh', '-c', 'touch ' + adbShqSafe(target)]);
  if (r.ok) { snack('Создан файл: ' + name); fsRender(); }
  else snack('Не удалось создать: ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 120)));
};
function adbShqSafe(p) {
  if (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(p)) return p;
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}
$('#btn-fs-paste').onclick = () => fsPasteInto(fsCatKind ? '/sdcard' : fsDir);
$('#btn-fs-clipcancel').onclick = () => { fsClip = { paths: [], cut: false }; showFsClipbar(); };

/* ================= v2.8.0: «Переместить в… / Копировать в…» — выбор папки назначения ======= */
const fsm = { paths: [], move: true, dir: '/sdcard', resolve: null };
function fsmRenderList() {
  const box = $('#fsm-list');
  box.innerHTML = '<div class="empty">Читаю папки…</div>';
  window.api.fsList(currentSerial(), fsm.dir).then(r => {
    if (!r.ok) { box.innerHTML = '<div class="empty">Не удалось открыть: ' + esc(r.error || '') + '</div>'; return; }
    const dirs = (r.items || []).filter(x => x.dir);
    $('#fsm-path').value = fsm.dir;
    box.innerHTML = dirs.map(d => `<div class="list-row" data-fsmd="${esc(d.name)}">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor('', true).src}" alt=""></span>
      <span class="grow2">${esc(d.name)}</span><span class="muted small">открыть</span></div>`).join('') || '<div class="empty">Вложенных папок нет</div>';
    box.querySelectorAll('[data-fsmd]').forEach(el => el.onclick = () => {
      fsm.dir = fsm.dir.replace(/\/+$/, '') + '/' + el.dataset.fsmd;
      fsmRenderList();
    });
  });
}
function openFsMoveDialog(paths, move, firstName) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  fsm.paths = paths; fsm.move = !!move;
  fsm.dir = fsCatKind ? '/sdcard' : (fsFlash && (fsDir + '/').startsWith(fsFlash) ? fsFlash : '/sdcard');
  $('#fsm-title').textContent = move ? 'Переместить в…' : 'Копировать в…';
  $('#fsm-sub').textContent = (move ? 'Переместить' : 'Скопировать') + ' «' + (firstName || paths[0].split('/').pop()) + '» в выбранную папку. Папку можно открыть на любом томе (память/флешка).';
  openDlg('dlg-fsmove');
  fsmRenderList();
}
$('#btn-fsm-up').onclick = () => { const p = fsm.dir.replace(/\/+$/, '').split('/'); p.pop(); fsm.dir = p.join('/') || '/'; fsmRenderList(); };
$('#btn-fsm-refresh').onclick = fsmRenderList;
$('#fsm-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { fsm.dir = fsNormalize($('#fsm-path').value.trim() || '/sdcard'); fsmRenderList(); } });
$('#btn-fsm-ok').onclick = async () => {
  const dest = fsNormalize($('#fsm-path').value.trim() || fsm.dir);
  closeDlg('dlg-fsmove');
  if (fsm.resolve) { const fn = fsm.resolve; fsm.resolve = null; fn(dest); return; }
  const s = currentSerial();
  snack((fsm.move ? 'Перемещаю ' : 'Копирую ') + fsm.paths.length + ' объект(ов) → ' + dest + '…');
  await window.api.fsCmd(s, ['mkdir', '-p', dest]);
  for (const p of fsm.paths) {
    const name = p.split('/').filter(Boolean).pop();
    let r = await window.api.fsCmd(s, [fsm.move ? 'mv' : 'cp', '-rf', p, dest + '/' + name]);
    if (!r.ok && fsm.move) {
      const rc = await window.api.fsCmd(s, ['cp', '-rf', p, dest + '/' + name]);
      if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', p]); r = { ok: true }; }
    }
    if (!r.ok) snack('Не удалось: ' + name + ' — ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 100)));
  }
  snack('Готово → ' + dest);
  fsRender();
};

/* ================= v2.8.0: ПРОСМОТР АРХИВА БЕЗ РАСПАКОВКИ (как в Проводнике) ============== */
const arc = { path: null, name: '', entries: [] };
async function openArcViewer(archivePath, arcName) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  arc.path = archivePath; arc.name = arcName || archivePath.split('/').pop();
  $('#arc-title').textContent = arc.name;
  $('#arc-info').textContent = 'Читаю содержимое…';
  $('#arc-list').innerHTML = '<div class="empty">Скачиваю архив и читаю оглавление…</div>';
  openDlg('dlg-arcview');
  const r = await window.api.fsZipList(s, archivePath);
  if (!r.ok) { $('#arc-list').innerHTML = '<div class="empty">' + esc(r.error || 'не удалось прочитать архив') + '</div>'; return; }
  arc.entries = r.entries || [];
  const files = arc.entries.filter(e => !e.dir);
  $('#arc-info').textContent = 'файлов: ' + files.length + (r.size ? ' · ' + fmtBytesLong(r.size) : '');
  arcRenderList();
}
function arcRenderList() {
  const box = $('#arc-list');
  const q = ($('#arc-filter').value || '').toLowerCase();
  let list = arc.entries;
  if (q) list = list.filter(e => e.name.toLowerCase().includes(q));
  // v2.8.0-fix: индексы — ТОЛЬКО глобальные (arc.entries.indexOf), иначе при активном
  // фильтре «Посмотреть/Скачать/Извлечь» указывали на чужие файлы
  box.innerHTML = list.map(e => {
    const gi = arc.entries.indexOf(e);
    return `<div class="list-row" data-arci="${gi}">
      <input type="checkbox" data-arcsel="${gi}" ${e.dir ? 'disabled' : ''}>
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor(e.dir ? '' : e.name.split('/').pop(), e.dir).src}" alt=""></span>
      <span class="mono grow2" style="cursor:pointer">${esc(e.name)}</span>
      <span class="muted small">${e.dir ? 'папка' : fmtBytesLong(e.usize || 0)}</span>
      ${e.dir ? '' : '<button class="btn btn-text btn-sm" data-arcview="' + gi + '" data-tip="Посмотреть файл, не распаковывая архив">Посмотреть</button>'}
      ${e.dir ? '' : '<button class="btn btn-text btn-sm" data-arcsave="' + gi + '" data-tip="Сохранить файл на компьютер">Скачать</button>'}
    </div>`;
  }).join('') || '<div class="empty">В архиве нет файлов под фильтр</div>';
  box.querySelectorAll('.list-row .mono').forEach(el => el.ondblclick = () => {
    const row = el.closest('[data-arci]');
    const e = arc.entries[+row.dataset.arci];
    if (e && !e.dir) arcViewEntry(e);
  });
  box.querySelectorAll('[data-arcview]').forEach(b => b.onclick = () => arcViewEntry(arc.entries[+b.dataset.arcview]));
  box.querySelectorAll('[data-arcsave]').forEach(b => b.onclick = async () => {
    const e = arc.entries[+b.dataset.arcsave];
    const s = currentSerial();
    const r = await window.api.fsZipRead(s, arc.path, e.name);
    if (!r.ok) return snack(r.error || 'не удалось прочитать файл из архива');
    const sv = await window.api.pickSave({ defaultPath: e.name.split('/').pop() });
    if (!sv || sv.canceled) return;
    const wr = await window.api.fsTmpWrite(e.name.split('/').pop() + '.' + Date.now().toString(36), bytesToB64(new Uint8Array(r.buf)));
    if (!wr.ok) return snack('Не удалось подготовить файл: ' + (wr.error || ''));
    // fsTmpWrite пишет во временную папку — копируем в выбранное место через push-механику нет;
    // используем прямой путь: fsTmpWrite в tmp, затем показать в папке
    await window.api.shellOpenPath(wr.path);
    snack('Файл из архива: ' + wr.path);
  });
}
async function arcViewEntry(e) {
  const s = currentSerial();
  snack('Читаю из архива: ' + e.name.split('/').pop() + '…');
  const r = await window.api.fsZipRead(s, arc.path, e.name);
  if (!r.ok) return snack(r.error || 'не удалось прочитать файл из архива');
  const nm = e.name.split('/').pop();
  const wr = await window.api.fsTmpWrite('arcview-' + Date.now().toString(36) + '-' + nm, bytesToB64(new Uint8Array(r.buf)));
  if (!wr.ok) return snack('Не удалось подготовить просмотр: ' + (wr.error || ''));
  const op = await window.api.shellOpenPath(wr.path);
  if (!op.ok) snack('Системная программа не открыла файл: ' + (op.error || ''));
}
$('#arc-filter').addEventListener('input', arcRenderList);
$('#btn-arc-extract-all').onclick = async () => {
  closeDlg('dlg-arcview');
  const s = currentSerial();
  const b = { disabled: false };
  snack('Распаковываю ' + arc.name + '…');
  const r = await window.api.fsExtract(s, arc.path);
  if (r.ok) { snack('Распаковано (' + (r.where || 'на устройстве') + '): ' + r.files + ' файлов → ' + r.dest); fsNavigate(r.dest); }
  else snack(r.error || 'Не удалось распаковать', 6000);
};
$('#btn-arc-extract-sel').onclick = async () => {
  const sel = $$('#arc-list [data-arcsel]:checked').map(c => arc.entries[+c.dataset.arcsel]).filter(e => e && !e.dir);
  if (!sel.length) return snack('Отметьте файлы галочками');
  const s = currentSerial();
  const dest = arc.path.replace(/\.[^/.]+$/, '') + '_распаковано';
  await window.api.fsCmd(s, ['mkdir', '-p', dest]);
  snack('Извлекаю ' + sel.length + ' файл(ов)…');
  let ok = 0;
  for (const e of sel) {
    const r = await window.api.fsZipRead(s, arc.path, e.name);
    if (!r.ok) continue;
    const nm = e.name.split('/').pop();
    const wr = await window.api.fsTmpWrite('arcsel-' + Date.now().toString(36) + '-' + nm, bytesToB64(new Uint8Array(r.buf)));
    if (!wr.ok) continue;
    const rel = e.name.replace(/^\/+/, '').split('/').slice(0, -1).join('/');
    if (rel) await window.api.fsCmd(s, ['mkdir', '-p', dest + '/' + rel]);
    const pr = await window.api.fsPush(s, wr.path, dest + (rel ? '/' + rel : ''));
    if (pr.ok) ok++;
  }
  snack('Извлечено: ' + ok + ' из ' + sel.length + ' → ' + dest);
  closeDlg('dlg-arcview');
  fsNavigate(dest);
};

/* ================= v2.8.0: ИНСТРУМЕНТЫ USB/OTG-ФЛЕШКИ ================================== */
let usbVol = null;
async function openUsbTools(vol) {
  usbVol = vol;
  openDlg('dlg-usbtools');
  $('#usb-log').textContent = '';
  usbRefreshInfo();
}
async function usbRefreshInfo() {
  const s = currentSerial(); if (!s || !usbVol) return;
  $('#usb-info').textContent = 'Читаю данные тома…';
  const r = await window.api.usbInfo(s, usbVol);
  if (!r.ok) { $('#usb-info').textContent = 'Ошибка: ' + (r.error || ''); return; }
  const parts = ['Том: /storage/' + usbVol];
  if (r.fstype) parts.push('ФС: ' + r.fstype);
  if (r.dev) parts.push('устройство: ' + r.dev);
  if (r.total) parts.push('объём: ' + r.total + 'К, занято ' + r.used + 'К, свободно ' + r.free + 'К');
  if (r.mounted === false) parts.push('НЕ СМОНТИРОВАНА');
  $('#usb-info').textContent = parts.join(' · ');
}
function usbLog(t) { const el = $('#usb-log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; }
$('#btn-usb-refresh').onclick = usbRefreshInfo;
$('#btn-usb-check').onclick = async () => {
  const s = currentSerial(); if (!s) return;
  usbLog('Проверяю файловую систему (попробую fsck, иначе перемонтирование)…');
  const r = await window.api.usbCheck(s, usbVol);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.tool ? r.tool + ': ' : '') + (r.message || r.error || ''));
  if (r.ok) snack('Проверка завершена — подробности в журнале ниже');
};
$('#btn-usb-eject').onclick = async () => {
  const s = currentSerial();
  const r = await window.api.usbEject(s, usbVol);
  snack(r.message || (r.ok ? 'Извлечено' : 'Не удалось извлечь'));
  if (r.ok) { closeDlg('dlg-usbtools'); renderFsVolumes(); }
};
$('#btn-usb-label').onclick = async () => {
  const s = currentSerial();
  const label = $('#usb-label').value.trim();
  if (!label) return snack('Введите метку тома');
  const yes = await uiConfirm('Смена метки', 'Метка меняется ПЕРЕСОЗДАНИЕМ файловой системы — ВСЕ ДАННЫЕ будут стёрты. Продолжить?');
  if (!yes || !yes.ok) return;
  usbLog('Меняю метку на «' + label + '»…');
  const r = await window.api.usbLabel(s, usbVol, label);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.message || r.error || ''));
};
$('#btn-usb-format').onclick = async () => {
  const s = currentSerial();
  const label = $('#usb-label').value.trim();
  const yes = await uiConfirm('Форматирование', 'ПОЛНОСТЬЮ отформатировать флешку ' + usbVol + '? ВСЕ ДАННЫЕ БУДУТ СТЁРТЫ.');
  if (!yes || !yes.ok) return;
  usbLog('Форматирую…');
  const r = await window.api.usbFormat(s, usbVol, label || null);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.message || r.error || ''));
  for (const w of (r.warnings || [])) usbLog('· ' + w);
  if (r.ok) snack('Форматирование выполнено');
};
$('#btn-usb-fake').onclick = async () => {
  const s = currentSerial();
  const blk = +$('#usb-fake-blk').value || 64;
  $('#usb-fake-progress').classList.remove('hidden');
  $('#usb-fake-bar').style.width = '0%';
  $('#usb-fake-status').textContent = 'Запускаю проверку памяти…';
  $('#btn-usb-fake-cancel').classList.remove('hidden');
  $('#btn-usb-fake').disabled = true;
  const r = await window.api.usbFakeTestStart(s, usbVol, blk);
  if (!r.ok) { $('#usb-fake-status').textContent = r.error || 'не удалось начать'; $('#btn-usb-fake').disabled = false; $('#btn-usb-fake-cancel').classList.add('hidden'); $('#usb-fake-progress').classList.add('hidden'); }
};
$('#btn-usb-fake-cancel').onclick = () => window.api.usbFakeTestCancel();
function usbFakeEvent(ev) {
  const bar = $('#usb-fake-bar'), st = $('#usb-fake-status');
  if (!st) return;
  if (ev.stage === 'write') { st.textContent = 'Заливаю флешку блоками по ' + ev.blk + ' МБ (записываются маркеры)…'; }
  else if (ev.stage === 'write-progress') {
    const mb = ev.done * (ev.blockBytes / 1048576);
    st.textContent = 'Записано: ' + (mb >= 1024 ? (mb / 1024).toFixed(1) + ' ГБ' : Math.round(mb) + ' МБ') + ' — не выдёргивайте флешку';
    bar.style.width = Math.min(70, ev.done * 2) + '%';
  }
  else if (ev.stage === 'wfail') { st.textContent = 'Запись остановилась на блоке ' + ev.at + ' (конец реального объёма). Проверяю…'; bar.style.width = '75%'; }
  else if (ev.stage === 'verify') { st.textContent = 'Читаю маркеры назад (' + ev.written + ' блоков)…'; bar.style.width = '80%'; }
  else if (ev.stage === 'verify-progress') { st.textContent = 'Проверено: ' + ev.done + ' / ' + ev.total; bar.style.width = (80 + 18 * ev.done / Math.max(1, ev.total)) + '%'; }
  else if (ev.stage === 'done') {
    $('#btn-usb-fake').disabled = false;
    $('#btn-usb-fake-cancel').classList.add('hidden');
    bar.style.width = '100%';
    const real = ev.realBytes || 0;
    const realTxt = real >= 1073741824 ? (real / 1073741824).toFixed(2) + ' ГБ' : Math.round(real / 1048576) + ' МБ';
    if (ev.canceled) { st.textContent = 'Проверка остановлена. Успешно проверено: ' + realTxt; return; }
    if (ev.wrappedAt >= 0 || ev.wfail != null) {
      st.innerHTML = '✗ ФЕЙКОВАЯ ПАМЯТЬ: реальный объём ≈ <b>' + realTxt + '</b>. Запись «завернулась» на блоке ' +
        (ev.wrappedAt >= 0 ? ev.wrappedAt : '(запись кончилась раньше)');
      usbLog('РЕЗУЛЬТАТ: реальный объём ≈ ' + realTxt + ' (маркеры совпали до блока ' + (ev.wrappedAt >= 0 ? ev.wrappedAt - 1 : ev.writtenBlocks - 1) + ')');
      usbLog('Что делать: сохраняйте на неё не больше ' + realTxt + '; честный объём можно задать утилитой производителя (SD Card Formatter / H2testw после подключения к ПК).');
      snack('Похоже на фейковую память: реальный объём ≈ ' + realTxt, 10000);
    } else {
      st.innerHTML = '✓ Память ЧЕСТНАЯ: все ' + ev.writtenBlocks + ' блоков прочитались верно (≥ ' + realTxt + ')';
      usbLog('РЕЗУЛЬТАТ: память честная, проверено ≥ ' + realTxt);
      snack('Память оригинальная (проверено ≥ ' + realTxt + ')', 8000);
    }
  }
  else if (ev.stage === 'error') { $('#btn-usb-fake').disabled = false; $('#btn-usb-fake-cancel').classList.add('hidden'); st.textContent = 'Ошибка: ' + (ev.error || ''); }
  else if (ev.stage === 'canceled') { st.textContent = 'Остановлено.'; }
}

/* свойства файла/папки (F6); v2.7.0: + распаковка архивов, открытие текста/PDF/HTML,
   родная иконка и имя APK-файла с телефона, Android-бейдж на иконке */
async function openFsProps(it) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  const full = it.path || (fsDir.replace(/\/+$/, '') + '/' + it.name); // v2.8.0: путь из категории тоже
  const isApk = !it.dir && APK_RE.test(it.name);
  const ic = window.FSICONS.iconFor(it.name, it.dir);
  // Android-бейдж в углу иконки для APK (требование владельца); обёртка идемпотентная
  const imgEl = $('#fsprop-icon');
  if (imgEl && !(imgEl.parentElement && imgEl.parentElement.classList.contains('fsprop-ico-wrap'))) {
    const wrap = document.createElement('span');
    wrap.className = 'fsprop-ico-wrap';
    imgEl.replaceWith(wrap);
    wrap.appendChild(imgEl);
  }
  const wrapEl = document.querySelector('#dlg-fsprop .fsprop-ico-wrap');
  if (wrapEl) {
    wrapEl.querySelectorAll('.android-badge').forEach(b => b.remove());
    if (isApk) {
      const b = document.createElement('img');
      b.className = 'android-badge';
      b.src = window.FSICONS.ANDROID_BADGE;
      b.setAttribute('data-tip', 'Приложение Android');
      wrapEl.appendChild(b);
    }
  }
  $('#fsprop-icon').src = ic.src;
  $('#fsprop-title').textContent = it.name;
  $('#fsprop-body').innerHTML = '<div class="muted">Читаю свойства…</div>';
  // кнопки действий: очищаем и наполняем по типу
  const foot = document.querySelector('#dlg-fsprop .dialog-foot');
  foot.querySelectorAll('[data-v27]').forEach(b => b.remove());
  const addBtn = (id, label, tip) => {
    const b = document.createElement('button');
    b.className = 'btn btn-tonal btn-sm'; b.id = id; b.textContent = label;
    b.setAttribute('data-v27', '1'); b.setAttribute('data-tip', tip || '');
    foot.insertBefore(b, foot.firstChild);
    return b;
  };
  const openBtns = [];
  if (!it.dir) {
    if (TXT_RE.test(it.name) || PDF_RE.test(it.name) || DOCX_RE.test(it.name) || VCF_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-open', DOCX_RE.test(it.name) ? 'Открыть документ' : VCF_RE.test(it.name) ? 'Открыть контакты' : TXT_RE.test(it.name) ? 'Открыть как текст' : 'Открыть PDF', 'Просмотр прямо в программе'));
    if (HTML_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-html', 'Открыть в браузере', 'Скачает и откроет в системном браузере — со всеми скриптами и CDN'));
    if (ARC_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-arcview', 'Открыть архив (не распаковывая)', 'Содержимое ZIP/JAR со списком файлов и точечным извлечением'));
    if (ARC_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-extract', 'Распаковать в папку', 'Распаковать архив в папку с именем архива, в эту же папку устройства'));
  }
  // v2.8.0: Копировать/Вырезать/Переименовать/В архив — прямо из свойств (для всех)
  const actBtns = [];
  actBtns.push(addBtn('btn-fsprop-clipcopy', 'Копировать', 'Положить в буфер: вставьте в любой папке (панель «Вставить сюда»)'));
  actBtns.push(addBtn('btn-fsprop-clipcut', 'Вырезать', 'Переместить: вставьте в любой папке'));
  actBtns.push(addBtn('btn-fsprop-rename', 'Переименовать', 'Переименовать файл или папку'));
  actBtns.push(addBtn('btn-fsprop-tozip', 'В архив ZIP', 'Собрать ZIP (файлы/папки) в текущей папке'));
  openDlg('dlg-fsprop');
  const st = await window.api.fsStat(s, full);
  const isDir = it.dir || /directory/i.test(st.kind || '');
  const rows = [
    ['Тип', isDir ? 'Папка' : ('Файл · ' + ((it.name.match(/\.([a-z0-9]+)$/i) || ['', 'без расширения'])[1].toUpperCase()))],
    ['Полный путь', full],
    ['Размер', st.size != null && !isDir ? fmtBytesLong(st.size) + ' (' + st.size + ' Б)' : (it.size ? fmtBytesLong(it.size) : '—')],
    isDir && st.items != null ? ['Внутри объектов', String(st.items)] : null,
    isDir && st.duBytes ? ['Занято на диске', '≈ ' + fmtBytesLong(st.duBytes)] : null,
    ['Изменён', (st.mtime || it.date || '—').toString().trim()],
    ['Права доступа', st.perms || it.perms || '—'],
    ['Владелец', st.uid != null ? (st.uid + (st.gid ? ' / группа ' + st.gid : '')) : '—'],
    ['Ссылок', st.links || null],
    ['Устройство', nameOf(s)]
  ].filter(Boolean);
  $('#fsprop-body').innerHTML = rows.map(r => '<div class="prop-row"><b>' + esc(r[0]) + ':</b><span>' + esc(r[1] || '—') + '</span></div>').join('');
  // родная иконка/имя APK: тянем мету файла с телефона (кэшируется после первого раза)
  if (isApk) {
    const meta = await window.api.apkRemoteMeta(s, full).catch(() => null);
    if (meta && meta.ok && meta.dataUrl) {
      const img = $('#fsprop-icon'); if (img) img.src = meta.dataUrl;
      if (meta.label || meta.package) {
        $('#fsprop-body').insertAdjacentHTML('afterbegin',
          '<div class="prop-row"><b>Приложение:</b><span>' + esc(meta.label || '—') + (meta.package ? ' · <span class="mono">' + esc(meta.package) + '</span>' : '') + (meta.versionName ? ' · v' + esc(meta.versionName) : '') + '</span></div>');
      }
    } else if (meta && meta.reason === 'big') {
      $('#fsprop-body').insertAdjacentHTML('afterbegin', '<div class="prop-row"><b>Иконка приложения:</b><span>APK больше 80 МБ — для скорости не разбираю</span></div>');
    }
    // v2.8.0: СРАВНЕНИЕ С УСТАНОВЛЕННОЙ ВЕРСИЕЙ + кнопка «Установить на телефон»
    if (meta && meta.ok && meta.package) {
      const inst = await window.api.apkInstalledInfo(s, meta.package).catch(() => null);
      const fileV = meta.versionName || null;
      if (inst && inst.installed) {
        const cmp = (() => {
          const a = String(inst.versionCode || ''), b = String(meta.versionCode || '');
          if (a && b && +a > +b) return 'УСТАНОВЛЕННАЯ НОВЕЕ файла';
          if (a && b && +a < +b) return 'файл НОВЕЕ установленной';
          if (String(inst.versionName || '') === String(fileV || '')) return 'версии совпадают';
          return 'версии различаются';
        })();
        $('#fsprop-body').insertAdjacentHTML('beforeend',
          '<div class="prop-row"><b>Установлено на телефоне:</b><span>v' + esc(inst.versionName || '?') + (inst.versionCode ? ' (код ' + esc(inst.versionCode) + ')' : '') + ' · ' + esc(cmp) + '</span></div>');
      } else {
        $('#fsprop-body').insertAdjacentHTML('beforeend',
          '<div class="prop-row"><b>Установлено на телефоне:</b><span>не установлено</span></div>');
      }
      if (/\.apk$/i.test(it.name)) {
        const ib = addBtn('btn-fsprop-phoneinstall', 'Установить на телефон', 'Установить этот APK прямо с памяти телефона (pm install -r) — без скачивания на ПК');
        ib.classList.add('btn-filled');
        ib.onclick = async () => {
          ib.disabled = true; ib.textContent = 'Устанавливаю…';
          const r = await window.api.apkPhoneInstall(s, full);
          ib.disabled = false; ib.textContent = 'Установить на телефон';
          if (r.ok) snack('Установлено: ' + (meta.label || it.name));
          else snack('Не удалось установить: ' + (r.message || r.error || 'ошибка'), 7000);
        };
      }
    }
  }
  for (const b of actBtns) {
    if (b.id === 'btn-fsprop-clipcopy') b.onclick = () => { fsClip = { paths: [full], cut: false }; showFsClipbar(); snack('Скопировано в буфер: ' + it.name); };
    if (b.id === 'btn-fsprop-clipcut') b.onclick = () => { fsClip = { paths: [full], cut: true }; showFsClipbar(); snack('Вырезано: ' + it.name); };
    if (b.id === 'btn-fsprop-rename') b.onclick = () => { closeDlg('dlg-fsprop'); fsRename(full, it.name); };
    if (b.id === 'btn-fsprop-tozip') b.onclick = () => { closeDlg('dlg-fsprop'); fsZipItems([full], it.name); };
  }
  for (const b of openBtns) {
    if (b.id === 'btn-fsprop-open') b.onclick = () => { closeDlg('dlg-fsprop'); openTextViewer(full); };
    if (b.id === 'btn-fsprop-html') b.onclick = () => { closeDlg('dlg-fsprop'); openHtmlOnPc(full, it.name); };
    if (b.id === 'btn-fsprop-arcview') b.onclick = () => { closeDlg('dlg-fsprop'); openArcViewer(full, it.name); };
    if (b.id === 'btn-fsprop-extract') b.onclick = async () => {
      b.disabled = true; b.textContent = 'Распаковываю…';
      const r = await window.api.fsExtract(s, full);
      b.disabled = false; b.textContent = 'Распаковать в папку';
      if (r.ok) {
        snack('Распаковано (' + (r.where || 'на устройстве') + '): ' + r.files + ' файлов → ' + r.dest);
        closeDlg('dlg-fsprop');
        fsNavigate(r.dest);
      } else snack(r.error || 'Не удалось распаковать');
    };
  }
  $('#btn-fsprop-folder').classList.toggle('hidden', !isDir);
  $('#btn-fsprop-folder').onclick = () => { closeDlg('dlg-fsprop'); if (isDir) fsNavigate(full); };
}

/* тома устройства: чипы над списком файлов.
   v2.6: emulated/self больше НЕ дублируются («зачем две кнопки Внутренняя память?»);
   внешние тома (OTG-флешки XXXX-XXXX) — со значком USB и кнопками обмена */
const USB_ICON_SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="10" width="6" height="11" rx="1.5"/><path d="M10 10V6l2-3 2 3v4"/><rect x="10.6" y="3.4" width="1" height="1" fill="#4fc3f7" stroke="none"/><rect x="12.4" y="4.6" width="1" height="1" fill="#4fc3f7" stroke="none"/></svg>');
const SD_ICON_SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 7v3M11.5 6v4M14 7v3"/></svg>');
async function renderFsVolumes() {
  const s = currentSerial();
  if (!s) { $('#fs-volumes').innerHTML = ''; fsFlash = null; return; }
  const r = await window.api.fsVolumes(s);
  const box = $('#fs-volumes');
  const vols = (r.vols || []).filter(v => v !== 'emulated' && v !== 'self'); // дубль «Внутренней памяти» убран (v2.6)
  // OTG-носители выглядят как XXXX-XXXX (FAT-uuid); симлинк primary и прочее не показываем
  const flashVols = vols.filter(v => /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(v));
  fsFlash = flashVols.length ? '/storage/' + flashVols[0] : null;
  box.innerHTML = flashVols.map(v => {
    const isSd = /sdcard/i.test(v);
    const ico = isSd ? SD_ICON_SVG : USB_ICON_SVG;
    return `<button class="chip vol-chip" data-vol="${esc(v)}" data-tip="Открыть флешку: /storage/${esc(v)} (правая кнопка — меню)">
      <img src="${ico}" alt="">Флешка ${esc(v)}</button>`;
  }).join('') +
    (fsFlash ? '<button class="chip" id="btn-usb-tools" data-tip="Форматирование, метка тома, проверка ошибок, проверка на фейковую память">⚙ Инструменты флешки</button>' +
      '<span class="muted small" data-tip="Кнопки «На флешку»/«На телефон» появляются у файлов, когда флешка вставлена">обмен телефон ⟷ флешка включён</span>' : '');
  box.querySelectorAll('[data-vol]').forEach(b => {
    b.onclick = () => fsNavigate('/storage/' + b.dataset.vol);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      openFsContextMenu(e.clientX, e.clientY, { name: 'Флешка ' + b.dataset.vol, dir: true }, {
        path: '/storage/' + b.dataset.vol,
        open: () => fsNavigate('/storage/' + b.dataset.vol),
        props: () => openUsbTools(b.dataset.vol),
        download: null,
        refresh: renderFsVolumes
      });
    };
  });
  const ut = document.getElementById('btn-usb-tools');
  if (ut) ut.onclick = () => openUsbTools(flashVols[0]);
}

/* ---------- v2.6: просмотрщик изображений (зум, пан, полный экран, листание) ---------- */
let iv = { list: [], idx: 0, scale: 1, tx: 0, ty: 0, rot: 0, natural: { w: 1, h: 1 }, loading: null };
function ivImageList() { return fsItems.filter(it => !it.dir && IMG_RE.test(it.name)); }
function ivApply() {
  const img = $('#imgview-img');
  img.style.transform = `translate(calc(-50% + ${iv.tx}px), calc(-50% + ${iv.ty}px)) rotate(${iv.rot}deg) scale(${iv.scale})`;
  $('#imgview-zoom').textContent = Math.round(iv.scale * 100) + '%';
}
function ivFit() {
  const st = $('#imgview-stage');
  const pad = 24;
  const k = Math.min((st.clientWidth - pad) / iv.natural.w, (st.clientHeight - pad) / iv.natural.h);
  iv.scale = Math.min(1, k) > 0 ? Math.min(1, k) : 1;
  if (k > 1) iv.scale = 1;
  iv.tx = 0; iv.ty = 0;
  ivApply();
}
function ivRotateFix() { // EXIF-поворот не нужен: adb отдаёт как есть; rot 90° сохраняем
  iv.rot = (iv.rot + 90) % 360;
  ivApply();
}
async function ivLoad(full) {
  const s = currentSerial(); if (!s) return;
  const img = $('#imgview-img'), msg = $('#imgview-msg');
  if (iv.loading) { try { iv.loading.xhr = true; } catch (e) {} }
  msg.classList.remove('hidden');
  msg.textContent = 'Загрузка…';
  $('#imgview-status').textContent = full;
  img.src = '';
  const token = { xhr: false };
  iv.loading = token;
  const r = await window.api.fsCat(s, full, 64);
  if (iv.loading !== token) return;
  if (!r.ok) { msg.textContent = r.error || 'Не удалось загрузить файл'; return; }
  const blob = new Blob([r.buf], { type: /jpe?g$/i.test(full) ? 'image/jpeg' : /png$/i.test(full) ? 'image/png' : /gif$/i.test(full) ? 'image/gif' : /webp$/i.test(full) ? 'image/webp' : /bmp$/i.test(full) ? 'image/bmp' : 'image/png' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    iv.natural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
    msg.classList.add('hidden');
    ivFit();
    $('#imgview-status').textContent = full + ' · ' + iv.natural.w + '×' + iv.natural.h + ' · ' + fmtBytesLong(r.bytes || 0);
  };
  img.onerror = () => { msg.textContent = 'Формат не поддерживается встроенным просмотрщиком (например HEIC) — скачайте файл'; };
  img.src = url;
}
// v2.7.0: плёнка-карусель внизу просмотрщика — карточки изображений папки, как в Windows.
// Клик по карточке = переход к этому фото; текущая подсвечена; миниатюры грузятся лениво.
let stripThumbs = new Map(); // путь → dataURL (кэш на открытие папки)
function ivStripCard(it, i) {
  const cur = i === iv.idx ? ' cur' : '';
  const p = fsDir.replace(/\/+$/, '') + '/' + it.name;
  const cached = stripThumbs.get(p);
  return `<div class="strip-card${cur}" data-strip="${i}" data-tip="${esc(it.name)}">
    ${cached ? '<img src="' + cached + '" alt="">' : '<div class="strip-ph">&#128444;</div>'}
    <span class="strip-name">${esc(it.name)}</span>
  </div>`;
}
function ivRenderStrip() {
  const strip = $('#imgview-strip');
  if (!iv.list.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = iv.list.map((it, i) => ivStripCard(it, i)).join('');
  strip.querySelectorAll('[data-strip]').forEach(c => c.onclick = () => {
    const target = +c.dataset.strip;
    ivNav(target - iv.idx);
  });
  const cur = strip.querySelector('.strip-card.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  // ленивые миниатюры: по 3 параллельно, только для карточек без кэша
  const jobs = iv.list.map((it, i) => ({ it, i, p: fsDir.replace(/\/+$/, '') + '/' + it.name }))
    .filter(j => !stripThumbs.has(j.p)).slice(0, 60);
  let run = 0; let idx = 0;
  const next = () => {
    while (run < 3 && idx < jobs.length) {
      const j = jobs[idx++];
      run++;
      window.api.fsCat(currentSerial(), j.p, 12).then(r => {
        if (r.ok && r.buf && r.buf.length) {
          const blob = new Blob([r.buf], { type: /jpe?g$/i.test(j.p) ? 'image/jpeg' : 'image/png' });
          stripThumbs.set(j.p, URL.createObjectURL(blob));
        }
      }).catch(() => {}).finally(() => { run--; next(); if (run === 0) ivRenderStrip(); });
    }
  };
  next();
}
async function openImgViewer(full) {
  iv.list = ivImageList();
  const name = full.split('/').pop();
  iv.idx = Math.max(0, iv.list.findIndex(x => x.name === name));
  $('#imgview-title').textContent = name;
  $('#imgview-pos').textContent = iv.list.length ? (iv.idx + 1) + '/' + iv.list.length : '';
  iv.scale = 1; iv.tx = 0; iv.ty = 0; iv.rot = 0; ivApply();
  openDlg('dlg-imgview');
  ivLoad(full);
  ivRenderStrip();
}
function ivNav(d) {
  if (!iv.list.length) return;
  iv.idx = (iv.idx + d + iv.list.length) % iv.list.length;
  const it = iv.list[iv.idx];
  const full = fsDir.replace(/\/+$/, '') + '/' + it.name;
  $('#imgview-title').textContent = it.name;
  $('#imgview-pos').textContent = (iv.idx + 1) + '/' + iv.list.length;
  iv.scale = 1; iv.tx = 0; iv.ty = 0; iv.rot = 0; ivApply();
  ivLoad(full);
  ivRenderStrip();
}
// v2.7.0: второй полноэкранный режим — реальный фулскрин монитора через Fullscreen API
function toggleMonitorFullscreen(el) {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  } catch (e) { snack('Полноэкранный режим не поддержался: ' + (e.message || e)); }
}
(function ivEvents() {
  const stage = $('#imgview-stage');
  let drag = null;
  stage.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, tx: iv.tx, ty: iv.ty }; e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    iv.tx = drag.tx + (e.clientX - drag.x);
    iv.ty = drag.ty + (e.clientY - drag.y);
    ivApply();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    iv.scale = Math.min(12, Math.max(0.05, iv.scale * k));
    ivApply();
  }, { passive: false });
  stage.addEventListener('dblclick', () => { iv.scale > 1.02 ? ivFit() : (iv.scale = 1, iv.tx = 0, iv.ty = 0, ivApply()); });
  $('#imgview-zin').onclick = () => { iv.scale = Math.min(12, iv.scale * 1.25); ivApply(); };
  $('#imgview-zout').onclick = () => { iv.scale = Math.max(0.05, iv.scale / 1.25); ivApply(); };
  $('#imgview-fit').onclick = ivFit;
  $('#imgview-100').onclick = () => { iv.scale = 1; iv.tx = 0; iv.ty = 0; ivApply(); };
  $('#imgview-rot').onclick = ivRotateFix;
  $('#imgview-prev').onclick = () => ivNav(-1);
  $('#imgview-next').onclick = () => ivNav(1);
  $('#imgview-full').onclick = () => $('#imgview-shell').classList.toggle('imgview-full');
  $('#imgview-fullmon').onclick = () => toggleMonitorFullscreen($('#imgview-shell'));
})();

/* ================= v2.7.0: просмотр текстовых файлов (все форматы) и PDF =================
   v2.7.2: + КОПИРОВАНИЕ, РЕДАКТИРОВАНИЕ с записью обратно на телефон (utf-8/windows-1251
   сохраняется) и ПРЕВЬЮ HTML-файлов как страницы (iframe с локальной временной копии) */
const tv = { full: null, isPdf: false, pdfDoc: null, pdfPage: 1, pdfLibLoading: false,
             text: '', buf: null, encoding: 'utf-8', editing: false, isHtml: false, previewing: false,
             isDocx: false, isVcf: false };
function bytesToB64(u8) {
  let s = '', CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
// windows-1251 → байты (для файлов, открытых в 1251): А-Я/а-я → 0xC0..0xFF, Ё→0xA8, ё→0xB8
function encode1251(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out[i] = c;
    else if (c >= 0x410 && c <= 0x44F) out[i] = c - 0x410 + 0xC0;
    else if (c === 0x401) out[i] = 0xA8;
    else if (c === 0x451) out[i] = 0xB8;
    else if (c === 0x2116) out[i] = 0xB9;      // №
    else out[i] = 0x3F;                        // ? — символа нет в 1251
  }
  return out;
}
function tvButtons() {
  $('#textview-copy').classList.toggle('hidden', tv.isPdf || tv.isDocx || tv.isVcf);
  $('#textview-edit').classList.toggle('hidden', tv.isPdf || !tv.text || tv.isDocx || tv.isVcf);
  $('#textview-save').classList.add('hidden');
  $('#textview-preview').classList.toggle('hidden', !tv.isHtml);
  $('#textview-code').classList.add('hidden');
}
// v2.8.0: показать СФОРМИРОВАННЫЙ HTML (DOCX/контакты VCF) во встроенном фрейме
function tvShowHtml(html, statusText) {
  const frame = $('#textview-frame'), pre = $('#textview-pre');
  const doc = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>' +
    'body{font-family:Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:22px 26px;color:#1c2430;background:#fff;line-height:1.55}' +
    'h1{font-size:22px;margin:2px 0 10px}h2,h3{margin:16px 0 6px}p{margin:8px 0}' +
    '.docx-tbl{border-collapse:collapse;margin:10px 0}.docx-tbl td,.docx-tbl th{border:1px solid #c9d2dc;padding:5px 9px;font-size:14px}' +
    '.docx-li{margin:4px 0 4px 10px}' +
    '.vcf-card{border:1px solid #d7dee6;border-radius:12px;padding:12px 16px;margin:10px 0;background:#f7f9fb}' +
    '.vcf-name{font-size:17px;font-weight:700;margin-bottom:4px}' +
    '.vcf-row{margin:2px 0;font-size:14px;color:#2a3644}.vcf-row b{color:#5a6a7c;font-weight:600;margin-right:6px}' +
    '.vcf-row a{color:#0a66d0;text-decoration:none}' +
    '</style></head><body>' + html + '</body></html>';
  frame.srcdoc = doc;
  frame.classList.remove('hidden');
  pre.classList.add('hidden');
  $('#textview-status').textContent = statusText;
}
// v2.8.0: парсер vCard (.vcf) — карточки контактов: имя, телефоны, email, организация и др.
function vcfToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // разворачиваем свернутые строки (продолжение с пробела в начале)
  const unfolded = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const unesc = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  const cards = [];
  let cur = null;
  for (const l of unfolded) {
    const t = l.trim();
    if (/^BEGIN:VCARD/i.test(t)) { cur = { name: '', rows: [] }; continue; }
    if (/^END:VCARD/i.test(t)) { if (cur) cards.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = t.match(/^([^:;]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const key = m[1].toUpperCase().split(';')[0];
    const params = m[2] || '';
    let val = unesc(m[3]);
    if (!val.trim()) continue;
    if (key === 'FN') cur.name = val;
    else if (key === 'N') {
      const parts = val.split(/[;,]/).map(x => x.trim()).filter(Boolean);
      if (!cur.name && parts.length) cur.name = parts.slice(0, 2).reverse().join(' ');
    }
    else if (key === 'TEL') { const t2 = (params.match(/TYPE=([^;:]+)/i) || [])[1]; cur.rows.push(['Телефон' + (t2 ? ' (' + t2.toLowerCase() + ')' : ''), '<a href="tel:' + escH(val.replace(/[^\d+]/g, '')) + '">' + escH(val) + '</a>']); }
    else if (key === 'EMAIL') cur.rows.push(['Email', '<a href="mailto:' + escH(val) + '">' + escH(val) + '</a>']);
    else if (key === 'ORG') cur.rows.push(['Организация', escH(val.replace(/;/g, ' · '))]);
    else if (key === 'TITLE') cur.rows.push(['Должность', escH(val)]);
    else if (key === 'ADR') cur.rows.push(['Адрес', escH(val.replace(/;/g, ', ').replace(/,+$/, ''))]);
    else if (key === 'NOTE') cur.rows.push(['Заметка', escH(val)]);
    else if (key === 'BDAY') cur.rows.push(['День рождения', escH(val)]);
    else if (key === 'URL') cur.rows.push(['Сайт', '<a href="' + escH(val) + '" target="_blank">' + escH(val) + '</a>']);
    else if (key === 'IMPP' || key === 'X-...' || key === 'NICKNAME') cur.rows.push([key === 'NICKNAME' ? 'Ник' : 'Мессенджер', escH(val.replace(/^.*:/, ''))]);
  }
  if (!cards.length) return null;
  return '<h1>Контакты: ' + cards.length + '</h1>' + cards.map(c =>
    '<div class="vcf-card"><div class="vcf-name">' + escH(c.name || '(без имени)') + '</div>' +
    c.rows.map(r => '<div class="vcf-row"><b>' + r[0] + ':</b> ' + r[1] + '</div>').join('') +
    '</div>').join('');
}
async function openTextViewer(full) {
  const s = currentSerial(); if (!s) return;
  tv.full = full;
  tv.isPdf = PDF_RE.test(full);
  tv.isHtml = HTML_RE.test(full);
  tv.isDocx = DOCX_RE.test(full);   // v2.8.0
  tv.isVcf = VCF_RE.test(full);     // v2.8.0
  tv.editing = false; tv.previewing = false; tv.text = ''; tv.buf = null; tv.encoding = 'utf-8';
  const name = full.split('/').pop();
  $('#textview-title').textContent = name;
  $('#textview-status').textContent = full;
  $('#textview-pos').textContent = '';
  $('#textview-pre').classList.remove('hidden');
  const frame = $('#textview-frame');
  frame.classList.add('hidden');
  try { frame.srcdoc = ''; } catch (e) {}
  try { frame.src = 'about:blank'; } catch (e) {}
  $('#textview-pre').contentEditable = 'false';
  $('#pdfview-box').classList.toggle('hidden', !tv.isPdf);
  tvButtons();
  openDlg('dlg-textview');
  if (tv.isPdf) return loadPdf(full);
  // v2.8.0: DOCX — тянем файл целиком, конвертируем в HTML на ПК (word/document.xml), показываем во фрейме
  if (tv.isDocx) {
    const pre0 = $('#textview-pre');
    pre0.textContent = 'Читаю документ…';
    const d = await window.api.fsDocx(s, full).catch(() => null);
    if (d && d.ok) { tvShowHtml(d.html, full + ' · документ DOCX'); }
    else {
      pre0.textContent = '';
      $('#textview-status').textContent = (d && d.error) || 'Не удалось прочитать DOCX';
      snack((d && d.error) || 'Не удалось прочитать DOCX — попробуйте «Скачать» или «На ПК»', 6000);
    }
    return;
  }
  const pre = $('#textview-pre');
  pre.textContent = 'Загрузка…';
  const r = await window.api.fsCat(s, full, 8);
  if (!r.ok) {
    pre.textContent = '';
    $('#textview-status').textContent = r.error || 'Не удалось загрузить файл';
    if (r.capped) snack('Файл больше 8 МБ — показывать целиком не буду. Кнопка «Скачать» внизу работает.');
    return;
  }
  tv.buf = new Uint8Array(r.buf);
  // декодирование: UTF-8, при сбое — windows-1251 (файлы с русским текстом в 866/1251)
  try { tv.text = new TextDecoder('utf-8', { fatal: true }).decode(tv.buf); tv.encoding = 'utf-8'; }
  catch (e) { try { tv.text = new TextDecoder('windows-1251').decode(tv.buf); tv.encoding = 'windows-1251'; } catch (e2) { tv.text = tv.buf.toString('latin1'); tv.encoding = 'latin1'; } }
  // v2.8.0: VCF — карточки контактов во фрейме (и «чистый текст» доступен по кнопке «Код»-стиля нет — vcf простой текст)
  if (tv.isVcf) {
    const html = vcfToHtml(tv.text);
    if (html) { tvShowHtml(html, full + ' · контакты vCard'); return; }
    // не распарсился — покажем как обычный текст ниже
  }
  const shown = tv.text.length > 400000 ? tv.text.slice(0, 400000) : tv.text;
  $('#textview-pos').textContent = tv.text.length > 400000 ? '(показаны первые 400 000 символов)' : '';
  pre.textContent = shown;
  $('#textview-status').textContent = full + ' · ' + fmtBytesLong(r.bytes || 0) + (tv.encoding !== 'utf-8' ? ' · кодировка ' + tv.encoding : '');
  tvButtons();
}
async function tvSaveBack() {
  if (!tv.full || !tv.editing) return;
  const s = currentSerial(); if (!s) return;
  const pre = $('#textview-pre');
  const clean = (pre.innerText || '').replace(/\u00A0/g, ' ');
  const bytes = tv.encoding === 'windows-1251' ? encode1251(clean) : new TextEncoder().encode(clean);
  const btn = $('#textview-save');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  const r = await window.api.fsSaveText(s, tv.full, bytesToB64(bytes));
  btn.disabled = false; btn.textContent = 'Сохранить на телефон';
  if (r.ok) {
    tv.text = clean;
    tv.editing = false;
    pre.contentEditable = 'false';
    pre.textContent = clean.length > 400000 ? clean.slice(0, 400000) : clean;
    $('#textview-save').classList.add('hidden');
    $('#textview-edit').classList.remove('hidden');
    $('#textview-status').textContent = tv.full + ' · сохранено на телефон ✓';
    snack('Сохранено на телефон: ' + tv.full.split('/').pop());
  } else {
    snack('Не удалось сохранить: ' + (r.error || 'ошибка'));
  }
}
async function tvPreview() {
  if (!tv.isHtml || !tv.buf) return;
  const r = await window.api.fsTmpWrite(tv.full.split('/').pop(), bytesToB64(tv.buf));
  if (!r.ok) return snack('Не удалось подготовить превью: ' + (r.error || ''));
  $('#textview-frame').src = encodeURI('file:///' + String(r.path).replace(/\\/g, '/'));
  $('#textview-frame').classList.remove('hidden');
  $('#textview-pre').classList.add('hidden');
  $('#textview-preview').classList.add('hidden');
  $('#textview-code').classList.remove('hidden');
  tv.previewing = true;
  $('#textview-status').textContent = 'Превью страницы — скрипты и стили из самого файла работают; внешние ссылки (CDN) доступны только в браузере';
}
$('#textview-code').onclick = () => {
  $('#textview-frame').classList.add('hidden');
  $('#textview-pre').classList.remove('hidden');
  $('#textview-code').classList.add('hidden');
  $('#textview-preview').classList.remove('hidden');
  tv.previewing = false;
};
$('#textview-preview').onclick = tvPreview;
$('#textview-copy').onclick = () => { if (tv.text) copyText(tv.text.slice(0, 400000)); };
$('#textview-edit').onclick = () => {
  const pre = $('#textview-pre');
  if (tv.previewing) $('#textview-code').click();
  tv.editing = true;
  pre.contentEditable = 'true';
  pre.focus();
  $('#textview-edit').classList.add('hidden');
  $('#textview-save').classList.remove('hidden');
  $('#textview-status').textContent = 'Режим редактирования — измените текст и нажмите «Сохранить на телефон»';
};
$('#textview-save').onclick = tvSaveBack;
async function loadPdf(full) {
  const s = currentSerial(); if (!s) return;
  $('#pdfview-page').textContent = 'загрузка…';
  if (!window.pdfjsLib) {
    if (tv.pdfLibLoading) return;
    tv.pdfLibLoading = true;
    try {
      await new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = 'lib/pdf.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('не удалось загрузить pdf.js'));
        document.head.appendChild(sc);
      });
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      }
    } catch (e) {
      tv.pdfLibLoading = false;
      $('#pdfview-page').textContent = 'pdf.js не загрузился — нажмите «Открыть на ПК»';
      return;
    }
    tv.pdfLibLoading = false;
  }
  try {
    const r = await window.api.fsCat(s, full, 128);
    if (!r.ok) { $('#pdfview-page').textContent = r.error || 'не удалось загрузить'; return; }
    tv.pdfDoc = await window.pdfjsLib.getDocument({ data: r.buf }).promise;
    tv.pdfPage = 1;
    renderPdfPage();
  } catch (e) {
    $('#pdfview-page').textContent = 'Не удалось открыть PDF: ' + (e.message || e).slice(0, 80);
  }
}
async function renderPdfPage() {
  if (!tv.pdfDoc) return;
  const page = await tv.pdfDoc.getPage(Math.min(tv.pdfPage, tv.pdfDoc.numPages));
  const box = $('#pdfview-box');
  const scale = Math.min(1.6, (box.clientWidth - 40) / page.getViewport({ scale: 1 }).width);
  const vp = page.getViewport({ scale: Math.max(0.4, scale) });
  const cv = $('#pdfview-canvas');
  cv.width = vp.width; cv.height = vp.height;
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  $('#pdfview-page').textContent = tv.pdfPage + ' / ' + tv.pdfDoc.numPages;
}
$('#pdfview-prev').onclick = async () => { if (tv.pdfDoc && tv.pdfPage > 1) { tv.pdfPage--; await renderPdfPage(); } };
$('#pdfview-next').onclick = async () => { if (tv.pdfDoc && tv.pdfPage < tv.pdfDoc.numPages) { tv.pdfPage++; await renderPdfPage(); } };
$('#textview-wrap').onclick = () => $('#textview-pre').classList.toggle('wrap');
$('#textview-dl').onclick = async () => {
  if (!tv.full) return;
  const res = await window.api.fsPull(currentSerial(), tv.full);
  if (res.ok) snack('Сохранено: ' + res.file);
};
$('#textview-openpc').onclick = async () => {
  if (!tv.full) return;
  snack('Скачиваю и открываю системной программой…');
  const r = await window.api.fsOpenOnPc(currentSerial(), tv.full);
  snack(r.ok ? 'Открыто на компьютере' : (r.error || 'Не удалось'));
};
// v2.7.0: HTML-файлы с телефона открываются в СИСТЕМНОМ браузере — там работают и CDN-скрипты
// (триjs-анимации владельца), и весь JS. Встроенный iframe был бы зажат CSP и без сети.
async function openHtmlOnPc(full, name) {
  const s = currentSerial(); if (!s) return;
  const yes = await uiConfirm('Открыть HTML в браузере', '«' + name + '» будет скачан во временную папку и открыт в системном браузере — так работают все скрипты, стили и CDN. Открыть?');
  if (!yes || !yes.ok) return;
  snack('Скачиваю и открываю в браузере…');
  const r = await window.api.fsOpenOnPc(s, full);
  snack(r.ok ? 'Открыто в системном браузере: ' + name : (r.error || 'Не удалось'));
}

/* ---------- v2.6→v2.7: медиаплеер (видео+аудио), эквалайзер, 10 визуализаций ----------
   v2.7.0: визуализации из window.VISLIB (в т.ч. по мотивам анимаций владельца), с номерами
   и названиями, листаются стрелками ◀ ▶, выбор запоминается между запусками; анимация живёт
   ВСЕГДА, пока открыт плеер, а при воспроизведении реагирует на звук через анализатор. */
const mp = {
  list: [], idx: 0, isVideo: false,
  ctx: null, src: null, analyser: null, filters: [], out: null,
  visIdx: 0, raf: 0, loadedUrl: null, wantPlay: true,
  // v2.8.0: ПРЯМОЕ воспроизведение по умолчанию (элемент el2 мимо WebAudio) — корень жалоб
  // «чёрный экран / запускаю и ничего»: граф WebAudio (createMediaElementSource) на части
  // машин молчит или подвешивает элемент. Эквалайзер теперь ВКЛЮЧАЕТСЯ КНОПКОЙ — тогда
  // звук идёт через аудио-движок; всё остальное время играет напрямую, всегда надёжно.
  eqOn: false, silT: 0
};
try { mp.visIdx = Math.min(window.VISLIB.length - 1, Math.max(0, parseInt(localStorage.getItem('media.vis') || '0', 10) || 0)); } catch (e) {}
try { mp.eqOn = localStorage.getItem('media.eq') === '1'; } catch (e) {}
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  'Плоско': [0,0,0,0,0,0,0,0,0,0],
  'Басы': [7,6,4,2,0,0,0,0,0,0],
  'Вокал': [-2,-1,0,2,4,4,3,1,0,-1],
  'Рок': [5,4,2,-1,-2,1,3,4,4,3],
  'Поп': [-1,2,4,4,2,0,-1,-1,1,2],
  'Джаз': [3,2,1,2,-1,-1,0,1,3,4],
  'Классика': [4,3,2,0,-1,-1,0,2,3,4],
  'Электро': [6,5,1,0,-2,2,1,2,5,6]
};
function mediaList() { return fsItems.filter(it => !it.dir && (VID_RE.test(it.name) || AUD_RE.test(it.name))); }
function mpFmtTime(t) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function mpEnsureAudio() {
  if (mp.ctx) return;
  const el = $('#media-el');
  mp.ctx = new (window.AudioContext || window.webkitAudioContext)();
  mp.src = mp.ctx.createMediaElementSource(el);
  mp.filters = EQ_FREQS.map((f, i) => {
    const b = mp.ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : (i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking');
    b.frequency.value = f; b.Q.value = 1.0; b.gain.value = 0;
    return b;
  });
  mp.analyser = mp.ctx.createAnalyser();
  mp.analyser.fftSize = 512;
  mp.analyser.smoothingTimeConstant = 0.82;
  mp.out = mp.ctx.createGain();
  let prev = mp.src;
  for (const f of mp.filters) { prev.connect(f); prev = f; }
  prev.connect(mp.analyser); mp.analyser.connect(mp.out); mp.out.connect(mp.ctx.destination);
}
function mpApplyEq(gains) {
  if (!mp.filters.length) return;
  mp.filters.forEach((b, i) => { b.gain.value = gains[i] || 0; const sl = document.querySelector('#eq-bands [data-band="' + i + '"]'); if (sl) { sl.value = gains[i] || 0; const v = sl.parentElement.querySelector('.eq-val'); if (v) v.textContent = (gains[i] > 0 ? '+' : '') + (gains[i] || 0) + ' дБ'; } });
}
function mpBuildEq() {
  const box = $('#eq-bands');
  box.innerHTML = EQ_FREQS.map((f, i) => `<div class="eq-band">
      <span class="eq-val">0 дБ</span>
      <input type="range" min="-12" max="12" step="1" value="0" data-band="${i}" data-tip="Полоса ${f >= 1000 ? (f/1000) + ' кГц' : f + ' Гц'}">
      <span class="eq-freq">${f >= 1000 ? (f / 1000) + 'k' : f}</span>
    </div>`).join('');
  box.querySelectorAll('input[type=range]').forEach(sl => sl.oninput = () => {
    if (mp.filters[+sl.dataset.band]) mp.filters[+sl.dataset.band].gain.value = +sl.value;
    const v = sl.parentElement.querySelector('.eq-val');
    if (v) v.textContent = (+sl.value > 0 ? '+' : '') + sl.value + ' дБ';
  });
  $('#eq-presets').innerHTML = Object.keys(EQ_PRESETS).map(p => `<button class="chip" data-eqp="${esc(p)}" style="padding:4px 10px;font-size:12px">${esc(p)}</button>`).join('');
  $('#eq-presets').querySelectorAll('[data-eqp]').forEach(b => b.onclick = () => mpApplyEq(EQ_PRESETS[b.dataset.eqp]));
}
function mpVisLabel() {
  $('#media-vis-name').textContent = (mp.visIdx + 1) + '. ' + (window.VISLIB[mp.visIdx] || {}).name;
}
function mpVisNav(d) {
  mp.visIdx = (mp.visIdx + d + window.VISLIB.length) % window.VISLIB.length;
  try { localStorage.setItem('media.vis', String(mp.visIdx)); } catch (e) {}
  mpVisLabel();
  snd.play('click');
}
function mpDraw() {
  if ($('#dlg-media').classList.contains('hidden')) { mp.raf = 0; return; }
  mp.raf = requestAnimationFrame(mpDraw);
  const cv = $('#media-vis'), ctx = cv.getContext('2d');
  // v2.7.2: битмап канваса = фактический размер на экране (DPR до 1.5) — раньше канвас был
  // жёстко 960×320 и «растягивался» неровно в полном экране; теперь анимация заполняет
  // окно/экран ровно при любом размере
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const cw = Math.max(64, Math.round(cv.clientWidth * dpr));
  const ch = Math.max(48, Math.round(cv.clientHeight * dpr));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const W = cv.width, H = cv.height;
  // данные анализатора → амплитуды; на паузе спектр затухает к нулю, но ВРЕМЯ идёт —
  // поэтому каждая анимация продолжает жить (требование владельца)
  const a = { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] };
  if (mp.analyser) {
    const n = mp.analyser.frequencyBinCount;
    const fd = new Uint8Array(n), td = new Uint8Array(n);
    mp.analyser.getByteFrequencyData(fd);
    mp.analyser.getByteTimeDomainData(td);
    a.spectrum = fd; a.wave = td;
    let b = 0, m = 0, tr = 0;
    for (let i = 0; i < 8; i++) b += fd[i];
    for (let i = 8; i < 60; i++) m += fd[i];
    for (let i = 60; i < Math.min(n, 200); i++) tr += fd[i];
    a.bass = b / (8 * 255); a.mid = m / (52 * 255); a.treble = tr / (Math.min(n, 200) - 60) / 255;
    a.energy = a.bass * 0.5 + a.mid * 0.35 + a.treble * 0.15;
  } else {
    // плеер ещё не инициализирован — спокойное дыхание амплитуд
    const t = performance.now() / 1000;
    a.bass = 0.14 + 0.06 * Math.sin(t * 1.1);
    a.mid = 0.1 + 0.05 * Math.sin(t * 0.7 + 2);
    a.treble = 0.08 + 0.04 * Math.sin(t * 1.9 + 4);
    a.energy = a.bass * 0.6 + a.mid * 0.4;
  }
  const vis = window.VISLIB[mp.visIdx];
  if (vis) { try { vis.draw(ctx, W, H, performance.now() / 1000, a); } catch (e) {} }
}
async function mpLoad(full) {
  const s = currentSerial(); if (!s) return;
  const el = $('#media-el'), el2 = $('#media-el2');
  const name = full.split('/').pop();
  mp.isVideo = VID_RE.test(name);
  $('#media-title').textContent = name;
  $('#media-now-name').textContent = name;
  $('#media-now-sub').textContent = 'Загрузка с устройства…';
  $('#media-status').textContent = full;
  const visual = $('#media-visual');
  visual.classList.toggle('hidden-when-video', mp.isVideo);
  const r = await window.api.fsCat(s, full);
  if (!r.ok) { $('#media-now-sub').textContent = r.error || 'Не удалось загрузить'; return; }
  if (mp.loadedUrl) { try { URL.revokeObjectURL(mp.loadedUrl); } catch (e) {} }
  const mime = mp.isVideo
    ? (/webm$/i.test(name) ? 'video/webm' : (/mkv|avi|ts$/i.test(name) ? 'video/x-matroska' : 'video/mp4'))
    : (/ogg|opus|oga$/i.test(name) ? 'audio/ogg' : /flac$/i.test(name) ? 'audio/flac' : /wav$/i.test(name) ? 'audio/wav' : /aac$/i.test(name) ? 'audio/aac' : /m4a$/i.test(name) ? 'audio/mp4' : /wma$/i.test(name) ? 'audio/x-ms-wma' : 'audio/mpeg');
  mp.loadedUrl = URL.createObjectURL(new Blob([r.buf], { type: mime }));
  mp.lastFull = full;   // v2.8.0: для перезапуска при переключении режима звука
  const sub = (mp.isVideo ? 'Видео' : 'Аудио') + ' · ' + fmtBytesLong(r.bytes || 0);
  // v2.8.0: эквалайзер ВЫКЛЮЧЕН по умолчанию → ПРЯМОЕ воспроизведение через el2 (без WebAudio):
  // гарантированно звучит и показывает видео на любой машине. Эквалайзер — опция (кнопка EQ).
  if (!mp.eqOn) {
    try { el.pause(); } catch (e) {}
    el.classList.add('hidden');
    el2.src = mp.loadedUrl;
    el2.volume = (+$('#media-vol').value || 80) / 100;
    el2.classList.toggle('hidden', !mp.isVideo);
    $('#media-now-sub').textContent = sub + ' · прямое воспроизведение';
    try { el2.load(); } catch (e) {}
    try {
      await el2.play();
      $('#media-now-sub').textContent = sub;
    } catch (e) {
      $('#media-now-sub').textContent = 'Не удалось запустить автоматически — нажмите ▶';
    }
    return;
  }
  // режим с эквалайзером: звук идёт через WebAudio-граф (el подключён к нему насовсем)
  mpEnsureAudio();
  if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
  try { el2.pause(); } catch (e) {}
  el.classList.toggle('hidden', !mp.isVideo);
  el2.classList.add('hidden');
  el.src = mp.loadedUrl;
  el.volume = (+$('#media-vol').value || 80) / 100;
  $('#media-now-sub').textContent = sub + ' · эквалайзер';
  try { el.load(); } catch (e) {}
  try {
    await el.play();
    $('#media-now-sub').textContent = sub + ' · эквалайзер';
  } catch (e) {
    $('#media-now-sub').textContent = 'Не удалось запустить автоматически — нажмите ▶';
  }
}
// v2.8.0: страховка остаётся ТОЛЬКО для режима эквалайзера: играет el, а спектр молчит —
// честно предлагаем выключить EQ (прямое воспроизведение всегда надёжно)
function mpSilenceWatch() {
  clearTimeout(mp.silT);
  mp.silT = setTimeout(() => {
    const el = $('#media-el');
    if (!mp.eqOn || !mp.analyser || el.paused || mp.isVideo) return;
    try {
      const n = mp.analyser.frequencyBinCount;
      const fd = new Uint8Array(n);
      mp.analyser.getByteFrequencyData(fd);
      let sum = 0; for (let i = 0; i < n; i++) sum += fd[i];
      if (sum === 0 && !el.muted && el.volume > 0 && !el.error) {
        mp.eqOn = false;
        try { localStorage.setItem('media.eq', '0'); } catch (e) {}
        const eqBox = $('#media-eq');
        if (eqBox) eqBox.classList.add('hidden');
        try { el.pause(); } catch (e2) {}
        if (mp.lastFull) mpLoad(mp.lastFull).catch(() => {});
        snack('Звук через эквалайзер молчал — вернул прямое воспроизведение');
      }
    } catch (e) {}
  }, 2500);
}
async function openMediaPlayer(full) {
  mp.list = mediaList();
  const name = full.split('/').pop();
  mp.idx = Math.max(0, mp.list.findIndex(x => x.name === name));
  openDlg('dlg-media');
  mpBuildEq();
  $('#media-eq').classList.toggle('hidden', !mp.eqOn);   // v2.8.0: EQ-панель видна только в режиме EQ
  mpVisLabel();
  if (!mp.raf) mp.raf = requestAnimationFrame(mpDraw);
  mpLoad(full);
}
function mpNav(d) {
  if (!mp.list.length) return;
  mp.idx = (mp.idx + d + mp.list.length) % mp.list.length;
  mpLoad(fsDir.replace(/\/+$/, '') + '/' + mp.list[mp.idx].name);
}
(function mpEvents() {
  const el = $('#media-el'), el2 = $('#media-el2');
  const curEl = () => mp.eqOn ? el : el2;   // v2.8.0: по умолчанию прямой элемент el2
  function bindMedia(m) {
    m.onplay = () => $('#media-play').textContent = '⏸';
    m.onpause = () => $('#media-play').textContent = '▶';
    m.onloadeddata = () => { if (m === curEl()) $('#media-now-sub').textContent = (mp.isVideo ? 'Видео' : 'Аудио') + ' · готово'; };
    m.ontimeupdate = () => {
      if (m !== curEl()) return;
      $('#media-time').textContent = mpFmtTime(m.currentTime) + ' / ' + mpFmtTime(m.duration);
      if (m.duration) $('#media-seek').value = Math.round(m.currentTime / m.duration * 1000);
    };
    m.onended = () => { if (m === curEl()) mpNav(1); };
    m.onerror = () => {
      if (m !== curEl()) return;
      $('#media-now-sub').textContent = 'Этот формат/кодек браузер не играет (например mkv с редким кодеком) — нажмите «На ПК», там проиграет системный плеер';
      $('#media-status').textContent = 'Кодек не поддержан Chromium. Кнопки «Скачать» и «На ПК» выше — рабочие.';
    };
  }
  bindMedia(el); bindMedia(el2);
  $('#media-play').onclick = async () => {
    const m = curEl();
    if (!m.src) return;
    if (mp.eqOn) {   // v2.8.0: WebAudio нужен ТОЛЬКО в режиме эквалайзера
      mpEnsureAudio();
      if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
    }
    m.paused ? m.play() : m.pause();
  };
  $('#media-seek').oninput = () => { const m = curEl(); if (m.duration) m.currentTime = (+$('#media-seek').value / 1000) * m.duration; };
  $('#media-vol').oninput = () => { const m = curEl(); m.volume = (+$('#media-vol').value) / 100; };
  $('#media-prev').onclick = () => mpNav(-1);
  $('#media-next').onclick = () => mpNav(1);
  // v2.8.0: EQ — опция. ВКЛ: звук через WebAudio (перезапуск текущего трека с той же позиции);
  // ВЫКЛ: обратно на прямое воспроизведение. Так «чёрный экран/молчание» невозможны по умолчанию.
  $('#media-eqbtn').onclick = async () => {
    const wasOn = mp.eqOn;
    mp.eqOn = !wasOn;
    try { localStorage.setItem('media.eq', mp.eqOn ? '1' : '0'); } catch (e) {}
    $('#media-eq').classList.toggle('hidden', !mp.eqOn);
    const m = curEl();
    const t = (m && m.currentTime) || 0;
    if (mp.eqOn) mpEnsureAudio();
    if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
    if (mp.lastFull) { await mpLoad(mp.lastFull).catch(() => {}); }
    const m2 = curEl();
    if (t > 0 && m2 && m2.duration) { try { m2.currentTime = Math.min(t, m2.duration - 0.5); } catch (e) {} }
    snack(mp.eqOn ? 'Эквалайзер включён (звук через аудио-движок)' : 'Прямое воспроизведение (эквалайзер выключен)');
  };
  // v2.7.0: «Скачать» и «Скачать и открыть системным плеером» — для любых непроигрываемых форматов
  $('#media-dl').onclick = async () => {
    const f = mp.list[mp.idx]; if (!f) return;
    const res = await window.api.fsPull(currentSerial(), fsDir.replace(/\/+$/, '') + '/' + f.name);
    if (res.ok) snack('Сохранено: ' + res.file);
  };
  $('#media-openpc').onclick = async () => {
    const f = mp.list[mp.idx]; if (!f) return;
    snack('Скачиваю и открываю системным плеером…');
    const r = await window.api.fsOpenOnPc(currentSerial(), fsDir.replace(/\/+$/, '') + '/' + f.name);
    snack(r.ok ? 'Открыто в системном плеере' : (r.error || 'Не удалось'));
  };
  // v2.7.2: «В окне» — большой режим внутри программы; согласован с «На весь монитор»:
  // из полноэкранного монитора эта кнопка возвращает в ОБЫЧНОЕ окно (раньше «не работала»)
  let mpFullPreFs = false;
  $('#media-full').onclick = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      mpFullPreFs = false;
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    $('#dlg-media .media-dlg').classList.toggle('media-full');
  };
  $('#media-fullmon').onclick = () => toggleMonitorFullscreen($('#dlg-media .media-dlg'));
  const fsSyncMedia = () => {
    const dlg = $('#dlg-media .media-dlg');
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      mpFullPreFs = dlg.classList.contains('media-full');
    } else {
      dlg.classList.toggle('media-full', mpFullPreFs);
    }
  };
  document.addEventListener('fullscreenchange', fsSyncMedia);
  document.addEventListener('webkitfullscreenchange', fsSyncMedia);
  // v2.7.0: стрелки навигации визуализаций (номер + название, выбор запоминается)
  $('#media-vis-prev').onclick = () => mpVisNav(-1);
  $('#media-vis-next').onclick = () => mpVisNav(1);
  document.addEventListener('keydown', e => {
    if ($('#dlg-media').classList.contains('hidden')) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('#media-play').click(); }
    if (e.key === 'ArrowLeft') { if (e.shiftKey) mpVisNav(-1); else mpNav(-1); }
    if (e.key === 'ArrowRight') { if (e.shiftKey) mpVisNav(1); else mpNav(1); }
    if (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М') mpVisNav(1);
    if (e.key === 'Escape' && $('#dlg-media .media-dlg').classList.contains('media-full') &&
        !document.fullscreenElement && !document.webkitFullscreenElement) {
      $('#dlg-media .media-dlg').classList.remove('media-full');  // Esc — выход из «в окне»
    }
  });
  // просмотрщик: стрелки листают фото
  document.addEventListener('keydown', e => {
    if ($('#dlg-imgview').classList.contains('hidden')) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') ivNav(-1);
    if (e.key === 'ArrowRight') ivNav(1);
    if (e.key === 'Escape' && $('#imgview-shell').classList.contains('imgview-full')) $('#imgview-shell').classList.remove('imgview-full');
  });
})();

$('#btn-fs-back').onclick = () => fsNavigate(null, { back: true });
$('#btn-fs-go').onclick = () => fsNavigate($('#fs-path').value.trim() || '/sdcard');
$('#fs-path').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-fs-go').click(); });
$('#btn-fs-up').onclick = () => { const p = fsDir.replace(/\/+$/, '').split('/'); p.pop(); fsNavigate(p.join('/') || '/'); };
$('#btn-fs-refresh').onclick = fsRender;
$('#fs-filter').addEventListener('input', () => fsRender());
$('#btn-fs-toconnect').onclick = () => goPage('devices');

/* загрузка на телефон — ВСЕГДА в ОТКРЫТУЮ папку (F7) */
$('#btn-fs-push').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const files = await window.api.pickFile({ properties: ['openFile', 'multiSelections'] });
  if (!files || !files.length) return;
  snack('Загружаю в ' + fsDir + '…');
  let okCount = 0;
  for (const f of files) {
    const r = await window.api.fsPush(s, f, fsDir);
    if (r.ok) okCount++;
  }
  snack('Загружено в ' + fsDir + ': ' + okCount + ' из ' + files.length);
  fsRender();
};
// v2.8.0: обработчик «Новая папка» перенесён в блок файлового менеджера выше (рядом с «Новый файл»)

/* перетаскивание файлов с ПК прямо в окно — загрузка в ОТКРЫТУЮ папку (F8) */
(function fsDrop() {
  const ov = $('#fs-drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!document.querySelector('#page-files.active')) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++; ov.classList.remove('hidden');
    $('#fs-drop-dir').textContent = fsDir;
  });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; ov.classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (!ov.classList.contains('hidden')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (ov.classList.contains('hidden')) return;
    e.preventDefault(); depth = 0; ov.classList.add('hidden');
    const s = currentSerial(); if (!s) return snack('Нет устройства');
    const files = Array.from((e.dataTransfer.files || []));
    if (!files.length) return;
    snd.play('drop');
    snack('Загружаю в ' + fsDir + '…');
    let okCount = 0;
    for (const f of files) {
      const p = await window.api.pathForFile(f);
      if (!p) continue;
      const r = await window.api.fsPush(s, p, fsDir);
      if (r.ok) okCount++;
    }
    snack('Загружено в ' + fsDir + ': ' + okCount + ' из ' + files.length);
    fsRender();
  });
})();

/* ---------- менеджер приложений ---------- */
let appsData = null, appsTab = 'all', appsSort = 'name';
let appsMetaMap = {};   // v2.6: { pkg: {size, mtime} } для сортировки по размеру/дате
let appLabels = {};   // { pkg: человеческое имя } — из кэша main + извлечение из APK (F11)
const DEBLOAT = [
  { p: 'com.facebook.katana', safe: true }, { p: 'com.facebook.orca', safe: true },
  { p: 'com.instagram.android', safe: true }, { p: 'com.twitter.android', safe: true },
  { p: 'com.tiktok', safe: true }, { p: 'com.booking', safe: true },
  { p: 'com.linkedin.android', safe: true }, { p: 'com.microsoft.skydrive', safe: true },
  { p: 'com.skype.raider', safe: true }, { p: 'com.microsoft.office.officehub', safe: true },
  { p: 'com.samsung.android.bixby.vision', safe: true }, { p: 'com.samsung.android.bixby.wakeup', safe: true },
  { p: 'com.samsung.android.aremoji', safe: true }, { p: 'com.amazon.avod.thirdpartyclient', safe: true },
  { p: 'com.google.android.youtube', safe: false }, { p: 'com.google.android.apps.maps', safe: false },
  { p: 'com.android.chrome', safe: false }, { p: 'com.google.ar.core', safe: false }
];
async function appsLoad() {
  const s = currentSerial(); if (!s) { $('#apps-list').innerHTML = '<div class="empty">Сначала подключите устройство на странице «Подключение».</div>'; return; }
  // имена приложений из кэша подгружаем мгновенно — рисуются сразу (F11)
  try { appLabels = await window.api.appsLabels() || {}; } catch (e) { appLabels = {}; }
  appsData = await window.api.appsList(s).catch(() => null) || { ok: false, user: [], system: [], disabled: [] };
  // v2.7.1: пустой ответ — чаще всего pm list не успел по медленному Wi-Fi: одна повторная
  // попытка и ЧЕСТНОЕ сообщение, чтобы страница не выглядела «пустой без причины»
  if (appsData && !(appsData.user || []).length && !(appsData.system || []).length) {
    await new Promise(r => setTimeout(r, 1500));
    const again = await window.api.appsList(s).catch(() => null);
    if (again && ((again.user || []).length || (again.system || []).length)) appsData = again;
  }
  appsRender();
  if (!(appsData.user || []).length && !(appsData.system || []).length) {
    $('#apps-list').innerHTML = '<div class="empty">Телефон не вернул список приложений (медленная сеть или экран телефона заблокирован). Нажмите ↽ «Обновить» вверху страницы.</div>';
  }
  // v2.6: размеры/даты для сортировки — тянем в фоне, потом перерисуем
  const all = Array.from(new Set([...(appsData.user || []), ...(appsData.system || [])]));
  try {
    const m = await window.api.appsMeta(s, all);
    if (m && m.ok) { appsMetaMap = m.meta || {}; if (appsSort !== 'name') appsRender(); }
  } catch (e) {}
}
function avatarColor(pkg) {
  let h = 0; for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 'hsl(' + (h % 360) + ',55%,45%)';
}
// человеческое имя: из APK, иначе аккуратная beautification пакета (F11)
function appDisplay(pkg) {
  if (state.config.showPkgNames) return pkg;
  const l = appLabels[pkg];
  if (l) return l;
  const short = pkg.replace(/^(com|org|net|ru|io|de|fr|it|pl|uk|cn)\./, '').replace(/[^\w.\-]+/g, '');
  const parts = short.split('.').filter(Boolean);
  const base = (parts[parts.length - 1] || short).replace(/[_\-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : pkg;
}
function appSub(pkg) {
  if (state.config.showPkgNames) return appLabels[pkg] || '';
  return pkg;
}
// v2.7.2: вкладка процессов — по умолчанию ТОЛЬКО ПОЛЬЗОВАТЕЛЬСКИЕ приложения (жалоба:
// «почему не пользовательские приложения — должны отображаться только нестандартные»),
// список пользовательских пакетов берётся из `pm list packages -3` (флаг user из main).
// Иконки — из кэша (apps:icon-peek — без скачивания APK); если иконки нет — зелёный робот.
let procTab = 'user';
let procIconsRendered = new Set();
function app_kill_text(kn) {
  return kn.includes('.')
    ? 'Остановить приложение ' + kn + ' целиком (все его процессы)? Приложение исчезнет из списка и реально закроется.'
    : 'Убить процесс ' + kn + '? Системному процессу shell не имеет права — может не получиться.';
}
async function procsRender() {
  const s = currentSerial(); if (!s) return;
  const r = await window.api.procsList(s);
  const q = ($('#apps-search').value || '').toLowerCase();
  const isApp = x => (x.user != null) ? x.user : /^(com|org|net|ru|io)\./.test(x.name);
  let items = (r.items || []).slice();
  if (procTab === 'user') items = items.filter(x => isApp(x));
  // v2.6: приложения — наверх; сортировка из селекта (имя/память)
  if (appsSort === 'mem_desc') items.sort((a, b) => (isApp(b) - isApp(a)) || (b.rss - a.rss));
  else items.sort((a, b) => (isApp(b) - isApp(a)) || a.name.localeCompare(b.name));
  if (q) items = items.filter(x => x.name.toLowerCase().includes(q));
  const D = window.PROCDESC || [], FB = window.PROC_FALLBACK || '';
  const descFor = (name) => {
    for (const rule of D) { try { if (new RegExp(rule.re).test(name)) return rule.d; } catch (e) {} }
    return FB;
  };
  const appCount = items.filter(isApp).length;
  // v2.7.2: чипы фильтра — «Пользовательские приложения» (по умолчанию) и «Все процессы»
  $('#apps-counts').innerHTML = '<button class="chip' + (procTab === 'user' ? ' view-chip active' : '') + '" id="proc-tab-user" data-tip="Только УСТАНОВЛЕННЫЕ Вами приложения (pm list -3) — системные службы Android скрыты">Пользовательские приложения</button>' +
    '<button class="chip' + (procTab === 'all' ? ' view-chip active' : '') + '" id="proc-tab-all" data-tip="Показать все процессы — и приложения, и системные службы">Все процессы</button>' +
    '<span class="count-chip">Показано: <b>' + items.length + '</b></span>' +
    '<span class="count-chip cc-user">Приложений: <b>' + appCount + '</b></span>';
  const tabAll = document.getElementById('proc-tab-all'), tabUser = document.getElementById('proc-tab-user');
  if (tabAll) tabAll.onclick = () => { procTab = 'all'; procsRender(); };
  if (tabUser) tabUser.onclick = () => { procTab = 'user'; procsRender(); };
  $('#btn-killall-procs').classList.remove('hidden');
  $('#apps-list').innerHTML = items.slice(0, 400).map(x => {
    const app = isApp(x);
    const d = descFor(x.name);
    const safeId = 'pico-' + x.name.replace(/[^a-z0-9]/gi, '_') + '-' + x.pid;
    return `<div class="list-row proc-row">
      <span class="proc-ico-wrap" id="${safeId}" data-tip="${app ? 'Иконка приложения — берётся из кэша APK' : 'Системная служба Android'}">${app
        ? '<img class="proc-android" src="' + window.FSICONS.ANDROID_BADGE + '" alt="">'
        : '<span class="proc-gear">⚙</span>'}</span>
      <span class="mono muted proc-pid">${x.pid}</span>
      <span class="proc-main grow2"><span class="proc-name">${esc(x.name)}</span><span class="proc-desc muted small">${esc(d)}</span></span>
      <span class="muted small proc-rss" data-tip="Память, занятая процессом">${x.rss ? fmtBytes(x.rss * 1024) : '—'}</span>
      ${app ? '<span class="st-chip st-online proc-kind" data-tip="Это процесс приложения">приложение</span>' : '<span class="st-chip st-off proc-kind" data-tip="Системная служба Android — трогать не стоит">система</span>'}
      <button class="btn btn-text btn-sm" data-kill="${x.pid}" data-kname="${esc(x.name)}" data-tip="${app ? 'Остановить приложение ЦЕЛИКОМ (am force-stop) — закроет все его процессы и исчезнет из списка' : 'Принудительно остановить процесс (kill -9)'}">Убить</button>
    </div>`;
  }).join('') || '<div class="empty">Нет процессов</div>';
  $$('#apps-list [data-kill]').forEach(b => b.onclick = async () => {
    const kn = b.dataset.kname || ('PID ' + b.dataset.kill);
    // v2.8.0: подтверждение с галочкой «Больше не спрашивать» — запоминается навсегда
    const yes = await confirmOnce('confirm.kill', 'Завершить', app_kill_text(kn) + ' (галочку можно поставить один раз — дальше будет останавливать сразу)');
    if (!yes || !yes.ok) return;
    b.disabled = true; b.textContent = '…';
    const res = await window.api.procsKill(s, +b.dataset.kill, b.dataset.kname || '');
    if (res.ok) {
      // v2.7.2: строка уходит из списка СРАЗУ, фоново подтверждаем перечитыванием
      const row = b.closest('.list-row'); if (row) row.remove();
      snack('Остановлено: ' + kn);
      procsRender();
    } else {
      b.disabled = false; b.textContent = 'Убить';
      snack('Не удалось остановить: ' + (res.message || res.error || 'ошибка'));
    }
  });
  // v2.7.0: иконки процессов из кэша (без скачивания APK); не найдено — остаётся робот/шестерёнка
  procIconsRendered.clear();
  for (const x of items.slice(0, 120).filter(isApp)) {
    const id = 'pico-' + x.name.replace(/[^a-z0-9]/gi, '_') + '-' + x.pid;
    if (procIconsRendered.has(x.name)) continue;
    procIconsRendered.add(x.name);
    window.api.appsIconPeek(x.name).then(rr => {
      if (rr && rr.ok && rr.dataUrl) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<img src="' + rr.dataUrl + '" style="width:24px;height:24px;border-radius:7px;display:block;object-fit:contain" alt="">';
      }
    }).catch(() => {});
  }
}
// v2.8.0: АВТООБНОВЛЕНИЕ процессов каждые 3 секунды, пока вкладка открыта — запустил приложение
// на телефоне, и оно САМО появляется в списке (раньше надо было переключать вкладки)
let procAutoTimer = null;
let procAutoBusy = false;
function procAutoStart() {
  if (procAutoTimer) return;
  procAutoTimer = setInterval(async () => {
    if (procAutoBusy || document.hidden) return;
    if (appsTab !== 'procs' || !$('#page-apps').classList.contains('active')) return;
    procAutoBusy = true;
    try { await procsRender(); } catch (e) {}
    procAutoBusy = false;
  }, 3000);
}
function appsRender() {
  if (!appsData) return;
  if (appsTab === 'procs') { procsRender(); procAutoStart(); return; }
  $('#btn-killall-procs').classList.add('hidden');
  const q = ($('#apps-search').value || '').toLowerCase();
  let list;
  if (appsTab === 'all') {
    // v2.6: категория «ВСЕ» — пользовательские и системные в одном месте
    const seen = new Set(); list = [];
    for (const p of [...(appsData.user || []), ...(appsData.system || [])]) {
      if (seen.has(p)) continue; seen.add(p); list.push(p);
    }
  } else {
    list = appsData[appsTab] || [];
    if (appsTab === 'system') list = list.filter(p => !appsData.disabled.includes(p));
  }
  if (q) list = list.filter(p => p.includes(q) || appDisplay(p).toLowerCase().includes(q));
  // v2.6: сортировка — алфавит / размер / дата (мета подтягивается из apps:meta)
  const metaOf = p => appsMetaMap[p] || null;
  const cmpName = (a, b) => appDisplay(a).localeCompare(appDisplay(b), 'ru');
  if (appsSort === 'size_desc') list = list.slice().sort((a, b) => ((metaOf(b) || {}).size || 0) - ((metaOf(a) || {}).size || 0) || cmpName(a, b));
  else if (appsSort === 'size_asc') list = list.slice().sort((a, b) => ((metaOf(a) || {}).size || 0) - ((metaOf(b) || {}).size || 0) || cmpName(a, b));
  else if (appsSort === 'date_desc') list = list.slice().sort((a, b) => ((metaOf(b) || {}).mtime || 0) - ((metaOf(a) || {}).mtime || 0) || cmpName(a, b));
  else if (appsSort === 'date_asc') list = list.slice().sort((a, b) => ((metaOf(a) || {}).mtime || 0) - ((metaOf(b) || {}).mtime || 0) || cmpName(a, b));
  else list = list.slice().sort(cmpName);
  // v2.6: ОДИН компактный счётчик вместо четырёх дублирующих полей (F14 упрощён)
  const cnt = {
    all: new Set([...(appsData.user || []), ...(appsData.system || [])]).size,
    user: (appsData.user || []).length,
    system: (appsData.system || []).length,
    disabled: (appsData.disabled || []).length
  };
  const tabLabel = { all: 'Всего', user: 'Пользовательских', system: 'Системных', disabled: 'Отключённых' }[appsTab];
  $('#apps-counts').innerHTML = '<span class="count-chip">' + tabLabel + ': <b>' + (cnt[appsTab] || 0) + '</b></span>' +
    (appsSort !== 'name' && !Object.keys(appsMetaMap).length ? '<span class="muted small">загружаю размеры…</span>' : '');
  $('#apps-list').innerHTML = list.slice(0, 500).map(p => {
    const dis = appsData.disabled.includes(p);
    const shown = appDisplay(p);
    const sub = appSub(p);
    return `<div class="list-row">
      <input type="checkbox" data-bak="${esc(p)}" data-tip="Выбрать для резервной копии">
      <span class="avatar" style="background:${avatarColor(p)}" id="av-${esc(p).replace(/[^a-z0-9]/gi, '_')}">${esc(shown.charAt(0).toUpperCase())}</span>
      <span class="grow2 app-line"><span class="app-name">${esc(shown)}</span>${dis ? ' <span class="muted">(отключено)</span>' : ''}${sub && sub !== shown ? '<span class="app-pkg muted small">' + esc(sub) + '</span>' : ''}</span>
      ${sortMetaInfo(p)}
      ${dis ? '' : '<button class="btn btn-text btn-sm" data-apprun="' + esc(p) + '" data-tip="Запустить приложение на телефоне прямо сейчас">▶</button>'}
      <button class="btn btn-tonal btn-sm" data-appinfo="${esc(p)}">Свойства</button>
    </div>`;
  }).join('') || '<div class="empty">Ничего не найдено</div>';
  $$('#apps-list [data-appinfo]').forEach(b => b.onclick = () => openAppInfo(b.dataset.appinfo));
  // v2.8.0: «Запустить» прямо из списка — команда уходит на телефон, приложение открывается там
  $$('#apps-list [data-apprun]').forEach(b => b.onclick = async () => {
    const r = await window.api.appsRun(currentSerial(), b.dataset.apprun);
    snack(r.ok ? 'Запущено на телефоне: ' + appDisplay(b.dataset.apprun) : 'Не удалось запустить: ' + (r.message || r.error || ''));
  });
  queueIcons(list.slice(0, 80));
}
// v2.6: при сортировке по размеру/дате показываем значение в строке
function sortMetaInfo(p) {
  const m = appsMetaMap[p];
  if (!m || appsSort === 'name') return '';
  if (appsSort.startsWith('size')) return '<span class="muted small" style="flex:0 0 84px;text-align:right">' + fmtBytes(m.size || 0) + '</span>';
  if (appsSort.startsWith('date')) return '<span class="muted small" style="flex:0 0 110px;text-align:right">' + (m.mtime ? fmtTs(m.mtime) : '—') + '</span>';
  return '';
}

/* очередь родных иконок + имён: параллельность 3, негативный кэш в main, фолбэк — буква-аватар (R12/F11).
   W5-ревизор: inFlight-множество — повторный рендер списка не запускает ВТОРОЙ pull того же APK */
const iconQueue = [];
let iconRunning = 0;
const iconInFlight = new Set();
const ICON_CONCURRENCY = 3;
function queueIcons(pkgs) {
  iconQueue.length = 0;
  iconQueue.push(...pkgs);
  for (let i = 0; i < ICON_CONCURRENCY; i++) iconPump();
}
function iconPump() {
  if (iconRunning >= ICON_CONCURRENCY) return;
  const pkg = iconQueue.shift();
  if (!pkg) return;
  if (iconInFlight.has(pkg)) { iconPump(); return; }
  iconRunning++;
  iconInFlight.add(pkg);
  const el = document.getElementById('av-' + pkg.replace(/[^a-z0-9]/gi, '_'));
  if (!el || el.dataset.loaded) { iconRunning--; iconInFlight.delete(pkg); iconPump(); return; }
  window.api.appsIcon(currentSerial(), pkg).then(r => {
    iconRunning--;
    iconInFlight.delete(pkg);
    if (r && r.label && appLabels[pkg] !== r.label) {
      appLabels[pkg] = r.label;
      // обновляем надпись строки, если ещё показываем старую beautification
      const line = document.querySelector('#apps-list [data-appinfo="' + (window.CSS && window.CSS.escape ? window.CSS.escape(pkg) : pkg) + '"]');
      if (line) { const row = line.closest('.list-row'); if (row) { const nm = row.querySelector('.app-name'); const pk = row.querySelector('.app-pkg'); if (nm && !state.config.showPkgNames) nm.textContent = r.label; if (pk) pk.textContent = state.config.showPkgNames ? (appLabels[pkg] || '') : pkg; } }
    }
    const el2 = document.getElementById('av-' + pkg.replace(/[^a-z0-9]/gi, '_'));
    if (r && r.ok && el2) {
      el2.dataset.loaded = '1';
      const img = document.createElement('img');
      img.src = r.dataUrl;
      img.alt = '';
      img.style.cssText = 'width:30px;height:30px;border-radius:8px;display:block';
      img.onerror = () => { el2.innerHTML = esc(appDisplay(pkg).charAt(0).toUpperCase()); el2.style.background = avatarColor(pkg); };
      el2.innerHTML = '';
      el2.appendChild(img);
      el2.style.background = 'transparent';
    }
    // неудача: остаётся аккуратная буква-аватар — «сломанной картинки» не бывает (R12)
    iconPump();
  }).catch(() => { iconRunning--; iconInFlight.delete(pkg); iconPump(); });
}

$$('[data-apptab]').forEach(t => t.onclick = () => {
  $$('[data-apptab]').forEach(x => x.classList.toggle('active', x === t));
  appsTab = t.dataset.apptab; appsRender();
});
$('#apps-sort').onchange = () => { appsSort = $('#apps-sort').value; appsRender(); };
// v2.6: «Завершить все приложения» — мягкий am kill всех пользовательских пакетов с процессами
$('#btn-killall-procs').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (!appsData) await appsLoad();
  const userSet = new Set(appsData ? appsData.user || [] : []);
  const r1 = await window.api.procsList(s);
  const running = (r1.items || []).map(x => x.name).filter(n => userSet.has(n));
  if (!running.length) return snack('Процессов пользовательских приложений сейчас нет');
  const yes = await uiConfirm('Завершить все приложения', 'Мягко завершить фоновые процессы ' + running.length + ' пользовательских приложений? (am kill — несохранённые данные не страдают, foreground-приложения не трогаем)');
  if (!yes || !yes.ok) return;
  snack('Завершаю ' + running.length + ' приложений…');
  const res = await window.api.procsKillApps(s, running);
  snack('Готово: обработано ' + (res.killed || 0) + ' из ' + (res.total || 0));
  procsRender();
};
$$('#apps-search').length; void 0;
$('#apps-search').oninput = appsRender;
$('#btn-apps-refresh').onclick = appsLoad;
// F11: переключатель «имена приложений ⟷ пакеты» (сохраняется в настройках)
$('#btn-apps-names').onclick = async () => {
  state.config.showPkgNames = !state.config.showPkgNames;
  await window.api.setSetting('showPkgNames', state.config.showPkgNames);
  appsRender();
  snack(state.config.showPkgNames ? 'Показываю имена пакетов' : 'Показываю имена приложений');
};
$('#btn-debloat').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (!appsData) await appsLoad();
  if (!appsData) return;
  const all = new Set([...(appsData.user || []), ...(appsData.system || [])]);
  const rows = DEBLOAT.filter(d => all.has(d.p));
  $('#debloat-list').innerHTML = rows.map(d =>
    `<label class="switch-row"><span class="mono small">${d.p}${d.safe ? '' : ' <span style="color:var(--warn)">(осторожно)</span>'}</span><input type="checkbox" data-deb="${d.p}"></label>`).join('') || '<div class="empty">Совпадений на устройстве не найдено</div>';
  openDlg('dlg-debloat');
};
$('#debloat-apply').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const sel = $$('#debloat-list [data-deb]:checked').map(c => c.dataset.deb);
  if (!sel.length) return snack('Ничего не выбрано');
  const yes = await uiConfirm('Отключение пакетов', 'Отключить ' + sel.length + ' пакет(ов) для текущего пользователя?');
  if (!yes || !yes.ok) return;
  for (const p of sel) await window.api.appsAction(s, 'removeUser', p);
  closeDlg('dlg-debloat'); snack('Готово: ' + sel.length);
  appsLoad();
};

async function openAppInfo(pkg) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  $('#appinfo-title').textContent = appDisplay(pkg);
  $('#appinfo-sub').textContent = pkg;
  $('#appinfo-body').innerHTML = '<div>Загрузка…</div>';
  openDlg('dlg-appinfo');
  const [raw, pathR, perms] = await Promise.all([
    window.api.fsCmd(s, ['dumpsys', 'package', pkg]),
    window.api.fsCmd(s, ['pm', 'path', pkg]),
    window.api.appsPerms(s, pkg)
  ]);
  const t = raw.stdout || '';
  const grab = re => (t.match(re) || [])[1] || '';
  const apk = (pathR.stdout.match(/package:(\S+)/) || [])[1] || '';
  let size = '';
  if (apk) { const st = await window.api.fsCmd(s, ['stat', '-c', '%s', apk]); size = (st.stdout || '').trim(); }
  const rows = [
    ['Версия', grab(/versionName=([\w.\-]+)/) + ' (' + grab(/versionCode=(\d+)/) + ')'],
    ['Путь APK', apk], ['Размер APK', size ? (size / 1048576).toFixed(1) + ' МБ' : '—'],
    ['Установлено', grab(/firstInstallTime=([^\r\n]+)/)],
    ['Обновлено', grab(/lastUpdateTime=([^\r\n]+)/)],
    ['Установщик', grab(/installerPackageName=([\w.]+)/) || '—'],
    ['Каталог данных', grab(/dataDir=([^\r\n]+)/)]
  ];
  $('#appinfo-body').innerHTML = rows.map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1] || '—') + '</div>').join('');
  const pb = $('#appinfo-perms');
  // F12: разрешения — СЕТКОЙ: имя переносится внутри своей колонки, кнопки стоят
  // ровно колонкой справа и никуда не «задвигаются»
  const permsHtml = (perms.perms || []).map((p, i) => `<div class="perm-row">
      <span class="perm-name mono small" data-tip="${esc(p.perm)}">${esc(p.perm)}</span>
      <span class="perm-state ${p.granted ? 'on' : 'off'}">${p.granted ? 'разрешено' : 'запрещено'}</span>
      <button class="btn btn-text btn-sm" data-perm="${i}" data-tip="${p.granted ? 'Отозвать разрешение у приложения (pm revoke)' : 'Выдать разрешение приложению (pm grant)'}">${p.granted ? 'Запретить' : 'Разрешить'}</button>
    </div>`).join('') || '<div class="empty">Разрешений не найдено</div>';
  pb.innerHTML = '<button class="btn btn-tonal btn-sm" id="perms-toggle" style="margin-bottom:8px">Показать разрешения (' + (perms.perms || []).length + ')</button><div id="perms-body" class="hidden"><div class="perm-head"><span>Разрешение</span><span>Состояние</span><span></span></div>' + permsHtml + '</div>';
  pb.querySelector('#perms-toggle').onclick = () => {
    const body = pb.querySelector('#perms-body');
    body.classList.toggle('hidden');
    pb.querySelector('#perms-toggle').textContent = (body.classList.contains('hidden') ? 'Показать' : 'Скрыть') + ' разрешения (' + (perms.perms || []).length + ')';
  };
  pb.querySelectorAll('[data-perm]').forEach(b => b.onclick = async () => {
    const p = perms.perms[+b.dataset.perm];
    const r = await window.api.appsPerm(s, p.granted ? 'revoke' : 'grant', pkg, p.perm);
    snack(r.ok ? 'Обновлено: ' + p.perm : ('Ошибка: ' + (r.message || '')));
    openAppInfo(pkg);
  });
  const dis = (appsData.disabled || []).includes(pkg);
  // F12: понятные подписи + тултип у каждой кнопки; добавлены «Очистить кэш» и
  // «Удалить приложение» (полное удаление вместо прежнего загадочного «Удалить (юзер)»)
  $('#appinfo-title').textContent = appDisplay(pkg);
  $('#appinfo-sub').textContent = pkg;
  // v2.8.0: + «Запустить» — приложение открывается на телефоне немедленно
  $('#appinfo-actions').innerHTML = `
    ${dis ? '' : '<button class="btn btn-filled btn-sm" data-act="run" data-tip="Запустить приложение на телефоне прямо сейчас">▶ Запустить</button>'}
    <button class="btn btn-tonal btn-sm" data-act="${dis ? 'enable' : 'disable'}" data-tip="${dis ? 'Включить отключённое приложение обратно' : 'Отключить приложение без удаления — его не будет в меню, данные останутся'}">${dis ? 'Включить' : 'Отключить'}</button>
    <button class="btn btn-tonal btn-sm" data-act="clearCache" data-tip="Очистить только кэш приложения, данные и настройки останутся (Android 13+)">Очистить кэш</button>
    <button class="btn btn-tonal btn-sm" data-act="clear" data-tip="Удалить ВСЕ данные приложения: настройки, входы в аккаунты, базы — приложение станет как после установки">Очистить данные</button>
    <button class="btn btn-tonal btn-sm" data-act="forceStop" data-tip="Принудительно закрыть все процессы приложения">Остановить</button>
    ${dis ? '<button class="btn btn-tonal btn-sm" data-act="restore" data-tip="Вернуть отключённое приложение на место">Восстановить</button>' : ''}
    <button class="btn btn-tonal btn-sm btn-danger-tonal" data-act="uninstall" data-tip="Полностью УДАЛИТЬ приложение с телефона (для всех пользователей)">Удалить приложение</button>
    <button class="btn btn-text btn-sm" data-close="dlg-appinfo">Закрыть</button>`;
  $$('#appinfo-actions [data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    // v2.8.0: владелец попросил БЕЗ внешних окон: «нажал очистить или удалить — значит сразу
    // выполняет». Единственное подтверждение, которое осталось — ПОЛНОЕ удаление, и то с
    // галочкой «Больше не спрашивать» (один раз — дальше сразу).
    const confirmMap = {
      uninstall: () => confirmOnce('confirm.uninstall', 'Удаление приложения', 'ПОЛНОСТЬЮ удалить приложение ' + pkg + ' с телефона?'),
      removeUser: () => confirmOnce('confirm.removeUser', 'Удаление приложения', 'Удалить приложение ' + pkg + ' для текущего пользователя? (данные останутся, можно восстановить)')
    };
    if (confirmMap[act]) {
      const yes = await confirmMap[act]();
      if (!yes || !yes.ok) return;
    }
    b.disabled = true; b.textContent = '…';
    let r;
    if (act === 'run') r = await window.api.appsRun(s, pkg);
    else r = await window.api.appsAction(s, act, pkg);
    b.disabled = false; b.textContent = act === 'run' ? '▶ Запустить' : ({ clear: 'Очистить данные', clearCache: 'Очистить кэш', disable: 'Отключить', enable: 'Включить', forceStop: 'Остановить', uninstall: 'Удалить приложение', restore: 'Восстановить', removeUser: 'Удалить (юзер)' }[act] || 'Выполнить');
    snack(r.ok ? (act === 'run' ? 'Запущено на телефоне' : 'Готово: ' + (act === 'uninstall' ? 'приложение удалено' : '')) : ('Ошибка: ' + (r.message || r.error || '')));
    if (r.ok && (act === 'uninstall' || act === 'removeUser')) { closeDlg('dlg-appinfo'); appsLoad(); return; }
    if (r.ok && act !== 'clearCache' && act !== 'run') { closeDlg('dlg-appinfo'); appsLoad(); return; }
    if (r.ok && act === 'clearCache') openAppInfo(pkg);
  });
  $$('#appinfo-actions [data-close]').forEach(b => b.onclick = () => closeDlg('dlg-appinfo'));
}

$('#btn-apps-backup').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const sel = $$('#apps-list [data-bak]:checked').map(c => c.dataset.bak);
  if (!sel.length) return snack('Отметьте приложения галочками');
  snack('Копирую ' + sel.length + ' APK…');
  const r = await window.api.appsBackup(s, sel);
  if (r.ok) snack('Сохранено ' + r.done + ' из ' + r.total + ' в ' + r.dir);
};

/* ---------- настройки ---------- */
$('#btn-pick-adb').onclick = async () => {
  const arr = await window.api.pickFile({ properties: ['openFile'], filters: [{ name: 'adb.exe', extensions: ['exe'] }] });
  const f = Array.isArray(arr) ? arr[0] : arr;
  if (f) { $('#set-adb-path').value = f; await window.api.setSetting('adbPath', f); await refreshAdbStatus(); }
};
$('#btn-pick-scrcpy').onclick = async () => {
  const arr = await window.api.pickFile({ properties: ['openFile'], filters: [{ name: 'scrcpy.exe', extensions: ['exe'] }] });
  const f = Array.isArray(arr) ? arr[0] : arr;
  if (f) { $('#set-scrcpy-path').value = f; await window.api.setSetting('scrcpyPath', f); }
};
$('#set-adb-path').onchange = async e => { await window.api.setSetting('adbPath', e.target.value || null); await refreshAdbStatus(); };
$('#set-scrcpy-path').onchange = async e => { await window.api.setSetting('scrcpyPath', e.target.value || null); };
$('#set-autostart').onchange = async e => {
  const r = await window.api.setSetting('autostart', e.target.checked);
  if (!r.ok) { snack(r.message || 'Не удалось изменить автостарт'); e.target.checked = !e.target.checked; }
};
$('#set-tray').onchange = e => window.api.setSetting('closeToTray', e.target.checked);
$('#set-autoreconnect').onchange = e => window.api.setSetting('autoreconnect', e.target.checked);
$('#set-scanstart').onchange = e => window.api.setSetting('scanOnStart', e.target.checked);
$('#set-sounds').onchange = e => { snd.on = e.target.checked; window.api.setSetting('sounds', e.target.checked); };
$('#set-autolast').onchange = e => window.api.setSetting('autolast', e.target.checked);
$('#set-theme').onchange = e => { document.body.dataset.theme = e.target.value; window.api.setSetting('theme', e.target.value); };
/* ---------- v2.6: ассоциации файлов APK (реестр Windows, HKCU) ---------- */
const ASSOC_EXTS_UI = ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apk.1', 'apk+', 'apup', 'apks.zip', 'apk.zip'];
async function assocRefresh() {
  const r = await window.api.assocGet().catch(() => null);
  const on = r && r.state && Object.values(r.state).some(Boolean);
  $('#set-assoc').checked = !!on;
  $('#assoc-exts').innerHTML = ASSOC_EXTS_UI.map(x => {
    const key = x.replace(/\./g, '.');
    const isOn = r && r.state && r.state[x];
    return `<span class="assoc-ext ${isOn ? 'on' : ''}">${esc(x)}</span>`;
  }).join('');
  $('#assoc-note').textContent = (r && r.note) || '';
}
$('#set-assoc').onchange = async e => {
  const on = e.target.checked;
  const r = await window.api.assocSet(on);
  if (!r || !r.ok) { snack('Не удалось изменить ассоциации: ' + ((r && r.errors && r.errors[0]) || 'ошибка')); e.target.checked = !on; }
  else snack(on ? 'Ассоциации включены: файлы APK открываются двойным кликом (может понадобиться перезапуск Проводника)' : 'Ассоциации отключены');
  assocRefresh();
};
$('#btn-open-data').onclick = () => window.api.openExternal('file://' + savesDir);
$('#btn-about').onclick = () => openDlg('dlg-about');

/* ui-логирование: в журнал (только ошибки) пишут снэкбары с ошибками и необработанные
   исключения из preload.js — отладочный лог ВСЕХ кликов удалён: в app.log не должно быть
   ничего, кроме ошибок (F19) */

/* ---------- события из main ---------- */
window.api.onTask(async ev => {
  if (ev.kind === 'scan-progress') {
    const pct = Math.round(ev.done / ev.total * 100);
    $('#scan-card').classList.remove('scanning-done');
    $('#scan-progress').classList.remove('hidden');
    $('#scan-bar').style.width = pct + '%';
    $('#scan-progress-text').textContent = pct + '%';
  } else if (ev.kind === 'scan-done') {
    // F18: после завершения скана полоса прогресса больше не «висит в ожидании» —
    // сворачиваем её и показываем итог
    $('#scan-bar').style.width = '100%';
    $('#scan-progress-text').textContent = 'готово, найдено: ' + ev.count;
    $('#scan-card').classList.add('scanning-done');
    setTimeout(() => { if ($('#scan-progress')) $('#scan-progress').classList.add('hidden'); }, 900);
  } else if (ev.kind === 'scan-request') {
    goPage('devices');
    $('#btn-scan').click();
  } else if (ev.kind === 'pair-log') {
    $('#pair-log').textContent += ev.text;
    $('#pair-log').scrollTop = 99999;
  } else if (ev.kind === 'apk-progress') {
    // легаси-событие старой IPC — UI теперь на новой очереди (apk-queue)
  } else if (ev.kind === 'apk-queue') {
    // v2.6: статусы очереди установки из main
    if (ev.index != null && apkQueue[ev.index]) {
      apkQueue[ev.index].status = ev.stage === 'done' ? 'ok' : ev.stage === 'fail' ? 'fail' : 'run';
      apkQueue[ev.index].msg = ev.message || '';
      apkQRender();
    }
  } else if (ev.kind === 'fsload-progress') {
    // v2.6: прогресс загрузки файла для просмотрщика/плеера
    const mb = ((ev.bytes || 0) / 1048576).toFixed(1);
    const msg = 'Загружено ' + mb + ' МБ…';
    if (!$('#dlg-imgview').classList.contains('hidden')) $('#imgview-msg').textContent = msg;
    if (!$('#dlg-media').classList.contains('hidden') && !mp.isVideo) $('#media-now-sub').textContent = msg;
  } else if (ev.kind === 'apk-meta-progress') {
    // v2.7.2: уведомления «Изучаю приложение…» УБРАНЫ совсем — загрузка иконок идёт тихо
    // в фоне, иконка/имя просто появляются в строке файла (жалоба: «засыпало уведомлениями»)
  } else if (ev.kind === 'open-apk') {
    // v2.6: файл открыт ассоциацией (двойной клик в Проводнике) или передан аргументом
    openApkMini(ev.path);
  } else if (ev.kind === 'refresh-devices') {
    refreshDevices();
    renderApkTargets();
  } else if (ev.kind === 'connected') {
    setActive(ev.host + ':' + ev.port);
    state = await window.api.getState();
    renderHistory(); renderFavorites();
    refreshDevices();
  } else if (ev.kind === 'logcat-stopped') {
    logcatOn = false;
    logcatButtons();
  } else if (ev.kind === 'record-stopped') {
    // запись прервалась сама (лимит 3 мин или died-процесс) — синхронизируем UI и предлагаем сохранить
    clearInterval(recTimer); recTimer = null;
    recordUIReset();
    if (ev.auto && ev.serial && ev.remote) {
      snack('Запись автоматически остановлена (лимит 3 мин). Сохраняю видео с телефона…', 6000);
      const r = await window.api.fsPull(ev.serial, ev.remote);
      if (r.ok) snack('Видео сохранено: ' + r.file);
      window.api.fsCmd(ev.serial, ['rm', '-f', ev.remote]);
    }
  } else if (ev.kind === 'shell-stopped') {
    if (shellOn) {
      shellOn = false;
      $('#shell-view').textContent += '\n[сессия остановлена]\n';
    }
  } else if (ev.kind === 'qr-status') {
    if (ev.stage === 'listening') qrSetStatus(ev.message || 'Ожидание сканирования…', '');
    else if (ev.stage === 'found' || ev.stage === 'paired' || ev.stage === 'connecting') qrSetStatus(ev.message || '…', '');
    else if (ev.stage === 'connected') {
      qrSetStatus('✓ ' + (ev.message || 'Подключено'), 'ok');
      snd.play('connect');
      state = await window.api.getState();
      renderHistory(); renderFavorites();
      refreshDevices();
      setTimeout(qrHidePanel, 1600);
    }
    else if (ev.stage === 'error') { qrActive = false; qrSetStatus(ev.message || 'Ошибка', 'err'); }
    else if (ev.stage === 'cancelled') { qrActive = false; }
  } else if (ev.kind === 'fs-zip') {
    // v2.8.0: прогресс сборки ZIP-архива
    if (ev.stage === 'run' || ev.stage === 'pack' || ev.stage === 'push') {
      const pct = ev.total ? Math.round((ev.done || 0) / ev.total * 100) : 0;
      snack('Архив: ' + (ev.msg || ev.stage) + (ev.total ? ' (' + (ev.done || 0) + '/' + ev.total + ')' : ''));
      void pct;
    } else if (ev.stage === 'err') snack(ev.msg || 'Часть файлов не вошла в архив', 6000);
  } else if (ev.kind === 'usb-faketest') {
    usbFakeEvent(ev);
  } else if (ev.kind === 'mirror-stopped') {
    // генерационная защита: стоп СТАРОЙ сессии не убивает новую (переключение режимов)
    if (mirrorOn && ev.gen === mirrorGen) {
      mirrorStopUI();
      if (ev.reason === 'device-lost') snack('Трансляция остановлена: устройство недоступно');
    }
  } else if (ev.kind === 'mirror-stalled') {
    scheduleFallback('нет данных 7 с');
  } else if (ev.kind === 'mirror-status') {
    $('#mirror-status').textContent = ev.text || '';
  }
});

/* ---------- v2.7.2: терминал и логcat на «Инструментах» по умолчанию СВЁРНУТЫ ---------- */
(function initCollapsible() {
  const KEY = 'tools.open';
  let openSet = {};
  try { openSet = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  $$('.collapse-card').forEach(card => {
    card.classList.toggle('open', !!openSet[card.id]);
    const head = card.querySelector('.collapse-head');
    if (!head) return;
    head.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      card.classList.toggle('open');
      openSet[card.id] = card.classList.contains('open');
      try { localStorage.setItem(KEY, JSON.stringify(openSet)); } catch (err) {}
    });
  });
})();

/* ---------- навигация и старт ---------- */
function goPage(name) {
  $$('.rail-item').forEach(x => x.classList.toggle('active', x.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  updateToolsState();
  if (name === 'files') {
    // R11: файлы телефона отображаются СРАЗУ, без кнопок «Открыть»/«Открыть память»
    fsRender();
    renderFsVolumes();
    const s = currentSerial();
    if (s && !infoCache[s]) devInfoText(s).then(() => {
      const i = infoCache[s] && infoCache[s].info;
      if (i && i.storage) $('#fs-storage').textContent = 'Внутренняя память /data: занято ' + i.storage.used + ' из ' + i.storage.total + ', свободно ' + i.storage.free;
    });
  }
  if (name === 'apps' && !appsData) appsLoad();
  if (name === 'apk') renderApkTargets();
}

(async function init() {
  renderFsQuick();
  await loadState();
  await renderSaved();
  await refreshDevices();
  initTerminalLib(); // после загрузки конфига: миграция favCmds + свои команды
  const h = location.hash.replace('#', '');
  if (['devices', 'tools', 'settings', 'files', 'apps', 'apk'].includes(h)) goPage(h);
  window.addEventListener('hashchange', () => {
    const p = location.hash.replace('#', '');
    if (['devices', 'tools', 'settings', 'files', 'apps', 'apk'].includes(p)) goPage(p);
  });
  // не опрашиваем adb, пока окно скрыто; при возврате видимости обновляем сразу
  setInterval(() => { if (!document.hidden) refreshDevices(); }, 5000);
  setInterval(pingActive, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDevices(); });
  assocRefresh();       // v2.6: состояние ассоциаций в настройках
  renderApkTargets();   // v2.6: селектор устройств вкладки установки
  if (state.config.scanOnStart) setTimeout(() => $('#btn-scan').click(), 800);
})();

/* горячие клавиши (R14): F5 — обновить устройства, Ctrl+L — фокус в поле IP */
document.addEventListener('keydown', e => {
  if (e.key === 'F5') { e.preventDefault(); refreshDevices(); snack('Список устройств обновлён'); }
  else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); goPage('devices'); $('#in-ip').focus(); }
});
