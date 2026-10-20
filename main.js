// main.js — главный процесс Electron: окно, трей, автостарт, IPC, adb-операции
// v2.4.0: единое активное устройство (R8), без автоподключения по умолчанию (R3),
// зеркало h264+фолбэк и валидный time-limit (R9), мульти-установка APK (R10), гашение
// всех дочерних процессов при выходе (A2-ревью), mDNS adb не глушится (корень R5).
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const adb = require('./adb');
const mdns = require('./mdns');
const qrpair = require('./qrpair');

// v2.7.0: разрешаем автовоспроизведение медиа в плеере БЕЗ жеста пользователя —
// иначе Chromium блокировал video.play() после асинхронной загрузки файла с телефона
// («открывается плеер, но не воспроизводит, просто чёрный экран»)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// база: каталог над APP/, если exe лежит в APP/, иначе каталог exe
const BASE_DIR = (() => {
  const d = path.dirname(process.execPath);
  return path.basename(d).toUpperCase() === 'APP' ? path.dirname(d) : d;
})();

// v2.5.0 (F16): ВСЕ сохранения — строго в папке с программой: <BASE_DIR>/Сохранения
const SAVE_DIR = path.join(BASE_DIR, 'Сохранения');
const CAPTURES = path.join(SAVE_DIR, 'Захваты');          // скриншоты/видео по умолчанию
const CFG_FILE = path.join(SAVE_DIR, 'config.json');
const HIST_FILE = path.join(SAVE_DIR, 'history.json');
const FAV_FILE = path.join(SAVE_DIR, 'favorites.json');
const SAVED_FILE = path.join(SAVE_DIR, 'saved.json');
const CMDS_FILE = path.join(SAVE_DIR, 'Мои команды.json'); // свои команды терминала
const ICON_CACHE = path.join(SAVE_DIR, 'Кэш иконок');      // кэш иконок/имён приложений
const LOG_FILE = path.join(BASE_DIR, 'app.log');

// ---------- журнал: ТОЛЬКО ошибки (F19), ротация при переполнении ----------
function logErr(tag, ...a) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      try { fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log')); } catch (e) {}
    }
    const line = new Date().toISOString() + ' ERROR ' + tag + ' ' + a.map(x =>
      typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : JSON.stringify(x))).join(' ') + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}
// совместимость: прежние информационные log() больше НЕ пишут в файл (в журнале только ошибки)
function log() {}
process.on('uncaughtException', e => { logErr('uncaught', e && (e.stack || e.message) || String(e)); });

const DEFAULTS = {
  adbPath: null,
  scrcpyPath: null,
  autostart: false,
  closeToTray: true,
  theme: 'dark',
  scanOnStart: false,
  autoreconnect: false,
  autolast: false,
  sounds: true,
  showPkgNames: false,  // приложения: показывать имена (false) или пакеты (true) — F11
  migrated24: false,    // одноразовая миграция: автовключённые ранее автоподключения выключаем
  migrated25: false     // одноразовая миграция сохранений в «Сохранения/» (F16)
};

let config = Object.assign({}, DEFAULTS);
let history = [];   // [{host, port, model, lastTs}]
let favorites = []; // [{host, port, model}]
let win = null;
let tray = null;
let quitting = false;
let miniWin = null;   // v2.7.0: отдельное окно установки APK (ассоциация файлов — БЕЗ основной программы)

// дочерние процессы — на уровне модуля: before-quit обязан гасить ВСЕ (A2-ревью)
let logcatChild = null;
let recordChild = null;
let recordMeta = null;
let shellChild = null;      // раньше жил в замыкании registerIpc и переживал выход
let installChild = null;    // текущий «adb install» (для отмены)
let installCanceled = false;
let mirrorChild = null, mirrorMode = null, mirrorSerial = null;
let mirrorJpegChild = null, mirrorTimer = null, mirrorWatchdog = null;
let mirrorGen = 0, mirrorRestarts = 0, mirrorLastData = 0, jpegSeq = 0;

const PAIR_HTTP_NOTE = 'removed-in-v2';

function localIpv4() {
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) for (const a of ifaces[k] || []) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Автопайплайн: знаем IP телефона и код -> сами находим порты, сопрягаем, подключаем
// v2.7.0: поиск портов — БЫСТРЫЙ (ранний выход после первого найденного порта, ~1–2 с
// вместо полного свипа на ~24 с) — отсюда была «вечная» фаза сопряжения
async function autoPairConnect(host, code, hintPort) {
  let ports;
  if (hintPort) {
    const probe = await adb.tcpProbe(host, hintPort);
    ports = probe ? [hintPort] : await adb.portScanFast(host);
  } else {
    ports = await adb.portScanFast(host);
  }
  let paired = false, pairPort = null;
  for (const p of ports) {
    const r = await adb.pair(host, p, code);
    if (r.ok) { paired = true; pairPort = p; break; }
  }
  if (!paired) {
    return { ok: false, error: 'Сопряжение не удалось (порты: ' + (ports.slice(0, 8).join(', ') || 'не найдены') + '). Держите на телефоне открытым экран «Сопряжение по коду».' };
  }
  // после сопряжения порт сопряжения закрывается и открывается порт отладки — часто СОСЕДНИЙ:
  // сначала пробуем соседние порты (мгновенно), затем быстрый свип
  const after = [];
  for (const p of [pairPort + 1, pairPort - 1, pairPort + 2]) if (p > 1024) after.push(p);
  const swept = await adb.portScanFast(host);
  const connPorts = after.concat(swept).filter((p, i, a) => p !== pairPort && a.indexOf(p) === i);
  if (!connPorts.length) connPorts.push(5555);
  for (const p of connPorts) {
    // подключаем через ЕДИНУЮ точку: rememberDevice + enforceSingleDevice + трей (R8)
    const c = await connectDevice(host, p);
    if (c.ok) {
      let name = '';
      try { const m = await adb.modelName(`${host}:${p}`); name = m.model; } catch (e) {}
      return { ok: true, host, port: p, model: name };
    }
  }
  return { ok: false, error: 'Сопряжение выполнено, но подключиться не удалось. Введите IP:порт с экрана «Беспроводная отладка» вручную.' };
}

function ensureDirs() { for (const d of [SAVE_DIR, CAPTURES, ICON_CACHE]) try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function loadJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function saveJson(f, v) { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) {} }
// одноразовая миграция старых сохранений из %APPDATA%/adb-wifi-ru в «Сохранения/» (F16).
// B1-фикс (ревизор): после копирования config.json ПЕРЕЧИТЫВАЕМ его — иначе настройки
// старой установки (adbPath, тема, размеры окна) безвозвратно теряются при обновлении
function migrateSaves() {
  if (config.migrated25) return;
  const OLD = path.join(app.getPath('appData'), 'adb-wifi-ru');
  const files = ['config.json', 'history.json', 'favorites.json', 'saved.json'];
  let copiedCfg = false;
  for (const f of files) {
    const src = path.join(OLD, f), dst = path.join(SAVE_DIR, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); if (f === 'config.json') copiedCfg = true; }
    } catch (e) { logErr('migrate25', f, e.message); }
  }
  const oldIcons = path.join(OLD, 'apk-icons');
  try {
    if (fs.existsSync(oldIcons)) {
      for (const f of fs.readdirSync(oldIcons)) {
        const src = path.join(oldIcons, f), dst = path.join(ICON_CACHE, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    }
  } catch (e) {}
  if (copiedCfg) {
    // перечитываем унаследованные настройки и применяем здесь же (migrated24 уже внутри)
    config = Object.assign({}, DEFAULTS, loadJson(CFG_FILE, {}));
    if (!config.migrated24) { config.autolast = false; config.autoreconnect = false; config.migrated24 = true; }
    if (config.adbPath) adb.setAdbPath(config.adbPath);
  }
  config.migrated25 = true; saveConfig();
}
function loadAll() {
  ensureDirs();
  config = Object.assign({}, DEFAULTS, loadJson(CFG_FILE, {}));
  // R3: владелец требует «не подключаться при запуске, если я не выбрал в настройках».
  // Прежние версии включали автоподключения — одноразово выключаем, точечно (winBounds,
  // adbPath, scrcpyPath, favCmds не трогаем); в настройках можно включить обратно.
  if (!config.migrated24) {
    config.autolast = false;
    config.autoreconnect = false;
    config.migrated24 = true;
  }
  migrateSaves(); // должен идти ПОСЛЕ чтения config: использует флаг migrated25
  history = loadJson(HIST_FILE, []);
  favorites = loadJson(FAV_FILE, []);
  if (config.adbPath) adb.setAdbPath(config.adbPath);
}
function saveConfig() { saveJson(CFG_FILE, config); }

// ---------- единая точка подключения (R8: строго одно активное сетевое устройство) ----------
let connectChain = Promise.resolve();
function connectDevice(host, port, opts = {}) {
  const run = async () => {
    const r = await adb.connect(host, port);
    if (!r.ok) return r;
    let name = opts.model || '';
    if (!name) { try { const m = await adb.modelName(`${host}:${port}`); name = m.model; } catch (e) {} }
    rememberDevice(host, port, name);
    await enforceSingleDevice(`${host}:${port}`);
    sendTask({ kind: 'connected', host, port });
    buildTrayMenu();
    return r;
  };
  const p = connectChain.then(run, run);
  connectChain = p.catch(() => {});
  return p;
}

// после успешного подключения отключаем все ПРОЧИЕ сетевые устройства (USB не трогаем).
// adb auto-connect мог удержать второй serial — перепроверяем через 1.2 с (A3-ревью).
let enforceChain = Promise.resolve();
function enforceSingleDevice(newSerial) {
  if (!/^[\w.\-]+:\d+$/.test(String(newSerial || ''))) return Promise.resolve();
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await adb.devices().catch(() => ({ ok: false, list: [] }));
      if (!d.ok) return;
      const others = (d.list || []).filter(x => x.state === 'device' && String(x.serial).includes(':') && x.serial !== newSerial).map(x => x.serial);
      if (!others.length) return;
      for (const s of others) {
        try { await adb.disconnect(s); } catch (e) {}
      }
      await sleep(1200);
    }
    sendTask({ kind: 'refresh-devices' });
  };
  const p = enforceChain.then(run, run);
  enforceChain = p.catch(() => {});
  return p;
}

// Автостарт (реестр HKCU Run): состояние пишем ТОЛЬКО при успехе (W6-ревизор)
function setAutostart(on) {
  const exe = process.execPath;
  const key = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'];
  return new Promise((resolve) => {
    if (!process.platform.startsWith('win')) return resolve({ ok: false, error: 'Доступно только в Windows' });
    const args = on
      ? ['add', key[0], '/v', 'AdbWifiConnectorRu', '/t', 'REG_SZ', '/d', `"${exe}" --hidden`, '/f']
      : ['delete', key[0], '/v', 'AdbWifiConnectorRu', '/f'];
    execFile('reg.exe', args, { windowsHide: true }, (err, out, errOut) => {
      if (!err) { config.autostart = on; saveConfig(); }
      else logErr('autostart', errOut || err.message);
      resolve({ ok: !err, message: err ? (errOut || err.message) : 'OK' });
    });
  });
}

// ---------- окно ----------
function createWindow() {
  // окно не должно вылезать за рабочую область: на Windows с масштабом 125–150%
  // жёсткие размеры обрезаются системой — элементы «съезжают» (FIX-L1/L2, R4-2.3.1)
  const { screen } = require('electron');
  let wa = { width: 1280, height: 800 };
  try { wa = screen.getPrimaryDisplay().workAreaSize; } catch (e) {}
  const saved = config.winBounds && Number.isFinite(config.winBounds.width) ? config.winBounds : null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const w = clamp(saved ? saved.width : 1080, 800, wa.width - 12);
  const h = clamp(saved ? saved.height : 740, 560, wa.height - 12);
  win = new BrowserWindow({
    width: w, height: h, minWidth: Math.min(800, wa.width - 8), minHeight: Math.min(560, wa.height - 8),
    show: false, frame: false, backgroundColor: '#0e1418',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  let boundsTimer = null;
  win.on('resize', () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      try {
        if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
        const b = win.getBounds();
        if (b.width >= 800 && b.height >= 560) { config.winBounds = { width: b.width, height: b.height }; saveConfig(); }
      } catch (e) {}
    }, 700);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    process.env.SCREENSHOT_PAGE ? { hash: process.env.SCREENSHOT_PAGE } : undefined);
  // renderer умер/перезапустился — гасим привязанные к нему потоки, иначе невидимые adb живут
  win.webContents.on('render-process-gone', () => {
    logErr('render-process-gone', 'stopping children');
    stopMirrorAll();
    try { if (logcatChild) logcatChild.kill('SIGKILL'); } catch (e) {}
    try { if (recordChild) recordChild.kill('SIGKILL'); } catch (e) {}
    try { if (shellChild) shellChild.kill('SIGKILL'); } catch (e) {}
  });
  win.once('ready-to-show', () => {
    const hidden = process.argv.includes('--hidden');
    if (!hidden) win.show();
    // служебный режим: автотест renderer (AUTOTEST=1)
    if (process.env.AUTOTEST) {
      setTimeout(async () => {
        try {
          const res = await win.webContents.executeJavaScript(`(async () => {
            const R = [];
            const ok = (n, c) => R.push([n, !!c]);
            ok('rail 6 пунктов', document.querySelectorAll('.rail-item').length === 6);
            for (const pg of ['devices','tools','files','apps','apk','settings']) { goPage(pg); ok('страница ' + pg, document.querySelector('#page-' + pg).classList.contains('active')); }
            ok('топбар-селектор устройства', !!document.querySelector('#tb-device'));
            ok('старые селекторы удалены', !document.querySelector('#tool-device') && !document.querySelector('#fs-device') && !document.querySelector('#apps-device'));
            goPage('devices');
            ok('карточка активного устройства', !!document.querySelector('#active-card'));
            ok('способы подключения на одной странице', !!document.querySelector('.connect-ways'));
            ok('QR-кнопка внутри карточки сопряжения', !!document.querySelector('#pair-card #btn-qr-show'));
            ok('в сопряжении нет вкладок — всё на одной странице', document.querySelectorAll('#pair-card .tab').length === 0);
            ok('drag-QR удалён вместе с jsQR', !document.querySelector('#qr-drop') && typeof window.jsQR === 'undefined');
            ok('разделённые поля сопряжения', !!document.querySelector('#pair-ip') && !!document.querySelector('#pair-port') && !!document.querySelector('#pair-code'));
            openDlg('dlg-help'); ok('диалог помощи', !document.querySelector('#dlg-help').classList.contains('hidden')); closeDlg('dlg-help');
            openDlg('dlg-qrpc'); ok('диалог QR-подключения', !!document.querySelector('#qr-pc-canvas') && !!document.querySelector('#qr-pc-log')); closeDlg('dlg-qrpc');
            goPage('tools');
            ok('телефон-рамка зеркала', !!document.querySelector('.phone-frame'));
            ok('плейсхолдер зеркала', !!document.querySelector('#mirror-placeholder'));
            ok('кнопка простого режима зеркала', !!document.querySelector('#btn-mirror-fallback'));
            ok('счётчик FPS зеркала', !!document.querySelector('#mirror-fps'));
            ok('фильтр logcat', !!document.querySelector('#logcat-filter'));
            ok('список команд терминала > 10', document.querySelectorAll('#shell-cmd-select option').length > 10);
            ok('команды сгруппированы по производителям', document.querySelectorAll('#shell-cmd-select optgroup').length >= 5);
            ok('кнопка «свою команду»', !!document.querySelector('#btn-shell-cmd-save') && !!document.querySelector('#btn-shell-cmd-del'));
            ok('автодополнение в терминале', !!document.querySelector('#shell-ac'));
            ok('панель управления рядом с зеркалом', !!document.querySelector('.mirror-zone .chips .chip[data-cmd="home"]'));
            ok('нет дубля scrcpy-карточки', !document.querySelector('#btn-scrcpy'));
            ok('карточка установки APK убрана из инструментов', !document.querySelector('#apk-drop'));
            ok('просмотрщик изображений', !!document.querySelector('#dlg-imgview #imgview-img'));
            ok('медиаплеер с эквалайзером', !!document.querySelector('#dlg-media #media-el') && !!document.querySelector('#media-eq'));
            goPage('files');
            ok('чипы быстрых переходов файлов', document.querySelectorAll('#fs-quick .chip').length >= 4);
            ok('пустое состояние файлов', !!document.querySelector('#fs-empty'));
            ok('кнопка «Назад» в файлах (F5)', !!document.querySelector('#btn-fs-back'));
            ok('иконки типов файлов (F4)', !!document.querySelector('#fs-list .fs-row .fs-ico') || document.querySelector('#fs-list').innerHTML.includes('fs-ico') || typeof window.FSICONS !== 'undefined');
            ok('свойства файла (F6)', !!document.querySelector('#dlg-fsprop #fsprop-body'));
            ok('оверлей перетаскивания файлов (F8)', !!document.querySelector('#fs-drop-overlay'));
            goPage('apps');
            ok('табы приложений (включая «Все»)', document.querySelectorAll('[data-apptab]').length === 5);
            ok('сортировка приложений', !!document.querySelector('#apps-sort'));
            ok('кнопка завершить все приложения', !!document.querySelector('#btn-killall-procs'));
            goPage('apk');
            ok('очередь установки APK', !!document.querySelector('#apk2-drop') && !!document.querySelector('#btn-apk2-installall'));
            ok('селектор устройства установки', !!document.querySelector('#apk-target'));
            goPage('settings');
            ok('тумблер ассоциаций', !!document.querySelector('#set-assoc'));
            ok('тултип debloat', (document.querySelector('#btn-debloat').getAttribute('data-tip') || '').length > 20);
            ok('поиск приложений', !!document.querySelector('#apps-search'));
            ok('счётчики приложений (F14)', !!document.querySelector('#apps-counts'));
            ok('переключатель имена/пакеты (F11)', !!document.querySelector('#btn-apps-names'));
            ok('описания процессов (F10)', typeof window.PROCDESC !== 'undefined' && window.PROCDESC.length >= 90);
            ok('тултип приложения (F13)', !!document.querySelector('#app-tip'));
            goPage('settings');
            ok('нет слова «приятные»', !document.body.innerHTML.includes('приятные сигналы'));
            ok('тумблер автопереподключения', !!document.querySelector('#set-autoreconnect'));
            ok('модальный ввод вместо prompt', !!document.querySelector('#dlg-input'));
            ok('поле ввода модального диалога', !!document.querySelector('#input-field'));
            const df = document.querySelector('.dialog-foot');
            ok('футер диалогов переносится (R13)', df && (getComputedStyle(df).flexWrap || '') === 'wrap');
            return JSON.stringify(R);
          })()`);
          const arr = JSON.parse(res);
          for (const [n, c] of arr) console.log('TEST ' + (c ? 'PASS' : 'FAIL') + ' | ' + n);
          const fails = arr.filter(x => !x[1]).length;
          console.log('TEST SUMMARY fails=' + fails);
        } catch (e) { console.log('TEST ERROR ' + e.message); }
        app.quit();
      }, 2500);
    }
    // служебный режим: скриншот окна для проверки вёрстки (SCREENSHOT_DIR=/path)
    if (process.env.SCREENSHOT_DIR) {
      setTimeout(async () => {
        try {
          if (process.env.SCREENSHOT_PAGE) {
            await win.webContents.executeJavaScript(`location.hash='${process.env.SCREENSHOT_PAGE}';true`);
            await new Promise(r => setTimeout(r, 400));
          }
          const img = await win.capturePage();
          const f = path.join(process.env.SCREENSHOT_DIR, 'shot-' + Date.now() + '.png');
          fs.writeFileSync(f, img.toPNG());
        } catch (e) {}
        app.quit();
      }, 3000);
    }
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  win.on('close', (e) => {
    if (!quitting && config.closeToTray) { e.preventDefault(); win.hide(); }
  });
  return win;
}

// ---------- трей ----------
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  return img.resize({ width: 16, height: 16 });
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [];
  items.push({ label: 'Показать окно', click: () => { win.show(); win.focus(); } });
  items.push({ type: 'separator' });
  items.push({ label: 'Сканировать сеть', click: async () => {
    win.show(); win.webContents.send('task:event', { kind: 'scan-request' });
  } });
  items.push({ type: 'separator' });
  items.push({ label: 'Выход', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip('ADB Wi-Fi Коннектор (RU)');
}

// ---------- вспомогательное ----------
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
// события идут И в главное окно, И в мини-окно APK (если открыто)
function sendTask(ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('task:event', ev); } catch (e) {}
  try { if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('task:event', ev); } catch (e) {}
}

// ---------- v2.7.0: отдельное мини-окно установки APK ----------
// Владелец: «когда я открываю файл АПК с рабочего стола… она открывается сразу в программе.
// Сделай так, чтобы она открывалась БЕЗ программы, и это окошко можно было перемещать по рабочему
// столу». Отдельное frameless-окно с перетаскиванием за заголовок: иконка/имя/версия APK,
// список устройств, подключение нового устройства прямо из окошка, установка с прогрессом.
function openApkStandalone(filePath) {
  try {
    if (miniWin && !miniWin.isDestroyed()) {
      miniWin.show(); miniWin.focus();
      miniWin.webContents.send('apkmini:file', filePath);
      return true;
    }
    miniWin = new BrowserWindow({
      width: 440, height: 640, minWidth: 380, minHeight: 500,
      show: false, frame: false, resizable: true, backgroundColor: '#0e1418',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    miniWin.setAlwaysOnTop(false);
    miniWin.loadFile(path.join(__dirname, 'renderer', 'apkmini.html'), { hash: encodeURIComponent(filePath) });
    miniWin.once('ready-to-show', () => { try { miniWin.show(); miniWin.focus(); } catch (e) {} });
    miniWin.on('closed', () => { miniWin = null; });
    miniWin.webContents.on('render-process-gone', () => { miniWin = null; });
    return true;
  } catch (e) { logErr('apkmini', e.message); return false; }
}

// Объединённое обнаружение беспроводной отладки: свой mDNS-клиент + adb mdns services
async function mergedDiscover() {
  const [mine, uni, adbMdns] = await Promise.all([
    mdns.discover(2500).catch(() => []),
    mdns.discoverUnicast(3000).catch(() => []),
    adb.mdnsServices().catch(() => ({ items: [] }))
  ]);
  const out = [];
  for (const r of (mine || []).concat(uni || [])) {
    if (!out.some(x => x.host === r.host && x.port === r.port && x.service === r.service)) {
      out.push({ host: r.host, port: r.port, sid: r.sid || null, src: 'mdns', service: r.service, instance: r.instance || null });
    }
  }
  for (const r of ((adbMdns && adbMdns.items) || [])) {
    if (!out.some(x => x.host === r.host && x.port === r.port)) {
      out.push({ host: r.host, port: r.port, sid: null, src: 'adb-mdns', service: r.service, instance: r.instance || null });
    }
  }
  return out;
}

function rememberDevice(host, port, model) {
  history = history.filter(h => !(h.host === host && h.port === port));
  history.unshift({ host, port, model: model || '', lastTs: Date.now() });
  if (history.length > 50) history = history.slice(0, 50);
  saveJson(HIST_FILE, history);
}

// кэш моделей: getprop — это 2 вызова adb на устройство, ответы редко меняются
const modelCache = new Map();
async function cachedModel(serial) {
  const c = modelCache.get(serial);
  if (c && Date.now() - c.ts < 120000) return c;
  const m = await adb.modelName(serial);
  const rec = { model: m.model || '', android: m.android || '', ts: Date.now() };
  modelCache.set(serial, rec);
  return rec;
}

// ================= v2.4: встроенное зеркало экрана (R9) =================
// h264-поток screenrecord с АВТОРЕСТАРТОМ (валидный --time-limit 180: значение 3000 из v2.3.1
// мгновенно убивало процесс на Android 11–13 — отсюда «запускаю трансляцию, ничего не происходит»),
// watchdog молчания 7 с (renderer переключится в простой режим), JPEG/PNG-фолбэк самопланирующимся
// циклом screencap. Все ссылки — на уровне модуля, чтобы before-quit гасил всё гарантированно.
// v2.6.0 (L1): борьба с «трансляция отстаёт/зависает»: по Wi-Fi потолок — не кодек, а
// ПРОПУСКНАЯ СПОСОБНОСТЬ: дефолтный битрейт screenrecord (~20 Мбит/с) не пролезает,
// пакеты копятся в очереди — картинка отстаёт на секунды. Ставим --bit-rate 8 Мбит/с и
// уменьшаем разрешение до длинной стороны 1280 (--size) — кадры идут без затыков.
const MIRROR_BITRATE = 8000000;
const mirrorSizeCache = new Map(); // serial -> {w,h} физических пикселей экрана
async function mirrorSizeArg(serial) {
  try {
    let c = mirrorSizeCache.get(serial);
    if (!c) {
      const r = await adb.run(['-s', serial, 'shell', 'wm', 'size'], { timeout: 8000 });
      const m = (r.stdout || '').match(/(\d+)x(\d+)/);
      if (!m) return [];
      c = { w: +m[1], h: +m[2] };
      mirrorSizeCache.set(serial, c);
    }
    // портрет/альбом: длинная сторона = max; масштаб до 1280 по длинной стороне, чётные значения
    const long = Math.max(c.w, c.h), short = Math.min(c.w, c.h);
    if (long <= 1280) return []; // экран и так небольшой — не трогаем
    const k = 1280 / long;
    const s = Math.max(2, Math.round(short * k / 2) * 2);
    const l = 1280;
    return (c.h >= c.w) ? ['--size', `${s}x${l}`] : ['--size', `${l}x${s}`];
  } catch (e) { return []; }
}
function stopMirrorAll(reason) {
  const deadGen = mirrorGen; // генерация ЗАВЕРШАЕМОЙ сессии — renderer игнорирует чужие стопы
  mirrorGen++;
  if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  if (mirrorWatchdog) { clearInterval(mirrorWatchdog); mirrorWatchdog = null; }
  for (const c of [mirrorChild, mirrorJpegChild]) { try { c && c.kill('SIGKILL'); } catch (e) {} }
  mirrorChild = mirrorJpegChild = null;
  mirrorMode = mirrorSerial = null;
  mirrorRestarts = 0;
  sendTask({ kind: 'mirror-stopped', gen: deadGen, reason });
}

async function spawnH264(serial, gen) {
  const exe = adb.getAdbPath();
  if (!exe) return stopMirrorAll();
  const sizeArgs = await mirrorSizeArg(serial); // уменьшенное разрешение = меньше байт по Wi-Fi (L1)
  const child = require('child_process').spawn(exe,
    ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', String(MIRROR_BITRATE), ...sizeArgs, '--time-limit', '180', '-'],
    { windowsHide: true });
  mirrorChild = child;
  mirrorLastData = Date.now();
  child.stdout.on('data', d => {
    mirrorLastData = Date.now();
    if (win && !win.isDestroyed()) win.webContents.send('mirror:chunk', d);
  });
  child.stderr.on('data', () => {});
  const onGone = () => {
    if (gen !== mirrorGen) return; // остановлены/сменён режим — рестарт не поднимаем
    const lived = Date.now() - mirrorLastData;
    if (lived > 60000) mirrorRestarts = 0; // жил долго (плановые 180 с) — счётчик сбрасываем
    if (lived < 3000 && ++mirrorRestarts >= 5) {
      // h264 невозможен на этом устройстве: просим renderer уйти в простой режим ДО остановки (R9-3)
      sendTask({ kind: 'mirror-stalled' });
      stopMirrorAll('device-lost');
      return;
    }
    const delay = Math.min(8000, 250 * Math.pow(2, mirrorRestarts++));
    mirrorTimer = setTimeout(() => {
      if (gen === mirrorGen && mirrorMode === 'h264') {
        sendTask({ kind: 'mirror-status', text: 'Перезапуск потока экрана…' });
        spawnH264(serial, gen);
      }
    }, delay);
  };
  child.on('close', onGone);
  child.on('error', onGone);
}

// ---------- нормализация путей файлового менеджера (v2.6.0, L2) ----------
// Жалобы владельца: «/sdcard не открывается, а /sdcard/ открывался»,
// «/sdcard/emulated/0 (путь из ES-проводника) не работает».
// Причины: (1) toybox `ls -l /sdcard` показывает СА СИМЛИНК, а не содержимое —
// нужен хвостовой слэш (ls /sdcard/ следует по ссылке);
// (2) ES-проводник показывает /storage/emulated/0, а владельцы пишут
// /sdcard/emulated/0 — маппим на настоящий путь.
function normalizeFsDir(p) {
  let d = String(p == null ? '/' : p).trim();
  if (!d) d = '/';
  if (!d.startsWith('/')) d = '/' + d;
  d = d.replace(/\/{2,}/g, '/');
  d = d.replace(/\/+$/, '') || '/';
  // популярные неверные варианты одного и того же пути
  d = d.replace(/^\/sdcard\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/emulated(?=\/|$)/, '/storage/emulated');
  d = d.replace(/^\/storage\/emulated\/0\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/storage\/emulated\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/0(?=\/|$)/, '/storage/emulated/0');
  return d || '/';
}

// простой режим: строго ПОСЛЕДОВАТЕЛЬНЫЙ цикл screencap (параллельные спавны душат adb по Wi-Fi).
// v2.5.0: screencap -j (JPEG) вместо PNG — кодирование на устройстве в 3–5 раз быстрее,
// передаётся в разы меньше байт по Wi-Fi → вместо «1 кадр в секунду» — 2–4 к/с (F15).
// W3-ревизор: если -j не поддерживается устройством (пустые ответы) — НЕ молотим пустыми
// спавнами, а возвращаемся на PNG (как в 2.4.0).
let jpegEmpty = 0, jpegUsePng = false;
function jpegTick() {
  if (mirrorMode !== 'jpeg' || mirrorJpegChild) return;
  const serial = mirrorSerial, gen = mirrorGen;
  const exe = adb.getAdbPath();
  if (!exe) return stopMirrorAll();
  const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'screencap', jpegUsePng ? '-p' : '-j'], { windowsHide: true });
  mirrorJpegChild = child;
  const chunks = []; let bytes = 0;
  const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 7000);
  child.stdout.on('data', d => { if ((bytes += d.length) <= 8 * 1024 * 1024) chunks.push(d); });
  child.on('error', () => {});
  child.on('close', () => {
    clearTimeout(to);
    mirrorJpegChild = null;
    if (gen !== mirrorGen) return;
    const buf = bytes && bytes < 8 * 1024 * 1024 ? Buffer.concat(chunks) : null;
    // валидный кадр: JPEG (FF D8) или PNG (89 50) сигнатура
    const valid = buf && buf.length > 8 && ((buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50));
    if (valid && win && !win.isDestroyed()) {
      jpegEmpty = 0;
      win.webContents.send('mirror:jpeg', { seq: ++jpegSeq, buf });
    } else {
      if (++jpegEmpty === 4 && !jpegUsePng) {
        jpegUsePng = true; // это устройство не умеет -j — на PNG до конца сессии
        sendTask({ kind: 'mirror-status', text: 'JPEG-снимки не поддерживаются — перешёл на PNG (медленнее)' });
      }
      if (jpegEmpty >= 40) return stopMirrorAll('device-lost'); // устройство не отвечает вовсе
    }
    mirrorTimer = setTimeout(jpegTick, 300); // следующий тик строго после завершения предыдущего
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on('win:min', () => win.minimize());
  ipcMain.on('win:max', () => win.isMaximized() ? win.unmaximize() : win.maximize());
  ipcMain.on('win:close', () => win.close());

  ipcMain.handle('state:get', async () => ({
    config, history, favorites,
    platform: process.platform,
    localIp: localIpv4(),
    adbPath: adb.getAdbPath(),
    version: app.getVersion(),
    capturesDir: CAPTURES,
    savesDir: SAVE_DIR
  }));

  // белый список ключей настроек: renderer не должен уметь писать произвольные поля
  const ALLOWED_SETTINGS = new Set(['adbPath', 'scrcpyPath', 'autostart', 'closeToTray', 'theme', 'scanOnStart', 'autoreconnect', 'autolast', 'sounds', 'favCmds', 'showPkgNames']);
  ipcMain.handle('settings:set', async (_e, key, value) => {
    if (typeof key !== 'string' || !ALLOWED_SETTINGS.has(key)) return { ok: false, error: 'Недопустимый ключ настройки: ' + String(key).slice(0, 50) };
    if (key === 'autostart') return setAutostart(!!value);
    config[key] = value; saveConfig();
    if (key === 'adbPath') adb.setAdbPath(value);
    return { ok: true };
  });

  ipcMain.handle('dialog:pick-file', async (_e, opts) => {
    const properties = (opts && opts.properties) || ['openFile'];
    const r = await dialog.showOpenDialog(win, { properties, filters: opts && opts.filters || [] });
    return r.canceled ? null : r.filePaths;
  });
  ipcMain.handle('dialog:pick-save', async (_e, opts) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: opts && opts.defaultPath, filters: opts && opts.filters || [] });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('shell:show-item', async (_e, p) => { shell.showItemInFolder(p); return { ok: true }; });
  ipcMain.handle('shell:open-external', async (_e, u) => {
    const s = String(u || '');
    if (!/^(https?|file):\/\//i.test(s)) return { ok: false, error: 'Протокол ссылки не поддерживается' };
    shell.openExternal(s);
    return { ok: true };
  });

  ipcMain.handle('adb:version', async () => adb.version());
  ipcMain.handle('adb:devices', async () => {
    const d = await adb.devices();
    if (!d.ok) return d;
    for (const dev of d.list) {
      if (dev.state !== 'device') continue;
      const m = await cachedModel(dev.serial);
      dev.model = m.model; dev.android = m.android;
    }
    return d;
  });
  // R8: все пути подключения идут через connectDevice (сериализация + enforce одного устройства)
  ipcMain.handle('adb:connect', async (_e, host, port, model) => {
    const r = await connectDevice(host, port, { model });
    if (!r.ok) logErr('connect', host + ':' + port, r.message || r.error || 'fail');
    return r;
  });
  ipcMain.handle('adb:disconnect', async (_e, serial) => {
    if (!serial || !String(serial).includes(':')) return { ok: false, message: 'Нужен serial вида host:port' };
    return adb.disconnect(serial);
  });
  ipcMain.handle('adb:ping', async (_e, serial) => {
    try { return await adb.pingDevice(serial); } catch (e) { return { ok: false, ms: 0 }; }
  });
  ipcMain.handle('adb:pair', async (_e, host, port, code) => {
    const r = await adb.pair(host, port, code, chunk => sendTask({ kind: 'pair-log', text: chunk }));
    if (!r.ok) logErr('pair', host + ':' + port, r.error || r.message || 'fail');
    return r;
  });
  // QR-подключение (Android 11+): статусы идут в renderer через task:event { kind:'qr-status', stage, message }
  ipcMain.handle('qr:start', async () => {
    const r = qrpair.start({
      sendStatus: (stage, message, extra) => sendTask(Object.assign({ kind: 'qr-status', stage, message }, extra || {})),
      onConnected: (host, port, model) => {
        // R8: подключение через единую точку (enforce одного устройства внутри)
        connectDevice(host, port, { model }).then(() => sendTask({ kind: 'refresh-devices' }));
      },
      log: () => {} // qr-журнал отладочный: в app.log попадают ТОЛЬКО ошибки (F19)
    });
    return r;
  });
  ipcMain.handle('qr:cancel', async () => { qrpair.cancel(); return { ok: true }; });
  ipcMain.on('log:renderer', (_e, msg) => logErr('renderer', String(msg).slice(0, 500)));
  // ошибки, показанные пользователю в интерфейсе (snack/статусы) — тоже в журнал (F19)
  ipcMain.on('log:ui', (_e, msg) => logErr('ui', String(msg).slice(0, 500)));
  ipcMain.handle('adb:scan-subnet', async () => {
    sendTask({ kind: 'scan-start' });
    // параллельно: свип 5555, mDNS (свой + adb), повторный опрос известных адресов
    const known = [];
    for (const h of history) known.push({ host: h.host, port: h.port, label: 'из истории' });
    for (const f of favorites) known.push({ host: f.host, port: f.port, label: 'избранное' });
    const [found, md] = await Promise.all([
      adb.scanSubnet((done, total) => {
        if (done % 32 === 0) sendTask({ kind: 'scan-progress', done, total });
      }),
      mergedDiscover()
    ]);
    const out = (found || []).map(x => ({ host: x.host, port: x.port, label: 'порт 5555' }));
    for (const m of (md || []).filter(x => (x.service || '').includes('connect'))) {
      if (!out.some(o => o.host === m.host && o.port === m.port)) {
        out.push({ host: m.host, port: m.port, label: x2(m.src), sid: m.sid });
      }
    }
    // опрос известных адресов (телефон со случайным TLS-портом из истории/избранного)
    const uniqKnown = [];
    for (const k of known) if (!uniqKnown.some(u => u.host === k.host && u.port === k.port)) uniqKnown.push(k);
    const probes = await Promise.all(uniqKnown.slice(0, 20).map(k => adb.tcpProbe(k.host, k.port).then(ok => ok ? k : null)));
    for (const k of probes) {
      if (k && !out.some(o => o.host === k.host && o.port === k.port)) out.push({ host: k.host, port: k.port, label: k.label });
    }
    sendTask({ kind: 'scan-done', count: out.length });
    return out;
    function x2(s) { return s === 'adb-mdns' ? 'adb mDNS' : 'mDNS'; }
  });
  ipcMain.handle('adb:mdns', async () => mergedDiscover());
  // v2.7.0: «Найти порт» — быстрый свип с ранним выходом (~1–2 с вместо ~24 с)
  ipcMain.handle('adb:port-scan', async (_e, host) => adb.portScanFast(host));
  ipcMain.handle('adb:auto-pair', async (_e, host, code, port) => {
    const r = await autoPairConnect(host, code, port || null);
    if (r.ok) sendTask({ kind: 'refresh-devices' });
    return r;
  });

  ipcMain.handle('hist:add', async (_e, rec) => { rememberDevice(rec.host, rec.port, rec.model); return history; });
  ipcMain.handle('hist:remove', async (_e, host, port) => {
    history = history.filter(h => !(h.host === host && h.port === port));
    saveJson(HIST_FILE, history); return history;
  });
  ipcMain.handle('hist:clear', async () => { history = []; saveJson(HIST_FILE, history); return history; });
  ipcMain.handle('fav:toggle', async (_e, rec) => {
    const i = favorites.findIndex(f => f.host === rec.host && f.port === rec.port);
    if (i >= 0) favorites.splice(i, 1); else favorites.push({ host: rec.host, port: rec.port, model: rec.model || '' });
    saveJson(FAV_FILE, favorites); return favorites;
  });

  // ----- инструменты -----
  ipcMain.handle('tools:screenshot', async (_e, serial) => {
    const file = await dialog.showSaveDialog(win, {
      defaultPath: path.join(CAPTURES, `screenshot-${stamp()}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (file.canceled) return { ok: false, canceled: true };
    const r = await adb.screenshot(serial, file.filePath);
    return r;
  });

  ipcMain.handle('tools:record-start', async (_e, serial) => {
    if (recordChild) return { ok: false, error: 'Запись уже идёт' };
    // v2.5.0 (F3): пишем в подпапку Movies, а не в корень /sdcard — раньше брошенная
    // при выходе запись оставляла в корне «муляжный» битый mp4. Старые хвосты вычищаем.
    const recDir = '/sdcard/Movies/ADB-WiFi-Connector';
    await adb.shellRun(serial, ['mkdir', '-p', recDir], { timeout: 10000 }).catch(() => {});
    // старые файлы прошлого формата — в мусор безусловно; свои же недописанные хвосты
    // (W4-ревизор) удаляем только если они старше 5 минут — вдруг запись оборвалась,
    // но файл валиден и нужен владельцу
    await adb.run(['-s', serial, 'shell', 'rm -f /sdcard/adb_wifi_connector_ru_*.mp4 2>/dev/null'], { timeout: 10000 }).catch(() => {});
    await adb.run(['-s', serial, 'shell', `find '${recDir}' -name 'adb_wifi_ru_*.mp4' -mmin +5 -delete 2>/dev/null || true`], { timeout: 10000 }).catch(() => {});
    const remote = `${recDir}/adb_wifi_ru_${Date.now()}.mp4`;
    recordMeta = { serial, remote, startedAt: Date.now() };
    const child = adb.startRecord(serial, remote);
    recordChild = child;
    // screenrecord сам умирает по --time-limit 180: честно сообщаем renderer
    child.on('close', () => {
      if (recordChild !== child) return;
      recordChild = null;
      const meta = recordMeta; recordMeta = null;
      sendTask({ kind: 'record-stopped', auto: true, serial: meta && meta.serial, remote: meta && meta.remote, elapsedSec: meta ? Math.round((Date.now() - meta.startedAt) / 1000) : 0 });
    });
    return { ok: true, remote, maxSec: 180 };
  });
  ipcMain.handle('tools:record-stop', async () => {
    const child = recordChild;
    const meta = recordMeta;
    if (!child || !meta) return { ok: false, error: 'Запись не идёт' };
    // обнуляем ДО kill: close старого процесса не должен считаться авто-остановкой
    recordChild = null; recordMeta = null;
    try { child.kill('SIGINT'); } catch (e) {}
    await new Promise(r => setTimeout(r, 1200));
    const file = await dialog.showSaveDialog(win, {
      defaultPath: path.join(CAPTURES, `record-${stamp()}.mp4`),
      filters: [{ name: 'Видео MP4', extensions: ['mp4'] }]
    });
    if (file.canceled) { adb.run(['-s', meta.serial, 'shell', 'rm', '-f', meta.remote]).catch?.(() => {}); return { ok: false, canceled: true }; }
    const pulled = await adb.pull(meta.serial, meta.remote, file.filePath);
    adb.run(['-s', meta.serial, 'shell', 'rm', '-f', meta.remote]);
    return pulled.ok ? { ok: true, file: file.filePath } : { ok: false, error: pulled.message };
  });

  ipcMain.handle('tools:logcat-start', async (_e, serial) => {
    if (logcatChild) {
      // глушим старый процесс до создания нового: его close не должен затереть новую ссылку
      const prev = logcatChild; logcatChild = null;
      try { prev.removeAllListeners('close'); prev.kill('SIGKILL'); } catch (e) {}
    }
    const child = adb.startLogcat(serial, lines => {
      if (win && !win.isDestroyed()) win.webContents.send('logcat:lines', lines);
    });
    logcatChild = child;
    child.on('close', () => {
      if (logcatChild === child) { logcatChild = null; sendTask({ kind: 'logcat-stopped' }); }
    });
    return { ok: true };
  });
  ipcMain.handle('tools:logcat-stop', async () => {
    const c = logcatChild; logcatChild = null;
    if (c) { try { c.removeAllListeners('close'); c.kill('SIGKILL'); } catch (e) {} }
    sendTask({ kind: 'logcat-stopped' });
    return { ok: true };
  });
  ipcMain.handle('tools:logcat-clear', async (_e, serial) => adb.run(['-s', serial, 'logcat', '-c']));

  ipcMain.handle('tools:scrcpy', async (_e, serial) => {
    const candidates = [];
    if (config.scrcpyPath) candidates.push(config.scrcpyPath);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe'));
    candidates.push(path.join(__dirname, 'scrcpy-bundle', 'scrcpy.exe'));
    let exe = null;
    for (const c of candidates) { try { if (c && fs.existsSync(c)) { exe = c; break; } } catch (e) {} }
    if (!exe) {
      exe = await new Promise(res => execFile('where.exe', ['scrcpy.exe'], { windowsHide: true }, (err, out) => res(err ? null : out.trim().split(/\r?\n/)[0])));
    }
    if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'scrcpy.exe не найден. Установите scrcpy или укажите путь в настройках.', code: 'NOT_FOUND' };
    // v2.5.0 (F15): заранее поднимаем adb-сервер СВОИМ скрытым спавном — иначе scrcpy
    // запустит «adb start-server» сам, и рядом с окном scrcpy появится консоль adb
    try { await adb.run(['start-server'], { timeout: 8000 }); } catch (e) {}
    const { spawn } = require('child_process');
    try { spawn(exe, ['-s', serial], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) }).unref(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // R10: установка ОДНОГО или НЕСКОЛЬКИХ APK с пофайловым статусом и отменой
  ipcMain.handle('tools:install-apk', async (_e, serial, paths) => {
    let list = Array.isArray(paths) ? paths.filter(x => typeof x === 'string' && x) : null;
    if (!list) {
      const f = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'APK', extensions: ['apk'] }] });
      if (f.canceled) return { ok: false, canceled: true };
      list = f.filePaths;
    }
    list = list.slice(0, 20);
    if (!list.length) return { ok: false, error: 'Файлы не выбраны' };
    installCanceled = false;
    const results = [];
    let installed = 0, failed = 0, canceled = false;
    for (let i = 0; i < list.length; i++) {
      if (installCanceled) { canceled = true; break; }
      const apkPath = list[i];
      const base = path.basename(apkPath);
      sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: 'install' });
      if (!fs.existsSync(apkPath)) {
        failed++;
        sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: 'fail' });
        results.push({ file: base, ok: false, message: 'файл не найден' });
        continue;
      }
      const r = await new Promise((resolve) => {
        const exe = adb.getAdbPath();
        if (!exe) return resolve({ ok: false, message: 'adb не найден' });
        const child = require('child_process').spawn(exe, ['-s', serial, 'install', '-r', apkPath], { windowsHide: true });
        installChild = child;
        let out = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, message: 'Таймаут установки' }); }, 300000);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('error', e => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
        child.on('close', () => { clearTimeout(timer); resolve({ ok: /success/i.test(out), message: out.trim() }); });
      });
      installChild = null;
      if (r.ok) installed++; else { failed++; logErr('install-apk', base, (r.message || '').split('\n')[0].slice(0, 150)); }
      sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: r.ok ? 'done' : 'fail' });
      results.push({ file: base, ok: r.ok, message: (r.message || '').split('\n')[0].slice(0, 200) });
    }
    log('install-apk done', `installed=${installed}`, `failed=${failed}`, canceled ? 'canceled' : ''); // no-op (журнал = только ошибки)
    return { ok: installed > 0, installed, failed, canceled, results };
  });
  ipcMain.handle('tools:install-apk-cancel', async () => {
    installCanceled = true;
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    return { ok: true };
  });

  ipcMain.handle('tools:quick', async (_e, serial, cmd) => {
    const map = {
      home: ['input', 'keyevent', '3'],
      back: ['input', 'keyevent', '4'],
      recents: ['input', 'keyevent', '187'],
      power: ['input', 'keyevent', '26'],
      wake: ['input', 'keyevent', '224'],
      volup: ['input', 'keyevent', '24'],
      voldown: ['input', 'keyevent', '25'],
      media: ['input', 'keyevent', '85'],
      brightup: ['input', 'keyevent', '221'],
      brightdown: ['input', 'keyevent', '220'],
      reboot: ['reboot'],
      bootloader: ['reboot', 'bootloader'],
      recovery: ['reboot', 'recovery'],
      landscape: ['shell', 'settings', 'put', 'system', 'user_rotation', '1'],
      portrait: ['shell', 'settings', 'put', 'system', 'user_rotation', '0']
    };
    const args = map[cmd];
    if (!args) return { ok: false, error: 'Неизвестная команда' };
    const isReboot = cmd === 'reboot' || cmd === 'bootloader' || cmd === 'recovery';
    const isRot = cmd === 'landscape' || cmd === 'portrait';
    const full = (isReboot || isRot)
      ? ['-s', serial, ...args]
      : ['-s', serial, 'shell', ...args];
    const r = await adb.run(full, { timeout: 20000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });

  // v2.7.0: диагностика расширена и честнее. Раздел mDNS-ADB теперь:
  //  * показывает СЫРОЙ вывод «adb mdns services» (видно даже то, что парсер не понял);
  //  * «ок» = команда отработала, а не «что-то найдено» (пустой список — жёлтое предупреждение,
  //    а не красная ошибка: сервисы видны только пока на телефоне открыт экран беспроводной отладки);
  //  * добавлены разделы собственного mDNS-клиента и unicast-свипа подсети.
  ipcMain.handle('tools:diagnostics', async (_e, serial) => {
    const rep = { sections: [], suggestions: [] };
    const v = await adb.version();
    rep.sections.push({ id: 'adb', title: 'ADB', ok: v.ok, lines: v.ok ? [`версия ${v.version}`, `путь: ${v.path}`] : [v.error || 'adb не найден'] });
    if (!v.ok) rep.suggestions.push('Укажите путь к adb.exe в настройках или перезапустите приложение.');
    const d = await adb.devices();
    rep.sections.push({ id: 'devices', title: 'Устройства', ok: d.ok && d.list.length > 0, lines: d.ok ? (d.list.length ? d.list.map(x => `${x.serial} — ${x.state}`) : ['устройств нет']) : [d.error || 'ошибка'] });
    if (d.ok && !d.list.length) rep.suggestions.push('Подключите устройство по IP или выполните сопряжение.');
    if (serial) {
      const p = await adb.pingDevice(serial);
      rep.sections.push({ id: 'response', title: 'Отклик устройства', ok: p.ok, lines: p.ok ? [`ответ за ${p.ms} мс`] : ['нет ответа'] });
      if (!p.ok) rep.suggestions.push('Проверьте, что телефон в той же сети и беспроводная отладка включена.');
    }
    // --- mDNS-сервисы adb: raw + статус warn вместо fail ---
    const m = await adb.mdnsServices();
    const raw = await adb.run(['mdns', 'services'], { timeout: 8000 }).catch(() => null);
    const rawLines = ((raw && raw.stdout) || '').split(/\r?\n/).filter(x => x.trim()).slice(0, 10);
    rep.sections.push({
      id: 'mdns',
      title: 'mDNS-сервисы (adb mdns services)',
      ok: m.ok, warn: m.ok && !m.items.length,
      lines: m.ok
        ? (m.items.length
          ? m.items.map(x => `${x.service} → ${x.host}:${x.port}`)
          : ['сервисов сейчас нет (это НЕ ошибка команды)', ...rawLines.map(x => '  raw: ' + x)])
        : [raw && raw.stderr ? ('команда вернула ошибку: ' + raw.stderr.trim().slice(0, 160)) : 'команда не ответила']
    });
    if (m.ok && !m.items.length) rep.suggestions.push('Откройте на телефоне экран «Беспроводная отладка» (сервисы публикуются только пока он открыт) и повторите диагностику. Если пусто и так — проверьте, что сеть Windows «Частная», а брандмауэр разрешает UDP 5353.');
    if (!m.ok) rep.suggestions.push('Команда «adb mdns services» не отработала — попробуйте перезапустить программу (adb-сервер перезапустится вместе с ней).');
    // --- собственный mDNS-клиент + unicast-свип (работают там, где adb mdns глушится сетью) ---
    const [mine, uni] = await Promise.all([
      mdns.discover(2500).catch(() => []),
      mdns.discoverUnicast(2500).catch(() => [])
    ]);
    rep.sections.push({
      id: 'mdns-own', title: 'mDNS-обнаружение (свой клиент)', ok: true, warn: !mine.length,
      lines: mine.length ? mine.map(x => `${(x.service || '').replace('.local', '')} → ${x.host}:${x.port}`) : ['мульткаст-ответов нет (роутер может резать multicast)']
    });
    rep.sections.push({
      id: 'mdns-uni', title: 'Unicast-обход подсети (роутеры без multicast)', ok: true, warn: !uni.length,
      lines: uni.length ? uni.map(x => `${(x.service || '').replace('.local', '')} → ${x.host}:${x.port}`) : ['unicast-ответов нет (телефон выключен/другая сеть)']
    });
    if (!mine.length && !uni.length) rep.suggestions.push('Телефон не виден по mDNS ни одним способом. Проверьте: телефон и ПК в одной Wi-Fi-сети; на телефоне включена «Беспроводная отладка»; сеть Windows помечена «Частной».');
    return rep;
  });

  /* ================= инфо об устройстве ================= */
  ipcMain.handle('dev:info', async (_e, serial) => {
    const g = async (args) => { const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 8000 }); return (r.stdout || '').trim(); };
    const [man, model, rel, bat, wm, df] = await Promise.all([
      g(['getprop', 'ro.product.manufacturer']), g(['getprop', 'ro.product.model']),
      g(['getprop', 'ro.build.version.release']), g(['dumpsys', 'battery']),
      g(['wm', 'size']), g(['df', '/data'])
    ]);
    const level = (bat.match(/level:\s*(\d+)/) || [])[1] || '?';
    const size = (wm.match(/(\d+x\d+)/) || [])[1] || '';
    let storage = null;
    const dfl = df.split(/\r?\n/)[1];
    if (dfl) { const p = dfl.split(/\s+/); storage = { total: p[1], used: p[2], free: p[3] }; }
    return { manufacturer: man, model, android: rel, battery: level, screen: size, storage };
  });

  /* ================= сохранённые устройства ================= */
  let saved = loadJson(SAVED_FILE, []); // путь — из верхнего уровня: Сохранения/saved.json (F16)
  ipcMain.handle('saved:list', async () => saved);
  ipcMain.handle('saved:add', async (_e, rec) => {
    rec.id = rec.id || String(Date.now());
    saved = saved.filter(x => !(x.host === rec.host && x.port === rec.port));
    saved.unshift(rec); saveJson(SAVED_FILE, saved); return saved;
  });
  ipcMain.handle('saved:remove', async (_e, id) => { saved = saved.filter(x => x.id !== id); saveJson(SAVED_FILE, saved); return saved; });
  ipcMain.handle('saved:rename', async (_e, id, name) => {
    const it = saved.find(x => x.id === id); if (it) { it.name = name; saveJson(SAVED_FILE, saved); }
    return saved;
  });

  /* ================= встроенное зеркало экрана ================= */
  ipcMain.handle('mirror:start', async (_e, serial, mode) => {
    mode = mode === 'jpeg' ? 'jpeg' : 'h264';
    if (mirrorMode) return { ok: false, error: 'Трансляция уже идёт' };
    if (!serial) return { ok: false, error: 'Нет активного устройства' };
    mirrorSerial = serial;
    mirrorMode = mode;
    mirrorGen++;
    const gen = mirrorGen;
    mirrorRestarts = 0;
    if (mode === 'h264') {
      spawnH264(serial, gen);
      // watchdog: 7 с без данных → renderer переключит в простой режим (R9)
      mirrorWatchdog = setInterval(() => {
        if (gen !== mirrorGen) return;
        if (Date.now() - mirrorLastData > 7000) sendTask({ kind: 'mirror-stalled' });
      }, 1000);
    } else {
      jpegTick();
    }
    log('mirror started', serial, mode);
    return { ok: true, mode, gen };
  });
  ipcMain.handle('mirror:stop', async () => { stopMirrorAll(); return { ok: true }; });
  ipcMain.handle('input:tap', async (_e, serial, x, y) => adb.run(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeout: 5000 }));
  ipcMain.handle('input:swipe', async (_e, serial, x1, y1, x2, y2, ms) => adb.run(['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)], { timeout: 8000 }));
  ipcMain.handle('input:key', async (_e, serial, key) => adb.run(['-s', serial, 'shell', 'input', 'keyevent', String(key)], { timeout: 5000 }));

  /* ================= свои команды терминала (F16): строго в «Сохранения/» ================= */
  let customCmds = loadJson(CMDS_FILE, []); // [{name, cmd}]
  ipcMain.handle('cmds:list', async () => customCmds);
  ipcMain.handle('cmds:add', async (_e, name, cmd) => {
    if (typeof name !== 'string' || !name.trim() || typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'Нужно имя и команда' };
    if (customCmds.length >= 200) return { ok: false, error: 'Слишком много своих команд (макс. 200)' };
    customCmds = customCmds.filter(c => c.cmd !== cmd.trim());
    customCmds.unshift({ name: name.trim().slice(0, 80), cmd: cmd.trim().slice(0, 500) });
    saveJson(CMDS_FILE, customCmds);
    return { ok: true, list: customCmds };
  });
  ipcMain.handle('cmds:remove', async (_e, cmd) => {
    customCmds = customCmds.filter(c => c.cmd !== cmd);
    saveJson(CMDS_FILE, customCmds);
    return { ok: true, list: customCmds };
  });

  /* ================= терминал adb shell ================= */
  ipcMain.handle('shell:start', async (_e, serial) => {
    if (shellChild) {
      // старую сессию глушим до создания новой — её close не должен затирать shellChild
      const prev = shellChild; shellChild = null;
      try { prev.removeAllListeners('close'); prev.kill('SIGKILL'); } catch (e) {}
    }
    const exe = adb.getAdbPath();
    const child = require('child_process').spawn(exe, ['-s', serial, 'shell'], { windowsHide: true });
    shellChild = child;
    child.stdout.on('data', d => { if (win && !win.isDestroyed()) win.webContents.send('shell:out', d.toString('utf8')); });
    child.stderr.on('data', d => { if (win && !win.isDestroyed()) win.webContents.send('shell:out', d.toString('utf8')); });
    child.on('close', () => { if (shellChild === child) { shellChild = null; sendTask({ kind: 'shell-stopped' }); } });
    return { ok: true };
  });
  ipcMain.handle('shell:write', async (_e, line) => {
    if (!shellChild) return { ok: false };
    shellChild.stdin.write(line + '\n'); return { ok: true };
  });
  ipcMain.handle('shell:stop', async () => {
    const c = shellChild; shellChild = null; // обнуляем ДО kill — close старого не сработает по identity
    if (c) { try { c.removeAllListeners('close'); c.kill('SIGKILL'); } catch (e) {} }
    return { ok: true };
  });

  /* ================= файловый менеджер ================= */
  // ls с КАВЫЧКОЙ пути (F1: «Мои клипы» с пробелом разваливался на два слова —
  // устройство отвечало «ls: клипы: No such file or directory»)
  // v2.6.0 (L2): путь нормализуем + хвостовой слэш — иначе ls -l /sdcard
  // показывает сам симлинк вместо содержимого («/sdcard не открывается»)
  ipcMain.handle('fs:list', async (_e, serial, dir) => {
    const d = normalizeFsDir(dir);
    const dirArg = d === '/' ? '/' : d + '/';
    let r = await adb.shellRun(serial, ['ls', '-lAp', dirArg], { timeout: 15000 });
    if (!r.ok || !(r.stdout || '').trim()) r = await adb.shellRun(serial, ['ls', '-la', dirArg], { timeout: 15000 });
    if (!r.ok) logErr('fs:list', serial, d, (r.stderr || r.error || '').slice(0, 200));
    const items = [];
    // toybox ls -l на Android: perms links user group size date name
    // (колонка links есть почти всегда; старые сборки — без неё; дата: «2024-05-01 10:12», «May 1 10:12» или «05-01 10:12»)
    const RE = /^([dl\-][rwxsStT\-]{8,})\s+(?:(\d+)\s+)?(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?|\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?|\d{2}-\d{2}\s+\d{1,2}:\d{2})\s+(.+)$/;
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(RE);
      if (!m) continue;
      let name = m[7];
      if (name === '.' || name === '..') continue;
      const isDir = m[1][0] === 'd' || name.endsWith('/');
      name = name.replace(/\/+$/, '');
      // симлинки toybox печатает как «имя -> цель» — оставляем только имя (W1-ревизор)
      const arrow = name.indexOf(' -> ');
      if (arrow > 0) name = name.slice(0, arrow);
      if (!name) continue;
      items.push({ name, dir: isDir, size: parseInt(m[5], 10) || 0, date: m[6], perms: m[1] });
    }
    // каталог вернул текст, но основной парсер не понял НИ ОДНОЙ строки — включаем
    // терпимый фолбэк-парсер (иначе пользователь видит «Папка пуста» там, где файлы есть — F3)
    if (!items.length && r.ok && (r.stdout || '').trim()) {
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || /^total/i.test(t)) continue;
        // имя = всё после последнего времени ЧЧ:ММ; perms — первый токен
        const m2 = t.match(/^(\S+)\s+.*?\s(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
        if (!m2) continue;
        let name = m2[3].replace(/\/+$/, '');
        const arrow = name.indexOf(' -> ');
        if (arrow > 0) name = name.slice(0, arrow);
        if (!name || name === '.' || name === '..') continue;
        // размер: последний чисто-числовой токен перед датой (W2-ревизор: старый mm-regex был мёртвым)
        const toks = t.split(/\s+/);
        const tIdx = toks.indexOf(m2[2]);
        let size = 0;
        for (let k = tIdx - 1; k > 0; k--) { if (/^\d+$/.test(toks[k])) { size = parseInt(toks[k], 10) || 0; break; } }
        const perms = (t.match(/^[dlbct\-][rwxsStT\-\.\+]{7,}/) || [''])[0];
        items.push({ name, dir: perms[0] === 'd', size, date: m2[2], perms });
      }
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: r.ok, items, path: d, error: r.ok ? null : (r.stderr || '').slice(0, 200) };
  });
  ipcMain.handle('fs:pull', async (_e, serial, remote) => {
    const f = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(remote)) });
    if (f.canceled) return { ok: false, canceled: true };
    // adb pull сам работает с argv (без shell) — кавычка не нужна, но 'adb pull' на
    // удалённой стороне путей с пробелами НЕ касаемся: тут путь идёт как аргумент протокола
    const r = await adb.run(['-s', serial, 'pull', remote, f.filePath], { timeout: 300000 });
    if (!r.ok) logErr('fs:pull', serial, remote, (r.stderr || '').slice(0, 150));
    return { ok: r.ok, file: f.filePath, message: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('fs:push', async (_e, serial, local, remoteDir) => {
    if (!local) {
      const f = await dialog.showOpenDialog(win, { properties: ['openFile'] });
      if (f.canceled) return { ok: false, canceled: true };
      local = f.filePaths[0];
    }
    // push в КОНКРЕТНУЮ открытую папку (F7): хвост слэша гарантирует «внутрь каталога»
    const target = /[\/]$/.test(remoteDir) ? remoteDir : remoteDir.replace(/\/+$/, '') + '/';
    const r = await adb.run(['-s', serial, 'push', local, target], { timeout: 300000 });
    if (!r.ok) logErr('fs:push', serial, local, target, (r.stderr || '').slice(0, 150));
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });
  // fs:cmd идёт ЧЕРЕЗ shellRun: аргументы (rm/mkdir/chmod + путь) кавычятся — пути с пробелами работают
  ipcMain.handle('fs:cmd', async (_e, serial, args) => {
    const r = await adb.shellRun(serial, Array.isArray(args) ? args : [String(args || '')], { timeout: 30000 });
    if (!r.ok) logErr('fs:cmd', serial, JSON.stringify(args).slice(0, 120), (r.stderr || '').slice(0, 150));
    return r;
  });

  // свойства файла/папки (F6)
  ipcMain.handle('fs:stat', async (_e, serial, remotePath) => {
    const out = { ok: false, path: remotePath };
    try {
      const q = adb.shq(remotePath);
      const st = await adb.run(['-s', serial, 'shell', `stat -c '%A|%F|%s|%u|%g|%y|%h|%b' ${q} 2>/dev/null`], { timeout: 12000 });
      const line = (st.stdout || '').trim().split(/\r?\n/)[0] || '';
      const p = line.split('|');
      if (p.length >= 8 && p[1]) {
        out.ok = true;
        out.perms = p[0]; out.kind = p[1]; out.size = parseInt(p[2], 10) || 0;
        out.uid = p[3]; out.gid = p[4]; out.mtime = p[5]; out.links = p[6]; out.blocks = parseInt(p[7], 10) || 0;
      }
      const isDir = /directory/i.test(out.kind || '') || (out.perms || '')[0] === 'd';
      if (out.ok && isDir) {
        const cnt = await adb.run(['-s', serial, 'shell', `ls -1A ${q} 2>/dev/null | wc -l`], { timeout: 12000 });
        out.items = parseInt((cnt.stdout || '0').trim(), 10) || 0;
        const du = await adb.run(['-s', serial, 'shell', `du -s ${q} 2>/dev/null`], { timeout: 30000 });
        const dkb = parseInt(((du.stdout || '').match(/^(\d+)/) || [])[1] || '0', 10) || 0;
        if (dkb) out.duBytes = dkb * 1024;
      }
      if (!out.ok) {
        // старые toybox без stat: фолбэк на ls -ld
        const ld = await adb.run(['-s', serial, 'shell', `ls -ld ${q}`], { timeout: 12000 });
        const t = (ld.stdout || '').trim();
        if (t) {
          out.ok = true;
          out.perms = (t.match(/^[dlbct\-][rwxsStT\-\.\+]{7,}/) || [''])[0] || '';
          out.kind = out.perms[0] === 'd' ? 'directory' : 'regular file';
          out.lsLine = t;
        }
      }
    } catch (e) { logErr('fs:stat', serial, remotePath, e.message); }
    return out;
  });

  /* ================= менеджер приложений ================= */
  ipcMain.handle('apps:list', async (_e, serial) => {
    const [u, s, d] = await Promise.all([
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 20000 }),
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-s'], { timeout: 20000 }),
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-d'], { timeout: 20000 })
    ]);
    const parse = x => (x.stdout || '').split(/\r?\n/).filter(l => l.startsWith('package:')).map(l => l.slice(8).trim());
    const disabled = new Set(parse(d));
    return {
      ok: true,
      user: parse(u), system: parse(s),
      disabled: Array.from(disabled)
    };
  });
  ipcMain.handle('apps:action', async (_e, serial, action, pkg) => {
    const map = {
      disable: ['pm', 'disable-user', '--user', '0', pkg],
      enable: ['pm', 'enable', '--user', '0', pkg],
      removeUser: ['pm', 'uninstall', '-k', '--user', '0', pkg],
      restore: ['pm', 'install-existing', pkg],
      clear: ['pm', 'clear', pkg],
      // кэш без удаления данных (Android 13+; на старых версиях честно вернётся ошибка — F12)
      clearCache: ['pm', 'clear', '--cache-only', pkg],
      forceStop: ['am', 'force-stop', pkg],
      uninstall: ['pm', 'uninstall', pkg]
    };
    const args = map[action];
    if (!args) return { ok: false, error: 'Неизвестное действие' };
    const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 60000 });
    const ok = r.ok && /success|Success/i.test(r.stdout || '');
    if (!ok) logErr('apps:action', action, pkg, ((r.stdout || '') + ' ' + (r.stderr || '')).trim().slice(0, 150));
    return { ok, message: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('apps:perms', async (_e, serial, pkg) => {
    const r = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 20000 });
    const out = [];
    for (const m of (r.stdout || '').matchAll(/^\s*([a-z][\w.]*\.permission[a-zA-Z0-9_.]*|[a-z][\w.]*\.[A-Z][\w.]*):\s*granted=(true|false)/gmi)) {
      const perm = m[1];
      if (!out.some(x => x.perm === perm)) out.push({ perm, granted: m[2] === 'true' });
    }
    return { ok: r.ok, perms: out };
  });
  ipcMain.handle('apps:perm', async (_e, serial, action, pkg, perm) => {
    const r = await adb.run(['-s', serial, 'shell', 'pm', action, pkg, perm], { timeout: 15000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('apps:backup', async (_e, serial, pkgs) => {
    const dir = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (dir.canceled) return { ok: false, canceled: true };
    let done = 0;
    for (const pkg of pkgs) {
      const p = await adb.run(['-s', serial, 'shell', 'pm', 'path', pkg], { timeout: 15000 });
      const apk = (p.stdout.match(/package:(\S+)/) || [])[1];
      if (!apk) continue;
      const dest = path.join(dir.filePaths[0], pkg + '.apk');
      const r = await adb.run(['-s', serial, 'pull', apk, dest], { timeout: 300000 });
      if (r.ok) done++;
    }
    return { ok: done > 0, done, total: pkgs.length, dir: dir.filePaths[0] };
  });
  ipcMain.handle('dev:full', async (_e, serial) => {
    const g = async (args) => { const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 8000 }); return (r.stdout || '').trim(); };
    const [man, model, rel, patch, abi, build, bat, wm, df, mem, up, host] = await Promise.all([
      g(['getprop', 'ro.product.manufacturer']), g(['getprop', 'ro.product.model']),
      g(['getprop', 'ro.build.version.release']), g(['getprop', 'ro.build.version.security_patch']),
      g(['getprop', 'ro.product.cpu.abi']), g(['getprop', 'ro.build.display.id']),
      g(['dumpsys', 'battery']), g(['wm', 'size']), g(['df', '/data']),
      g(['cat', '/proc/meminfo']), g(['uptime']), g(['getprop', 'net.hostname'])
    ]);
    const level = (bat.match(/level:\s*(\d+)/) || [])[1] || '?';
    const size = (wm.match(/(\d+x\d+)/) || [])[1] || '';
    const memLine = (mem.split(/\r?\n/)[0] || '').replace(/\D+/g, ' ');
    const dfl = df.split(/\r?\n/)[1];
    let storage = null;
    if (dfl) { const p = dfl.split(/\s+/); storage = { total: p[1], used: p[2], free: p[3] }; }
    return { manufacturer: man, model, android: rel, patch, abi, build, battery: level, screen: size, storage, memTotalKb: memLine.trim().split(' ')[0] || '', uptime: up.split('\n')[0], hostname: host, serial };
  });
  ipcMain.handle('fs:volumes', async (_e, serial) => {
    const r = await adb.run(['-s', serial, 'shell', 'ls', '/storage'], { timeout: 8000 });
    const vols = (r.stdout || '').split(/\s+/).filter(Boolean);
    return { ok: r.ok, vols };
  });
  // родные иконки И ИМЕНА приложений: один pull даёт и то и другое (F9/F11);
  // кэш — в «Сохранения/Кэш иконок» + файл labels.json; негативный кэш неудач (R12)
  const iconFail = new Set();
  const labelsFile = () => path.join(ICON_CACHE, 'labels.json');
  function labelsLoad() { return loadJson(labelsFile(), {}); }
  function labelsSave(m) { saveJson(labelsFile(), m); }
  ipcMain.handle('apps:labels', async () => labelsLoad()); // мгновенно: всё, что уже известно
  ipcMain.handle('apps:icon', async (_e, serial, pkg) => {
    try {
      if (iconFail.has(pkg)) return { ok: false, failed: true };
      fs.mkdirSync(ICON_CACHE, { recursive: true });
      const key = pkg.replace(/[^a-z0-9._]/gi, '_');
      const cachePng = path.join(ICON_CACHE, key + '.png');
      const labels = labelsLoad();
      const cachedLabel = labels[pkg] || null;
      if (fs.existsSync(cachePng)) {
        return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(cachePng).toString('base64'), label: cachedLabel };
      }
      const p = await adb.run(['-s', serial, 'shell', 'pm', 'path', pkg], { timeout: 10000 });
      const apk = (p.stdout.match(/package:(\S+)/) || [])[1];
      if (!apk) { iconFail.add(pkg); return { ok: false, label: cachedLabel }; }
      const sz = await adb.run(['-s', serial, 'shell', 'stat', '-c', '%s', adb.shq(apk)], { timeout: 10000 });
      if (parseInt(sz.stdout, 10) > 120 * 1024 * 1024) { iconFail.add(pkg); return { ok: false, label: cachedLabel }; }
      const tmp = path.join(os.tmpdir(), 'icon-' + key + '.apk');
      const pr = await adb.run(['-s', serial, 'pull', apk, tmp], { timeout: 240000 });
      if (!pr.ok) { iconFail.add(pkg); return { ok: false, label: cachedLabel }; }
      const apkBuf = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (e) {}
      const meta = require('./apkicon.js').extractMeta(apkBuf);
      if (!meta || (!meta.icon && !meta.label)) { iconFail.add(pkg); return { ok: false, label: cachedLabel }; }
      let label = cachedLabel;
      if (meta.label && !labels[pkg]) {
        labels[pkg] = meta.label; label = meta.label; labelsSave(labels);
      }
      if (meta.icon) fs.writeFileSync(cachePng, meta.icon.data);
      return meta.icon
        ? { ok: true, dataUrl: 'data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64'), label }
        : { ok: false, label };
    } catch (e) { iconFail.add(pkg); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('procs:list', async (_e, serial) => {
    // RSS нужен для колонки памяти; на старых toybox -o может не быть — фолбэк на «ps -A»
    let r = await adb.run(['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,RSS,NAME'], { timeout: 15000 });
    let simple = false;
    if (!r.ok || !/PID/.test(r.stdout || '')) {
      r = await adb.run(['-s', serial, 'shell', 'ps', '-A'], { timeout: 15000 });
      simple = true;
    }
    const items = [];
    const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (simple) {
        // USER PID PPID VSIZE RSS WCHAN ADDR S NAME (в конце, возможны пробелы)
        const mm = t.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S\s+(.+)$/);
        if (mm) items.push({ pid: +mm[2], name: mm[6].trim(), rss: +mm[5] || 0 });
      } else {
        const mm = t.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (mm) items.push({ pid: +mm[1], rss: +mm[2] || 0, name: mm[3].trim() });
      }
    }
    return { ok: r.ok, items };
  });
  ipcMain.handle('procs:kill', async (_e, serial, pid) => {
    const r = await adb.run(['-s', serial, 'shell', 'kill', '-9', String(pid)], { timeout: 10000 });
    if (!r.ok) logErr('procs:kill', serial, pid, (r.stderr || '').slice(0, 120));
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('wm:setsize', async (_e, serial, v) => {
    const args = v === 'reset' ? ['wm', 'size', 'reset'] : ['wm', 'size', v];
    const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 10000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });

  /* ================= v2.6.0: просмотрщик/плеер — бинарное чтение файла с телефона ================= */
  // exec-out cat — единственный быстрый способ забрать файл без диалога сохранения;
  // сырой spawn (adb.run текстовый, бинарник портит). Прогресс — в renderer событиями.
  // v2.7.0: maxMB — отдельный лимит для текстов/PDF (8 МБ), медиа — как раньше (768 МБ).
  ipcMain.handle('fs:cat', async (e, serial, remote, maxMB) => {
    const exe = adb.getAdbPath();
    if (!exe) return { ok: false, error: 'adb не найден' };
    const MAX = Math.max(1, parseInt(maxMB, 10) || 768) * 1024 * 1024;
    return await new Promise((resolve) => {
      const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'cat ' + adb.shq(remote)], { windowsHide: true });
      const chunks = []; let bytes = 0; let lastE = 0; let capped = false;
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) {} }, 300000);
      child.stdout.on('data', d => {
        bytes += d.length;
        if (bytes > MAX) { if (!capped) { capped = true; try { child.kill('SIGKILL'); } catch (err) {} } return; }
        chunks.push(d);
        if (Date.now() - lastE > 350) { lastE = Date.now(); try { e.sender.send('task:event', { kind: 'fsload-progress', file: remote, bytes }); } catch (err) {} }
      });
      child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on('close', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (capped) return resolve({ ok: false, capped: true, error: 'Файл слишком большой для просмотра в окне (' + Math.round(MAX / 1048576) + ' МБ лимит) — скачайте его кнопкой «Скачать»' });
        // пустой ответ и/или «cat: <path>: No such file» — отдаём ошибку
        if (!buf.length) return resolve({ ok: false, error: 'Устройство не вернуло файл (путь существует?)' });
        resolve({ ok: true, buf, bytes });
      });
    });
  });

  /* ================= v2.7.0: открыть файл с телефона в ПОЛЬЗОВАТЕЛЬСКОЙ программе на ПК ============ */
  // HTML — в системном браузере (триjs-анимации требуют CDN и полного JS), видео/аудио с редкими
  // кодеками — в системном плеере, PDF — в системной программе. Файл тянется во временную папку.
  ipcMain.handle('fs:open-on-pc', async (e, serial, remote) => {
    const exe = adb.getAdbPath();
    if (!exe) return { ok: false, error: 'adb не найден' };
    const tmpDir = path.join(os.tmpdir(), 'adbwifi-open');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (err) {}
    const local = path.join(tmpDir, path.basename(remote).replace(/[\\/:*?"<>|]/g, '_'));
    sendTask({ kind: 'fsload-progress', file: remote, bytes: 0 });
    const r = await adb.run(['-s', serial, 'pull', remote, local], { timeout: 600000 });
    if (!r.ok) return { ok: false, error: 'Не удалось скачать файл: ' + ((r.stderr || r.error || '').trim().slice(0, 150) || 'ошибка') };
    const open = await shell.openPath(local);
    return open ? { ok: false, error: 'Файл скачан (' + local + '), но системная программа его не открыла: ' + open } : { ok: true, file: local };
  });

  /* ================= v2.7.0: распаковка архива на устройстве (свойства → «Распаковать») ============ */
  // Поддержка: zip/jar (unzip на устройстве; если unzip нет — скачаем на ПК, распакуем своим
  // парсером и зальём обратно), tar/tar.gz/tgz/tar.bz2/tar.xz (tar на устройстве).
  // RAR/7z честно отклоняем: распаковщиков на Android нет.
  ipcMain.handle('fs:extract', async (e, serial, remote) => {
    const base = path.basename(remote);
    const dir = path.posix.dirname(remote.replace(/\\/g, '/'));
    const mExt = base.match(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|zip|jar|tar)$/i);
    if (!mExt) return { ok: false, error: 'Распаковка поддерживается для ZIP/JAR/TAR(.gz/.bz2/.xz). RAR и 7z на устройстве распаковать нельзя — скачайте файл и распакуйте на компьютере.' };
    const ext = mExt[1].toLowerCase();
    const folderName = base.slice(0, base.length - mExt[0].length).replace(/[\\/:*?"<>|]/g, '_').trim() || 'archive';
    const dest = (dir === '/' ? '' : dir) + '/' + folderName;
    const q = (s) => adb.shq(s);
    const run = (args, timeout) => adb.run(['-s', serial, 'shell', args], { timeout: timeout || 600000 });
    // 1) создаём папку
    const mk = await run(`mkdir -p ${q(dest)}`, 15000);
    if (!mk.ok) return { ok: false, error: 'Не удалось создать папку ' + dest + ': ' + ((mk.stderr || '').slice(0, 120)) };
    // 2) пробуем распаковать НА УСТРОЙСТВЕ
    let cmd = null;
    if (ext === 'zip' || ext === 'jar') cmd = `unzip -o -q ${q(remote)} -d ${q(dest)} 2>/dev/null || unzip -o ${q(remote)} -d ${q(dest)} 2>/dev/null`; // -q есть не везде
    else if (ext === 'tar') cmd = `tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.gz' || ext === 'tgz') cmd = `tar -zxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.bz2' || ext === 'tbz2') cmd = `tar -jxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.xz') cmd = `tar -Jxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    sendTask({ kind: 'fs-extract-progress', file: base, stage: 'device' });
    let r = cmd ? await run(cmd, 900000) : { ok: false };
    let where = 'на устройстве';
    // 3) фолбэк: unzip отсутствует на устройстве — распаковываем НА ПК и заливаем папку
    if ((!r.ok || /not found|not recognized/i.test((r.stderr || '') + (r.stdout || ''))) && (ext === 'zip' || ext === 'jar')) {
      sendTask({ kind: 'fs-extract-progress', file: base, stage: 'pc' });
      const st = await adb.run(['-s', serial, 'shell', `stat -c %s ${q(remote)}`], { timeout: 15000 }).catch(() => null);
      const size = parseInt((st && st.stdout) || '0', 10) || 0;
      if (size > 300 * 1024 * 1024) return { ok: false, error: 'На устройстве нет unzip, а архив больше 300 МБ — скачайте его и распакуйте на компьютере.' };
      const tmpZip = path.join(os.tmpdir(), 'adbwifi-ext-' + Date.now() + '-' + base.replace(/[^\w.\-]/g, '_'));
      const pulled = await adb.run(['-s', serial, 'pull', remote, tmpZip], { timeout: 600000 });
      if (!pulled.ok) return { ok: false, error: 'Не удалось скачать архив для распаковки: ' + ((pulled.stderr || '').slice(0, 120)) };
      try {
        const buf = fs.readFileSync(tmpZip);
        const z = require('./apkicon.js').parseZip(buf);
        if (!z) throw new Error('архив повреждён или защищён паролем');
        const names = Object.keys(z.entries).filter(n => !n.endsWith('/'));
        let done = 0;
        const tmpRoot = path.join(os.tmpdir(), 'adbwifi-extd-' + Date.now());
        fs.mkdirSync(tmpRoot, { recursive: true });
        for (const n of names) {
          const data = require('./apkicon.js').zipRead(z, n);
          if (!data) continue;
          const safe = n.replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '__'); // защита от ../
          const outP = path.join(tmpRoot, safe);
          fs.mkdirSync(path.dirname(outP), { recursive: true });
          fs.writeFileSync(outP, data);
          done++;
        }
        const pushed = await adb.run(['-s', serial, 'push', tmpRoot + '/.', dest + '/'], { timeout: 900000 });
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.unlinkSync(tmpZip); } catch (err) {}
        if (!pushed.ok) return { ok: false, error: 'Распаковано на ПК (' + done + ' файлов), но загрузка на телефон не удалась: ' + ((pushed.stderr || '').slice(0, 120)) };
        r = { ok: true, stdout: '' };
        where = 'на компьютере (на устройстве нет unzip)';
      } catch (err) {
        try { fs.unlinkSync(tmpZip); } catch (e2) {}
        return { ok: false, error: 'Распаковка не удалась: ' + err.message };
      }
    }
    if (!r.ok) {
      const msg = ((r.stderr || r.stdout || '').trim().split('\n')[0] || '').slice(0, 160);
      await run(`rm -rf ${q(dest)}`, 30000).catch(() => {});
      return { ok: false, error: 'Распаковать не удалось' + (msg ? ': ' + msg : '') + '. Если это RAR/7z — на устройстве нет распаковщика, скачайте файл.' };
    }
    const cnt = await run(`find ${q(dest)} -type f 2>/dev/null | wc -l`, 30000);
    const files = parseInt((cnt.stdout || '0').trim(), 10) || 0;
    return { ok: true, dest, files, where };
  });

  /* ================= v2.7.0: открыть ЛОКАЛЬНЫЙ файл системной программой ================= */
  ipcMain.handle('shell:open-path', async (_e, p) => {
    try {
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'Файл не найден: ' + p };
      const err = await shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ================= v2.7.0: мета APK-ФАЙЛА на телефоне (иконка/имя для файлового менеджера) === */
  // Тянем APK во временную папку (лимит 80 МБ), разбираем apkicon.js, иконку кладём в кэш.
  // Ключ кэша — имя+размер: один раз скачали — дальше мгновенно.
  const fsApkFail = new Set();
  ipcMain.handle('apk:remotemeta', async (_e, serial, remotePath) => {
    try {
      const q = adb.shq(remotePath);
      const st = await adb.run(['-s', serial, 'shell', `stat -c '%s|%Y' ${q} 2>/dev/null`], { timeout: 15000 });
      const [sz, mt] = ((st.stdout || '').trim().split('|'));
      const size = parseInt(sz, 10) || 0;
      if (size > 80 * 1024 * 1024) return { ok: false, reason: 'big', size };
      fs.mkdirSync(ICON_CACHE, { recursive: true });
      const key = require('crypto').createHash('sha1').update(remotePath + '|' + size).digest('hex').slice(0, 20);
      const cachePng = path.join(ICON_CACHE, 'fs-' + key + '.png');
      const labels = labelsLoad();
      if (fs.existsSync(cachePng)) {
        return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(cachePng).toString('base64'), label: labels['fs:' + key] || null, size, mtime: (parseInt(mt, 10) || 0) * 1000 };
      }
      if (fsApkFail.has(key)) return { ok: false, reason: 'fail', size };
      const tmp = path.join(os.tmpdir(), 'icon-' + key + '.apk');
      const pr = await adb.run(['-s', serial, 'pull', remotePath, tmp], { timeout: 300000 });
      if (!pr.ok) { fsApkFail.add(key); return { ok: false, reason: 'pull', size }; }
      let meta = null;
      try { meta = require('./apkicon.js').extractMeta(fs.readFileSync(tmp)); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (meta && meta.icon) fs.writeFileSync(cachePng, meta.icon.data);
      if (meta && meta.label) { labels['fs:' + key] = meta.label; labelsSave(labels); }
      if (!meta || (!meta.icon && !meta.label)) { fsApkFail.add(key); return { ok: false, reason: 'meta', size }; }
      return {
        ok: true,
        dataUrl: meta.icon ? ('data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64')) : null,
        label: meta.label || null, package: meta.package || null, versionName: meta.versionName || null,
        size, mtime: (parseInt(mt, 10) || 0) * 1000
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ================= v2.7.0: иконка процесса ТОЛЬКО ИЗ КЭША (без скачивания APK) ============ */
  ipcMain.handle('apps:icon-peek', async (_e, pkg) => {
    try {
      const key = String(pkg).replace(/[^a-z0-9._]/gi, '_');
      const cachePng = path.join(ICON_CACHE, key + '.png');
      if (fs.existsSync(cachePng)) {
        return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(cachePng).toString('base64'), label: labelsLoad()[pkg] || null };
      }
      return { ok: false, label: labelsLoad()[pkg] || null };
    } catch (e) { return { ok: false }; }
  });

  /* ================= v2.6.0: мета локальных APK (иконка/имя/пакет/версия) ================= */
  ipcMain.handle('apk:localmeta', async (_e, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: 'Файл не найден' };
      const st = fs.statSync(filePath);
      if (!st.isFile()) return { ok: false, error: 'Это не файл' };
      if (st.size > 400 * 1024 * 1024) return { ok: false, error: 'Файл больше 400 МБ — слишком большой для разбора', size: st.size };
      const buf = fs.readFileSync(filePath);
      const meta = require('./apkicon.js').extractMeta(buf);
      return {
        ok: true, size: st.size, mtime: st.mtimeMs,
        icon: meta && meta.icon ? ('data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64')) : null,
        label: (meta && meta.label) || null,
        package: (meta && meta.package) || null,
        versionName: (meta && meta.versionName) || null,
        versionCode: (meta && meta.versionCode) || null
      };
    } catch (e2) { return { ok: false, error: e2.message }; }
  });

  /* ================= v2.6.0: размеры/даты приложений для сортировки ================= */
  // один раз собираем пути APK (pm list packages -f), потом статы пачками; кэш на serial
  const appMetaCache = new Map(); // serial -> {ts, map}
  ipcMain.handle('apps:meta', async (_e, serial, pkgs) => {
    const c = appMetaCache.get(serial);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return { ok: true, meta: c.map };
    const want = new Set(Array.isArray(pkgs) ? pkgs : []);
    const paths = new Map(); // pkg -> apk path
    for (const extra of [['-3'], ['-s']]) {
      const r = await adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-f', ...extra], { timeout: 25000 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^package:(\S+)=(.+)$/);
        if (m && (!want.size || want.has(m[2]))) paths.set(m[2], m[1]);
      }
    }
    const list = Array.from(paths.entries());
    const map = {};
    const CH = 40;
    for (let i = 0; i < list.length; i += CH) {
      const chunk = list.slice(i, i + CH);
      const statArgs = chunk.map(([, p]) => adb.shq(p)).join(' ');
      const st = await adb.run(['-s', serial, 'shell', "stat -c '%n|%s|%Y' " + statArgs], { timeout: 30000 }).catch(() => null);
      const t = (st && st.stdout) || '';
      for (const line of t.split(/\r?\n/)) {
        const pr = line.trim().split('|');
        if (pr.length < 3) continue;
        const pkg = Array.from(paths.entries()).find(([, p]) => p === pr[0]);
        if (!pkg) continue;
        map[pkg[0]] = { size: parseInt(pr[1], 10) || 0, mtime: (parseInt(pr[2], 10) || 0) * 1000 };
      }
    }
    appMetaCache.set(serial, { ts: Date.now(), map });
    return { ok: true, meta: map };
  });

  /* ================= v2.6.0: «Завершить все приложения» в процессах ================= */
  ipcMain.handle('procs:killapps', async (_e, serial, pkgs) => {
    const list = (Array.isArray(pkgs) ? pkgs : []).slice(0, 300);
    let killed = 0;
    for (const p of list) {
      // am kill мягче force-stop: убивает только фоновые процессы пакета
      const r = await adb.run(['-s', serial, 'shell', 'am', 'kill', String(p)], { timeout: 8000 });
      if (r.ok) killed++;
    }
    return { ok: killed > 0, killed, total: list.length };
  });

  /* ================= v2.6.0: ассоциации файлов APK на уровне системы ================= */
  const ASSOC_EXTS = ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apk.1', 'apk+', 'apup'];
  const ASSOC_PROGID = 'AdbWifiConnectorRu.APKFile';
  function assocRegArgs(on, exe) {
    const key = 'HKCU\\Software\\Classes\\';
    const args = [];
    if (on) {
      for (const ext of ASSOC_EXTS) {
        args.push(['add', key + '.' + ext, '/ve', '/t', 'REG_SZ', '/d', ASSOC_PROGID, '/f']);
      }
      args.push(['add', key + ASSOC_PROGID, '/ve', '/t', 'REG_SZ', '/d', 'Установка APK — ADB Wi-Fi Коннектор', '/f']);
      args.push(['add', key + ASSOC_PROGID + '\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', `"${exe},0"`, '/f']);
      args.push(['add', key + ASSOC_PROGID + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f']);
    } else {
      for (const ext of ASSOC_EXTS) args.push(['delete', key + '.' + ext, '/ve', '/f']);
      args.push(['delete', key + ASSOC_PROGID, '/f']);
    }
    return args;
  }
  function regBatch(args) {
    return new Promise((resolve) => {
      let i = 0, errs = [];
      const next = () => {
        if (i >= args.length) return resolve({ ok: errs.length === 0, errors: errs });
        execFile('reg.exe', args[i++], { windowsHide: true }, (err, out, errOut) => {
          if (err) errs.push(String(errOut || err.message).slice(0, 120));
          next();
        });
      };
      next();
    });
  }
  ipcMain.handle('assoc:get', async () => {
    const state = {};
    for (const ext of ASSOC_EXTS) {
      state[ext] = await new Promise((resolve) => {
        execFile('reg.exe', ['query', 'HKCU\\Software\\Classes\\.' + ext, '/ve'], { windowsHide: true }, (err, out) => {
          resolve(!err && String(out || '').includes(ASSOC_PROGID));
        });
      });
    }
    return { ok: true, state, note: 'apks.zip / apk.zip — двойные расширения, Windows их не ассоциирует: открывайте через правую кнопку → «Открыть с помощью»' };
  });
  ipcMain.handle('assoc:set', async (_e, on) => {
    if (!process.platform.startsWith('win')) return { ok: false, error: 'Только Windows' };
    const r = await regBatch(assocRegArgs(!!on, process.execPath));
    return r;
  });

  /* ================= v2.6.0: очередь установки APK (новая вкладка) ================= */
  // поддерживает: .apk | .apks/.xapk/.apkm/.apks.zip/.apk.zip (сплиты через install-multiple)
  // | .obb (push в Android/obb) | .aab — честная ошибка (нужен bundletool)
  ipcMain.handle('apk:installbatch', async (e, serial, files) => {
    const list = (Array.isArray(files) ? files : []).filter(x => x && typeof x.path === 'string').slice(0, 40);
    if (!list.length) return { ok: false, error: 'Список пуст' };
    installCanceled = false;
    const { spawn: sp } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), 'adbwifi-apk-' + Date.now());
    let installed = 0, failed = 0, canceled = false;
    const send = (obj) => { try { e.sender.send('task:event', Object.assign({ kind: 'apk-queue' }, obj)); } catch (err) {} };

    const runInstall = (args) => new Promise((resolve) => {
      const exe = adb.getAdbPath();
      if (!exe) return resolve({ ok: false, message: 'adb не найден' });
      const child = sp(exe, args, { windowsHide: true });
      installChild = child;
      let out = '';
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) {} resolve({ ok: false, message: 'Таймаут установки' }); }, 600000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('error', err => { clearTimeout(t); resolve({ ok: false, message: err.message }); });
      child.on('close', () => { clearTimeout(t); installChild = null; resolve({ ok: /success/i.test(out), message: out.trim().split(/\r?\n/).pop() || '' }); });
    });

    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (err) {}
    for (let i = 0; i < list.length; i++) {
      if (installCanceled) { canceled = true; break; }
      const fp = list[i].path, base = path.basename(fp);
      const send2 = (stage, message) => send({ index: i, total: list.length, file: base, stage, message });
      send2('run', '');
      if (!fs.existsSync(fp)) { failed++; send2('fail', 'файл не найден'); continue; }
      try {
        if (/\.aab$/i.test(fp)) {
          failed++; send2('fail', 'AAB — формат для Google Play: соберите APK через bundletool и установите его');
          continue;
        }
        if (/\.obb$/i.test(fp)) {
          // расширение игры: кладём в /sdcard/Android/obb/<pkg или корень obb>
          let pkg = (list[i].meta && list[i].meta.package) || null;
          if (!pkg) pkg = (base.match(/^([\w.]+)[._]/) || [])[1] || null;
          const dst = '/sdcard/Android/obb' + (pkg ? '/' + pkg : '');
          await adb.run(['-s', serial, 'shell', 'mkdir', '-p', adb.shq(dst)], { timeout: 15000 });
          const pr = await adb.run(['-s', serial, 'push', fp, dst + '/'], { timeout: 600000 });
          if (pr.ok) { installed++; send2('done', 'OBB скопирован в ' + dst); }
          else { failed++; send2('fail', 'push не удался: ' + ((pr.stderr || '').slice(0, 120) || 'ошибка')); }
          continue;
        }
        if (/\.(apks|xapk|apkm)$/i.test(fp) || /\.apks\.zip$|\.apk\.zip$/i.test(fp)) {
          // сплит-пакет: достаём все *.apk и ставим одним сеансом install-multiple
          send2('run', 'разбираю сплит-пакет…');
          const buf = fs.readFileSync(fp);
          const z = require('./apkicon.js').parseZip(buf);
          if (!z) { failed++; send2('fail', 'архив повреждён'); continue; }
          const names = Object.keys(z.entries).filter(n => /\.apk$/i.test(n));
          if (!names.length) { failed++; send2('fail', 'внутри архива нет .apk'); continue; }
          // base.apk первым (или самый большой) — так надёжнее для install-multiple
          names.sort((a, b) => {
            const ba = /(^|\/)base\.apk$/i.test(a) ? 2 : 0, bb = /(^|\/)base\.apk$/i.test(b) ? 2 : 0;
            if (ba !== bb) return bb - ba;
            return (z.entries[b].csize || 0) - (z.entries[a].csize || 0);
          });
          const parts = [];
          for (const n of names) {
            const data = require('./apkicon.js').zipRead(z, n);
            if (!data) continue;
            const tmpF = path.join(tmpDir, i + '-' + path.basename(n));
            fs.writeFileSync(tmpF, data);
            parts.push(tmpF);
          }
          if (!parts.length) { failed++; send2('fail', 'не удалось распаковать сплиты'); continue; }
          const r = await runInstall(['-s', serial, 'install-multiple', '-r', ...parts]);
          if (r.ok) { installed++; send2('done', 'установлено (сплит: ' + parts.length + ' части)'); }
          else { failed++; send2('fail', r.message || 'ошибка установки'); }
          for (const p of parts) { try { fs.unlinkSync(p); } catch (err) {} }
          continue;
        }
        // обычный .apk (и .apk.1/.apk+/.apup — это просто переименованные apk)
        const r = await runInstall(['-s', serial, 'install', '-r', fp]);
        if (r.ok) { installed++; send2('done', 'установлено'); }
        else { failed++; send2('fail', (r.message || 'ошибка установки').slice(0, 160)); }
      } catch (err) {
        failed++; send2('fail', err.message);
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {}
    return { ok: installed > 0, installed, failed, canceled };
  });
  ipcMain.handle('apk:installcancel', async () => {
    installCanceled = true;
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    return { ok: true };
  });
}

// ---------- запуск ----------
const gotLock = app.requestSingleInstanceLock();
// v2.6.0: ассоциации файлов — двойной клик по .apk/.xapk/.obb открывает мини-окно установки.
// Файл может прийти и в первом запуске (argv), и во второй инстанс (second-instance).
function fileFromArgv(argv) {
  for (const a of (argv || []).slice(1)) {
    try {
      if (a && fs.existsSync(a) && fs.statSync(a).isFile() &&
          /\.(apk|aab|apks|xapk|apkm|obb|apk\.1|apk\+|apup|apks\.zip|apk\.zip)$/i.test(a)) return a;
    } catch (e) {}
  }
  return null;
}
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (f) {
      // v2.7.0: APK с рабочего стола открывается в ОТДЕЛЬНОМ окошке, основную программу не показываем
      if (!openApkStandalone(f)) { if (win) { win.show(); win.focus(); } sendTask({ kind: 'open-apk', path: f }); }
      return;
    }
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(async () => {
    loadAll();
    createWindow();
    registerIpc();
    tray = new Tray(trayIcon());
    buildTrayMenu();
    tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()); });
    // файл, переданный ассоциацией при ПЕРВОМ запуске (argv[1]) — после загрузки renderer
    const openFile = fileFromArgv(process.argv);
    if (openFile) setTimeout(() => {
      if (!openApkStandalone(openFile)) sendTask({ kind: 'open-apk', path: openFile });
    }, 1200);

    // R3: автоподключение ТОЛЬКО если владелец явно включил его в настройках; при этом
    // подключается строго ОДНО устройство (последнее используемое / первое живое избранное)
    if (config.autolast && history.length) {
      const h = history[0];
      setTimeout(() => connectDevice(h.host, h.port), 1500);
    } else if (config.autoreconnect && favorites.length) {
      setTimeout(async () => {
        for (const f of favorites) {
          const r = await connectDevice(f.host, f.port);
          if (r.ok) break; // строго одно: до первого успеха
        }
      }, 1500);
    }
  });
  app.on('window-all-closed', () => { if (!config.closeToTray) app.quit(); });
  app.on('before-quit', (e) => {
    quitting = true;
    // W4-ревизор: запись экрана добиваем СИГНАЛОМ НА УСТРОЙСТВЕ (SIGINT device-side):
    // device-screenrecord финализирует mp4-контейнер — файл остаётся играбельным,
    // и владелец найдёт его в Movies/ADB-WiFi-Connector (просто закрыл программу во время записи)
    if (recordChild && recordMeta) {
      try { adb.runSync(['-s', recordMeta.serial, 'shell', 'kill -2 $(pidof screenrecord) 2>/dev/null'], 1500); } catch (err) {}
    }
    // гасим ВСЕ свои дочерние процессы (A2-ревью: mirror/shell/install раньше переживали выход)
    stopMirrorAll();
    try { if (shellChild) shellChild.kill('SIGKILL'); } catch (e) {}
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    try { if (logcatChild) logcatChild.kill('SIGKILL'); } catch (e) {}
    try { if (recordChild) recordChild.kill('SIGKILL'); } catch (e) {}
    try { qrpair.cancel(); } catch (e) {}
    try { adb.killServer(); } catch (e) {}
  });
  process.on('exit', () => { try { adb.killServer(); } catch (e) {} });
}
