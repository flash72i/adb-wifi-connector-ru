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
let confirmCb = null, confirmCancelCb = null;
function uiConfirm(title, body) {
  return new Promise(resolve => {
    confirmCb = () => resolve(true);
    confirmCancelCb = () => resolve(false);
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body || '';
    openDlg('dlg-confirm');
  });
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

function logLostActive(serial) { try { window.api.uiLog('active lost: ' + serial); } catch (e) {} }

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
    snack('Подключено: ' + host + ':' + port);
    state = await window.api.getState();
    const ser = host + ':' + port;
    setActive(ser);
    renderHistory(); renderFavorites();
    refreshDevices();
    snd.play('connect');
  } else {
    snack('Не удалось подключиться: ' + (r.message || r.error || 'ошибка'));
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

/* ---------- QR-подключение: ПК показывает код, телефон сканирует камерой (R2) ---------- */
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
  div.textContent = new Date().toLocaleTimeString('ru-RU') + ' — ' + text;
  box.appendChild(div);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
async function qrBegin() {
  $('#btn-qr-retry').classList.add('hidden');
  $('#qr-pc-log').innerHTML = '';
  qrSetStatus('Готовим QR-код…', '');
  const r = await window.api.qrStart();
  if (!r.ok) { qrSetStatus(r.error || 'Не удалось запустить сессию', 'err'); $('#btn-qr-retry').classList.remove('hidden'); return; }
  qrActive = true;
  QRCodeLib.toCanvas($('#qr-pc-canvas'), r.qrText, { width: 260, margin: 1, color: { dark: '#000000', light: '#ffffff' } }, err => {
    if (err) qrSetStatus('Ошибка отрисовки QR: ' + err.message, 'err');
    else qrSetStatus('Ожидание сканирования… Наведите камеру телефона на код, экран сканера не закрывайте.', '');
  });
}
$('#btn-qr-show').onclick = () => { openDlg('dlg-qrpc'); qrBegin(); };
$('#btn-qr-retry').onclick = async () => { await window.api.qrCancel(); qrBegin(); };

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
  // F15: поток живой (байты капают), но кадров нет уже 6 с — декодер «молча» съел поток →
  // уходим в простой режим сами, не дожидаясь, пока владелец устанёт смотреть в чёрный экран
  if (mirrorMode === 'h264' && mirrorLastChunkAt && now - mirrorLastChunkAt < 3000 &&
      mirrorLastFrameAt && now - mirrorLastFrameAt > 6000 && !mirrorFrames) {
    scheduleFallback('данные идут, но ни одного кадра не выдано');
  }
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
      try {
        mirrorDec.decode(new EncodedVideoChunk({ type: type === 5 ? 'key' : 'delta', timestamp: mirrorPts += 33000, data: avcc }));
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
    mirrorDec.configure({ codec, description: avccConfig(mirrorSPS, mirrorPPS), optimizeForLatency: true });
    $('#mirror-status').textContent = 'Трансляция идёт (кодек ' + codec + ')';
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
$('#btn-apk2-pick').onclick = async () => {
  const files = await window.api.pickFile({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Android пакеты', extensions: ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'] }] });
  if (files && files.length) apkAddFiles(files);
};
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
  if (!yes) return;
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
  const ico = ok => ok ? '<span style="color:var(--ok)">&#10004;</span>' : '<span style="color:var(--warn)">&#9888;</span>';
  $('#diag-report').innerHTML =
    rep.sections.map(sec => `<div class="diag-sec"><b>${ico(sec.ok)} ${esc(sec.title)}</b><pre>${esc(sec.lines.join('\n'))}</pre></div>`).join('') +
    (rep.suggestions.length ? `<div class="diag-sugg"><b>Рекомендации</b><pre>${esc(rep.suggestions.map(x => '• ' + x).join('\n'))}</pre></div>` : '');
};

/* ---------- файловый менеджер: файлы видны СРАЗУ (R11); v2.5.0 — F4–F8 ---------- */
let fsDir = '/sdcard';
let fsHist = [];            // история переходов для кнопки «Назад» (F5)
let fsItems = [];           // кэш последнего списка — для просмотрщика/плеера/флешки
let fsFlash = null;         // v2.6: путь смонтированной OTG-флешки (/storage/XXXX-XXXX) или null
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
  box.innerHTML = FS_QUICK.map(q => `<button class="chip" data-qdir="${esc(q.dir)}">${esc(q.label)}</button>`).join('');
  box.querySelectorAll('[data-qdir]').forEach(b => b.onclick = () => fsNavigate(b.dataset.qdir));
}

// навигация С историей: кнопка «Назад» возвращает на предыдущую папку (F5)
function fsNavigate(newDir, { back } = {}) {
  const target = back ? null : fsNormalize(newDir || '/sdcard');
  if (back) {
    const prev = fsHist.pop();
    fsDir = fsNormalize(prev || '/sdcard');
  } else {
    if (target !== fsDir) fsHist.push(fsDir);
    if (fsHist.length > 60) fsHist.shift();
    fsDir = target;
  }
  $('#btn-fs-back').disabled = !fsHist.length;
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
async function fsRender() {
  const seq = ++fsSeq;
  const s = currentSerial();
  const box = $('#fs-list');
  const empty = $('#fs-empty');
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
  const flashBtns = (name) => fsFlash ? (
    onFlash
      ? `<button class="btn btn-text btn-sm" data-fs2phone="${esc(name)}" data-tip="Скопировать на телефон в /sdcard/Download">На телефон</button>
         <button class="btn btn-text btn-sm" data-fs2phonemv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на телефон в /sdcard/Download">На телефон ✂</button>`
      : `<button class="btn btn-text btn-sm" data-fs2flash="${esc(name)}" data-tip="Скопировать на флешку (${esc(fsFlash)})">На флешку</button>
         <button class="btn btn-text btn-sm" data-fs2flashmv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на флешку (${esc(fsFlash)})">На флешку ✂</button>`
  ) : '';
  box.innerHTML = items.map((it, i) => {
    const ic = window.FSICONS.iconFor(it.name, it.dir);
    const media = !it.dir && (IMG_RE.test(it.name) || VID_RE.test(it.name) || AUD_RE.test(it.name));
    return `<div class="list-row fs-row">
      <img class="fs-ico" src="${ic.src}" alt="" data-fsopen-i="${i}">
      <span class="mono grow2 fs-name" data-fsopen="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-fs-i="${i}" style="cursor:pointer" data-tip="${it.dir ? 'Открыть папку' : (media ? 'Открыть в просмотрщике/плеере' : 'Двойной клик — свойства')}">${esc(it.name)}</span>
      <span class="muted fs-size">${it.dir ? '' : fmtBytes(it.size)}</span>
      <span class="muted fs-date">${esc(it.date || '')}</span>
      <button class="btn btn-text btn-sm" data-fsprop="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-tip="Свойства: размер, дата, права доступа, содержимое">Свойства</button>
      ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsget="' + esc(it.name) + '" data-tip="Скачать файл с телефона на компьютер">Скачать</button>'}
      ${flashBtns(it.name)}
      <button class="btn btn-text btn-sm" data-fsdel="${esc(it.name)}" data-tip="Удалить с телефона (папки — с содержимым)">Удалить</button>
    </div>`;
  }).join('') || '<div class="empty">Папка пуста</div>';
  const byIdx = i => items[i];
  const openItem = (it) => {
    if (it.dir) return fsNavigate(fsDir.replace(/\/+$/, '') + '/' + it.name);
    const full = fsDir.replace(/\/+$/, '') + '/' + it.name;
    if (IMG_RE.test(it.name)) openImgViewer(full);
    else if (VID_RE.test(it.name) || AUD_RE.test(it.name)) openMediaPlayer(full);
    else openFsProps(it);
  };
  box.querySelectorAll('[data-fsopen]').forEach(el => el.onclick = () => openItem(byIdx(+el.dataset.fsI)));
  box.querySelectorAll('[data-fsopen-i]').forEach(el => el.onclick = () => openItem(byIdx(+el.dataset.fsopenI)));
  box.querySelectorAll('[data-fsprop]').forEach(b => b.onclick = () => openFsProps(byIdx(+b.closest('.fs-row').querySelector('[data-fs-i]').dataset.fsI)));
  box.querySelectorAll('[data-fsget]').forEach(b => b.onclick = async () => {
    snack('Скачиваю ' + b.dataset.fsget + '…');
    const res = await window.api.fsPull(s, fsDir.replace(/\/+$/, '') + '/' + b.dataset.fsget);
    if (res.ok) snack('Сохранено: ' + res.file);
  });
  // v2.6: копирование/перемещение телефон ⟷ флешка (только когда флешка вставлена)
  const flashTarget = () => {
    if (onFlash) return '/sdcard/Download';
    // на флешке кладём в такую же подпапку, если она там есть, иначе в корень флешки
    const rel = fsDir === fsFlash ? '' : fsDir.slice(fsFlash.length).replace(/^\/+/, '');
    return fsFlash + (rel ? '/' + rel : '');
  };
  const phoneTarget = () => '/sdcard/Download';
  const doTransfer = async (name, mv) => {
    const src = fsDir.replace(/\/+$/, '') + '/' + name;
    const dstDir = onFlash ? phoneTarget() : flashTarget();
    const verb = mv ? 'Перемещаю' : 'Копирую';
    snack(verb + ' ' + name + ' → ' + dstDir + '…');
    await window.api.fsCmd(s, ['mkdir', '-p', dstDir]);
    const r = await window.api.fsCmd(s, [mv ? 'mv' : 'cp', '-r', src, dstDir]);
    if (r.ok || /exists|such file/i.test(r.stdout || '')) snack((mv ? 'Перемещено: ' : 'Скопировано: ') + name + ' → ' + dstDir);
    else snack('Не удалось: ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 120)));
    fsRender();
  };
  box.querySelectorAll('[data-fs2flash]').forEach(b => b.onclick = () => doTransfer(b.dataset.fs2flash, false));
  box.querySelectorAll('[data-fs2flashmv]').forEach(b => b.onclick = () => doTransfer(b.dataset.fs2flashmv, true));
  box.querySelectorAll('[data-fs2phone]').forEach(b => b.onclick = () => doTransfer(b.dataset.fs2phone, false));
  box.querySelectorAll('[data-fs2phonemv]').forEach(b => b.onclick = () => doTransfer(b.dataset.fs2phonemv, true));
  box.querySelectorAll('[data-fsdel]').forEach(b => b.onclick = async () => {
    const yes = await uiConfirm('Удаление', 'Удалить ' + b.dataset.fsdel + ' с устройства? (папки — с содержимым)');
    if (!yes) return;
    await window.api.fsCmd(s, ['rm', '-rf', fsDir.replace(/\/+$/, '') + '/' + b.dataset.fsdel]);
    fsRender(); snack('Удалено');
  });
}

/* свойства файла/папки (F6) */
async function openFsProps(it) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  const full = (fsDir.replace(/\/+$/, '') + '/' + it.name);
  const ic = window.FSICONS.iconFor(it.name, it.dir);
  $('#fsprop-icon').src = ic.src;
  $('#fsprop-title').textContent = it.name;
  $('#fsprop-body').innerHTML = '<div class="muted">Читаю свойства…</div>';
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
    return `<button class="chip vol-chip" data-vol="${esc(v)}" data-tip="Открыть флешку: /storage/${esc(v)}">
      <img src="${ico}" alt="">Флешка ${esc(v)}</button>`;
  }).join('') +
    (fsFlash ? '<span class="muted small" data-tip="Кнопки «На флешку»/«На телефон» появляются у файлов, когда флешка вставлена">обмен телефон ⟷ флешка включён</span>' : '');
  box.querySelectorAll('[data-vol]').forEach(b => b.onclick = () => fsNavigate('/storage/' + b.dataset.vol));
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
  const r = await window.api.fsCat(s, full);
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
async function openImgViewer(full) {
  iv.list = ivImageList();
  const name = full.split('/').pop();
  iv.idx = Math.max(0, iv.list.findIndex(x => x.name === name));
  $('#imgview-title').textContent = name;
  $('#imgview-pos').textContent = iv.list.length ? (iv.idx + 1) + '/' + iv.list.length : '';
  iv.scale = 1; iv.tx = 0; iv.ty = 0; iv.rot = 0; ivApply();
  openDlg('dlg-imgview');
  ivLoad(full);
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
})();

/* ---------- v2.6: медиаплеер (видео+аудио) с 10-полосным эквалайзером и визуализацией ---------- */
const mp = {
  list: [], idx: 0, isVideo: false,
  ctx: null, src: null, analyser: null, filters: [], out: null,
  visMode: 'bars', raf: 0, loadedUrl: null, wantPlay: true
};
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
function mpDraw() {
  if ($('#dlg-media').classList.contains('hidden')) { mp.raf = 0; return; }
  mp.raf = requestAnimationFrame(mpDraw);
  const cv = $('#media-vis'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let bass = 0;
  if (mp.analyser) {
    const n = mp.analyser.frequencyBinCount;
    const fd = new Uint8Array(n), td = new Uint8Array(n);
    mp.analyser.getByteFrequencyData(fd);
    mp.analyser.getByteTimeDomainData(td);
    for (let i = 0; i < 8; i++) bass += fd[i];
    bass = bass / (8 * 255);
    const playing = !$('#media-el').paused;
    if (mp.visMode === 'bars') {
      const bars = 48, step = Math.floor(n / bars);
      for (let i = 0; i < bars; i++) {
        let v = 0; for (let k = 0; k < step; k++) v = Math.max(v, fd[i * step + k]);
        const h = (v / 255) * (H - 18) + 2;
        const x = i * (W / bars) + 2, w = W / bars - 3;
        const g = ctx.createLinearGradient(0, H, 0, H - h);
        g.addColorStop(0, '#1976d2'); g.addColorStop(0.6, '#4fc3f7'); g.addColorStop(1, '#b388ff');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.roundRect(x, H - h, w, h, 3); ctx.fill();
      }
    } else if (mp.visMode === 'wave') {
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#4fc3f7';
      ctx.shadowColor = 'rgba(79,195,247,.8)'; ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1) * W;
        const y = H / 2 + ((td[i] - 128) / 128) * (H / 2 - 8);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke(); ctx.shadowBlur = 0;
    } else {
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.28 + bass * 40;
      ctx.lineWidth = 2;
      for (let i = 0; i < 72; i++) {
        const v = fd[i * 2] / 255;
        const a = (i / 72) * Math.PI * 2;
        const r1 = R + 6, r2 = R + 6 + v * 70;
        ctx.strokeStyle = `hsl(${200 + v * 90}, 80%, ${45 + v * 25}%)`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(79,195,247,.55)'; ctx.stroke();
    }
    // 3D-куб подпрыгивает в такт басам
    const cube = $('#media-3dwrap');
    if (cube) cube.style.transform = `scale(${(1 + bass * 0.35).toFixed(3)}) translateY(${(-bass * 10).toFixed(1)}px)`;
  }
}
async function mpLoad(full) {
  const s = currentSerial(); if (!s) return;
  const el = $('#media-el');
  const name = full.split('/').pop();
  mp.isVideo = VID_RE.test(name);
  $('#media-title').textContent = name;
  $('#media-now-name').textContent = name;
  $('#media-now-sub').textContent = 'Загрузка с устройства…';
  $('#media-status').textContent = full;
  const visual = $('#media-visual');
  visual.classList.toggle('hidden-when-video', mp.isVideo);
  el.classList.toggle('hidden', !mp.isVideo);
  const r = await window.api.fsCat(s, full);
  if (!r.ok) { $('#media-now-sub').textContent = r.error || 'Не удалось загрузить'; return; }
  if (mp.loadedUrl) { try { URL.revokeObjectURL(mp.loadedUrl); } catch (e) {} }
  const mime = mp.isVideo
    ? (/webm$/i.test(name) ? 'video/webm' : (/mkv|avi|ts$/i.test(name) ? 'video/x-matroska' : 'video/mp4'))
    : (/ogg|opus|oga$/i.test(name) ? 'audio/ogg' : /flac$/i.test(name) ? 'audio/flac' : /wav$/i.test(name) ? 'audio/wav' : /aac$/i.test(name) ? 'audio/aac' : /m4a$/i.test(name) ? 'audio/mp4' : /wma$/i.test(name) ? 'audio/x-ms-wma' : 'audio/mpeg');
  mp.loadedUrl = URL.createObjectURL(new Blob([r.buf], { type: mime }));
  el.src = mp.loadedUrl;
  el.volume = (+$('#media-vol').value || 80) / 100;
  $('#media-now-sub').textContent = (mp.isVideo ? 'Видео' : 'Аудио') + ' · ' + fmtBytesLong(r.bytes || 0);
  mpEnsureAudio();
  if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
  try { await el.play(); } catch (e) {}
}
async function openMediaPlayer(full) {
  mp.list = mediaList();
  const name = full.split('/').pop();
  mp.idx = Math.max(0, mp.list.findIndex(x => x.name === name));
  openDlg('dlg-media');
  mpBuildEq();
  if (!mp.raf) mp.raf = requestAnimationFrame(mpDraw);
  mpLoad(full);
}
function mpNav(d) {
  if (!mp.list.length) return;
  mp.idx = (mp.idx + d + mp.list.length) % mp.list.length;
  mpLoad(fsDir.replace(/\/+$/, '') + '/' + mp.list[mp.idx].name);
}
(function mpEvents() {
  const el = $('#media-el');
  $('#media-play').onclick = async () => {
    if (!el.src) return;
    mpEnsureAudio();
    if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
    el.paused ? el.play() : el.pause();
  };
  el.onplay = () => $('#media-play').textContent = '⏸';
  el.onpause = () => $('#media-play').textContent = '▶';
  el.ontimeupdate = () => {
    $('#media-time').textContent = mpFmtTime(el.currentTime) + ' / ' + mpFmtTime(el.duration);
    if (el.duration) $('#media-seek').value = Math.round(el.currentTime / el.duration * 1000);
  };
  el.onended = () => mpNav(1);
  el.onerror = () => { $('#media-now-sub').textContent = 'Этот формат браузер не играет (например mkv с редким кодеком) — скачайте файл'; };
  $('#media-seek').oninput = () => { if (el.duration) el.currentTime = (+$('#media-seek').value / 1000) * el.duration; };
  $('#media-vol').oninput = () => { el.volume = (+$('#media-vol').value) / 100; };
  $('#media-prev').onclick = () => mpNav(-1);
  $('#media-next').onclick = () => mpNav(1);
  $('#media-eqbtn').onclick = () => { mpEnsureAudio(); $('#media-eq').classList.toggle('hidden'); };
  $('#media-full').onclick = () => $('#dlg-media .media-dlg').classList.toggle('media-full');
  $$('.eq-vchip').forEach(c => c.onclick = () => { $$('.eq-vchip').forEach(x => x.classList.toggle('active', x === c)); mp.visMode = c.dataset.vis; });
  document.addEventListener('keydown', e => {
    if ($('#dlg-media').classList.contains('hidden')) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('#media-play').click(); }
    if (e.key === 'ArrowLeft') mpNav(-1);
    if (e.key === 'ArrowRight') mpNav(1);
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
$('#btn-fs-mkdir').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const name = await askText('Новая папка', 'Имя новой папки:', '');
  if (!name) return;
  await window.api.fsCmd(s, ['mkdir', '-p', fsDir.replace(/\/+$/, '') + '/' + name]);
  fsRender();
};

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
  appsData = await window.api.appsList(s);
  appsRender();
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
async function procsRender() {
  const s = currentSerial(); if (!s) return;
  const r = await window.api.procsList(s);
  const q = ($('#apps-search').value || '').toLowerCase();
  const isApp = x => /^(com|org|net|ru|io)\./.test(x.name);
  let items = (r.items || []).slice();
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
  // v2.6: одна компактная строка статуса + кнопка «Завершить все приложения» (дубли убраны)
  $('#apps-counts').innerHTML = '<span class="count-chip">Процессов: <b>' + items.length + '</b></span>' +
    '<span class="count-chip cc-user">Приложений: <b>' + appCount + '</b></span>' +
    '<span class="muted small">приложения — наверху списка</span>';
  $('#btn-killall-procs').classList.remove('hidden');
  $('#apps-list').innerHTML = items.slice(0, 400).map(x => {
    const isApp = /^com\.|^org\.|^net\.|^ru\./.test(x.name);
    const d = descFor(x.name);
    return `<div class="list-row proc-row">
      <span class="mono muted proc-pid">${x.pid}</span>
      <span class="proc-main grow2"><span class="proc-name">${esc(x.name)}</span><span class="proc-desc muted small">${esc(d)}</span></span>
      <span class="muted small proc-rss" data-tip="Память, занятая процессом">${x.rss ? fmtBytes(x.rss * 1024) : '—'}</span>
      ${isApp ? '<span class="st-chip st-online proc-kind" data-tip="Это процесс приложения">приложение</span>' : '<span class="st-chip st-off proc-kind" data-tip="Системная служба Android — трогать не стоит">система</span>'}
      <button class="btn btn-text btn-sm" data-kill="${x.pid}" data-tip="Принудительно остановить процесс (kill -9). Служба может перезапуститься, приложение — потеряет несохранённое">Убить</button>
    </div>`;
  }).join('') || '<div class="empty">Нет процессов</div>';
  $$('#apps-list [data-kill]').forEach(b => b.onclick = async () => {
    const yes = await uiConfirm('Остановка процесса', 'Убить процесс PID ' + b.dataset.kill + '?');
    if (!yes) return;
    const res = await window.api.procsKill(s, +b.dataset.kill);
    snack(res.ok ? 'Процесс остановлен' : ('Ошибка: ' + (res.message || '')));
    procsRender();
  });
}
function appsRender() {
  if (!appsData) return;
  if (appsTab === 'procs') { procsRender(); return; }
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
      <button class="btn btn-tonal btn-sm" data-appinfo="${esc(p)}">Свойства</button>
    </div>`;
  }).join('') || '<div class="empty">Ничего не найдено</div>';
  $$('#apps-list [data-appinfo]').forEach(b => b.onclick = () => openAppInfo(b.dataset.appinfo));
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
  if (!yes) return;
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
  if (!yes) return;
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
  $('#appinfo-actions').innerHTML = `
    <button class="btn btn-tonal btn-sm" data-act="${dis ? 'enable' : 'disable'}" data-tip="${dis ? 'Включить отключённое приложение обратно' : 'Отключить приложение без удаления — его не будет в меню, данные останутся'}">${dis ? 'Включить' : 'Отключить'}</button>
    <button class="btn btn-tonal btn-sm" data-act="clearCache" data-tip="Очистить только кэш приложения, данные и настройки останутся (Android 13+)">Очистить кэш</button>
    <button class="btn btn-tonal btn-sm" data-act="clear" data-tip="Удалить ВСЕ данные приложения: настройки, входы в аккаунты, базы — приложение станет как после установки">Очистить данные</button>
    <button class="btn btn-tonal btn-sm" data-act="forceStop" data-tip="Принудительно закрыть все процессы приложения">Остановить</button>
    ${dis ? '<button class="btn btn-tonal btn-sm" data-act="restore" data-tip="Вернуть отключённое приложение на место">Восстановить</button>' : ''}
    <button class="btn btn-tonal btn-sm btn-danger-tonal" data-act="uninstall" data-tip="Полностью УДАЛИТЬ приложение с телефона (для всех пользователей)">Удалить приложение</button>
    <button class="btn btn-text btn-sm" data-close="dlg-appinfo">Закрыть</button>`;
  $$('#appinfo-actions [data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    const confirmMap = {
      clear: 'Удалить ВСЕ данные приложения ' + pkg + '? Входы в аккаунты и настройки будут потеряны.',
      clearCache: 'Очистить кэш приложения ' + pkg + '? (данные не затрагиваются)',
      uninstall: 'Вы действительно хотите ПОЛНОСТЬЮ УДАЛИТЬ приложение ' + pkg + ' с телефона?',
      removeUser: 'Удалить приложение ' + pkg + ' для текущего пользователя? (данные останутся, можно восстановить)',
      disable: 'Отключить приложение ' + pkg + '? Его можно включить обратно.',
      forceStop: 'Остановить приложение ' + pkg + '?'
    };
    if (confirmMap[act]) {
      const yes = await uiConfirm('Подтвердите действие', confirmMap[act]);
      if (!yes) return;
    }
    const r = await window.api.appsAction(s, act, pkg);
    snack(r.ok ? 'Готово' : ('Ошибка: ' + (r.message || r.error || '')));
    if (r.ok && (act === 'uninstall' || act === 'removeUser')) { closeDlg('dlg-appinfo'); appsLoad(); return; }
    if (r.ok && act !== 'clearCache') { closeDlg('dlg-appinfo'); appsLoad(); return; }
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
      qrActive = false;
      qrSetStatus('✓ ' + (ev.message || 'Подключено'), 'ok');
      snd.play('connect');
      $('#btn-qr-retry').classList.add('hidden');
      state = await window.api.getState();
      renderHistory(); renderFavorites();
      refreshDevices();
      setTimeout(() => closeDlg('dlg-qrpc'), 1300);
    }
    else if (ev.stage === 'error') { qrActive = false; qrSetStatus(ev.message || 'Ошибка', 'err'); $('#btn-qr-retry').classList.remove('hidden'); }
    else if (ev.stage === 'cancelled') { qrActive = false; }
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
