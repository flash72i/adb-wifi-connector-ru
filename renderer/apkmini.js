/* apkmini.js — v2.7.0: ОТДЕЛЬНОЕ мини-окно установки APK (открывается по двойному клику
   на .apk/.xapk/… в Проводнике при включённых ассоциациях — БЕЗ открытия основной программы).
   Окно можно перетаскивать за заголовок; внутри: иконка/имя/версия APK, список устройств,
   подключение нового устройства прямо отсюда и установка с прогрессом. */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtBytesLong(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' ГБ';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' КБ';
  return n + ' Б';
}
let snackEl = null;
function snack(msg, ms = 3500) {
  snackEl = snackEl || $('#snackbar');
  snackEl.textContent = msg;
  snackEl.classList.remove('hidden');
  clearTimeout(snackEl._t);
  snackEl._t = setTimeout(() => snackEl.classList.add('hidden'), ms);
}

let currentFile = null;
let meta = null;
let installing = false;
let devices = [];

/* окно: перетаскивание за заголовок + закрытие */
$('#mini-close').onclick = () => window.close();
window.api.onMaximized(() => {});

/* текущий файл: из hash или от main (второй двойной клик по другому APK) */
function fileFromLocation() {
  try { return decodeURIComponent(location.hash.replace(/^#/, '')) || null; } catch (e) { return null; }
}
window.api.onApkMiniFile((p) => { loadFile(p); });

async function loadFile(filePath) {
  if (!filePath) return;
  currentFile = filePath;
  meta = null;
  installing = false;
  $('#mini-progress').classList.add('hidden');
  $('#mini-bar').style.width = '0';
  $('#mini-install').disabled = true;
  $('#mini-install').textContent = 'Установить';
  $('#mini-status').textContent = '';
  $('#mini-file').textContent = filePath;
  $('#mini-title').textContent = 'Читаю файл…';
  $('#mini-icon').src = '';
  $('#mini-sub').textContent = '';
  $('#mini-meta').innerHTML = '<div class="muted">Разбираю APK: иконка, имя, версия…</div>';
  const m = await window.api.apkLocalMeta(filePath).catch(() => null);
  if (!m || !m.ok) {
    $('#mini-title').textContent = 'Файл не читается';
    $('#mini-meta').innerHTML = '<div class="muted">' + esc((m && m.error) || 'Не удалось прочитать файл') + '</div>';
    return;
  }
  meta = m;
  $('#mini-title').textContent = m.label || filePath.split(/[\\/]/).pop();
  $('#mini-sub').textContent = [m.package, m.versionName ? 'версия ' + m.versionName : null, m.size ? fmtBytesLong(m.size) : null].filter(Boolean).join(' · ');
  if (m.icon) $('#mini-icon').src = m.icon;
  $('#mini-meta').innerHTML = [
    ['Имя приложения', m.label],
    ['Пакет', m.package],
    ['Версия', m.versionName ? m.versionName + (m.versionCode ? ' (код ' + m.versionCode + ')' : '') : null],
    ['Размер', m.size ? fmtBytesLong(m.size) : null]
  ].filter(r => r[1]).map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1]) + '</div>').join('') +
    '<div class="muted" style="margin-top:6px">Выберите устройство — или подключите новое по IP прямо в этом окне.</div>';
  await refreshDevices();
}

async function refreshDevices() {
  const r = await window.api.adbDevices().catch(() => null);
  devices = (r && r.ok && r.list) ? r.list.filter(d => d.state === 'device') : [];
  const sel = $('#mini-target');
  if (!devices.length) {
    sel.innerHTML = '<option value="">Нет подключённых — подключите по IP ниже</option>';
  } else {
    sel.innerHTML = devices.map(d => {
      const serial = d.serial;
      const label = (d.model || d.props && d.props.product || serial) + (serial.includes(':') ? '' : ' [USB]');
      return '<option value="' + esc(serial) + '">' + esc(label) + ' — ' + esc(serial) + '</option>';
    }).join('');
  }
  $('#mini-install').disabled = installing || !devices.length || !$('#mini-target').value;
}

$('#mini-refresh').onclick = refreshDevices;
$('#mini-target').onchange = () => { $('#mini-install').disabled = installing || !$('#mini-target').value; };

/* подключение устройства прямо из мини-окна */
$('#mini-connect').onclick = () => { const r = $('#mini-conn-row'); r.style.display = r.style.display === 'none' ? 'flex' : 'none'; };
$('#mini-conn-go').onclick = async () => {
  const v = $('#mini-conn-ip').value.trim();
  const m = v.match(/^([\d.]+):(\d+)$/) || (v.match(/^([\d.]+)$/) ? [null, v, '5555'] : null);
  if (!m) return snack('Введите IP или IP:порт');
  const host = m[1], port = +m[2];
  snack('Подключаюсь к ' + host + ':' + port + '…');
  const r = await window.api.adbConnect(host, port);
  snack(r.ok ? 'Подключено: ' + host + ':' + port : 'Не удалось: ' + ((r.message || r.error || '').slice(0, 140)));
  if (r.ok) { $('#mini-conn-row').style.display = 'none'; await refreshDevices(); }
};
$('#mini-conn-ip').addEventListener('keydown', e => { if (e.key === 'Enter') $('#mini-conn-go').click(); });

/* установка с прогрессом */
$('#mini-install').onclick = async () => {
  if (installing || !meta) return;
  const serial = $('#mini-target').value;
  if (!serial) return snack('Сначала подключите устройство');
  installing = true;
  $('#mini-install').disabled = true;
  $('#mini-install').textContent = 'Устанавливаю…';
  $('#mini-progress').classList.remove('hidden');
  $('#mini-bar').style.width = '40%';
  $('#mini-status').textContent = 'Передаю и устанавливаю APK — не отключайте телефон…';
  const r = await window.api.apkInstallBatch(serial, [{ path: currentFile, meta: { package: meta.package } }]);
  installing = false;
  $('#mini-bar').style.width = '100%';
  $('#mini-install').disabled = false;
  $('#mini-install').textContent = 'Установить';
  if (r && r.ok && r.installed) {
    $('#mini-status').textContent = '✓ Установлено: ' + (meta.label || currentFile.split(/[\\/]/).pop());
    snack('Установлено: ' + (meta.label || 'APK'));
    setTimeout(() => { $('#mini-progress').classList.add('hidden'); $('#mini-bar').style.width = '0'; }, 1500);
  } else {
    $('#mini-status').textContent = '✗ Не удалось установить: ' + ((r && (r.error || (r.canceled ? 'прервано' : 'ошибка'))) || 'ошибка');
    $('#mini-progress').classList.add('hidden');
    $('#mini-bar').style.width = '0';
  }
};

/* прогресс/статусы из main (apk-queue) */
window.api.onTask(async ev => {
  if (ev.kind === 'apk-queue' && ev.stage) {
    if (ev.stage === 'run') {
      $('#mini-status').textContent = ev.message ? (ev.file + ': ' + ev.message) : 'Устанавливаю…';
      $('#mini-bar').style.width = '55%';
    } else if (ev.stage === 'done') {
      $('#mini-bar').style.width = '100%';
      $('#mini-status').textContent = '✓ ' + (ev.message || 'Готово');
    } else if (ev.stage === 'fail') {
      $('#mini-status').textContent = '✗ ' + (ev.message || 'Ошибка');
      $('#mini-progress').classList.add('hidden');
    }
  } else if (ev.kind === 'refresh-devices') {
    await refreshDevices();
  }
});

/* старт */
(async function init() {
  $('#mini-conn-row').style.display = 'none';
  await refreshDevices();
  const f = fileFromLocation();
  if (f) loadFile(f);
  else $('#mini-title').textContent = 'Файл не передан';
})();
