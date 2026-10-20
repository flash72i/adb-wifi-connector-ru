// preload.js — мост между renderer и main (contextIsolation: true)
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  // окно
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),

  // состояние / настройки
  getState: invoke('state:get'),
  setSetting: invoke('settings:set'),
  pickFile: invoke('dialog:pick-file'),   // возвращает МАССИВ путей (мульти-выбор поддерживается)
  pickSave: invoke('dialog:pick-save'),
  showItem: invoke('shell:show-item'),
  openExternal: invoke('shell:open-external'),

  // adb
  adbConnect: invoke('adb:connect'),
  adbDisconnect: invoke('adb:disconnect'),
  adbDevices: invoke('adb:devices'),
  adbPair: invoke('adb:pair'),
  adbAutoPair: invoke('adb:auto-pair'),
  adbPortScan: invoke('adb:port-scan'),
  adbPing: invoke('adb:ping'),
  scanSubnet: invoke('adb:scan-subnet'),
  mdnsDiscover: invoke('adb:mdns'),
  adbVersion: invoke('adb:version'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return (file && file.path) || null; } }, // file.path удалён в Electron 32+
  qrStart: invoke('qr:start'),
  qrCancel: invoke('qr:cancel'),

  // история / избранное
  histAdd: invoke('hist:add'),
  histRemove: invoke('hist:remove'),
  histClear: invoke('hist:clear'),
  favToggle: invoke('fav:toggle'),

  // инструменты
  toolScreenshot: invoke('tools:screenshot'),
  toolRecordStart: invoke('tools:record-start'),
  toolRecordStop: invoke('tools:record-stop'),
  toolLogcatStart: invoke('tools:logcat-start'),
  toolLogcatStop: invoke('tools:logcat-stop'),
  toolLogcatClear: invoke('tools:logcat-clear'),
  toolScrcpy: invoke('tools:scrcpy'),
  toolInstallApk: invoke('tools:install-apk'),
  toolInstallApkCancel: invoke('tools:install-apk-cancel'),
  toolQuick: invoke('tools:quick'),
  toolDiagnostics: invoke('tools:diagnostics'),

  // ошибки рендера -> в app.log
  uiLog: (m) => ipcRenderer.send('log:ui', m),

  // v2
  devInfo: invoke('dev:info'),
  savedList: invoke('saved:list'),
  savedAdd: invoke('saved:add'),
  savedRemove: invoke('saved:remove'),
  savedRename: invoke('saved:rename'),
  mirrorStart: invoke('mirror:start'),   // mirrorStart(serial, mode: 'h264'|'jpeg')
  mirrorStop: invoke('mirror:stop'),
  mirrorBounce: invoke('mirror:bounce'),  // v2.7.1: свежий h264-поток без пересборки UI
  inputTap: invoke('input:tap'),
  inputSwipe: invoke('input:swipe'),
  inputKey: invoke('input:key'),
  shellStart: invoke('shell:start'),
  shellWrite: invoke('shell:write'),
  shellStop: invoke('shell:stop'),
  fsList: invoke('fs:list'),
  fsPull: invoke('fs:pull'),
  fsPush: invoke('fs:push'),
  fsCmd: invoke('fs:cmd'),
  fsStat: invoke('fs:stat'),             // свойства файла/папки (F6)
  appsList: invoke('apps:list'),
  appsAction: invoke('apps:action'),
  wmSetSize: invoke('wm:setsize'),
  appsPerms: invoke('apps:perms'),
  appsPerm: invoke('apps:perm'),
  appsBackup: invoke('apps:backup'),
  appsIcon: invoke('apps:icon'),         // → { ok, dataUrl?, label? }
  appsIconPeek: invoke('apps:icon-peek'),   // v2.7: иконка ТОЛЬКО из кэша (для процессов, без скачивания APK)
  appsLabels: invoke('apps:labels'),     // весь известный кэш имён { pkg: name }
  procsList: invoke('procs:list'),
  procsKill: invoke('procs:kill'),
  procsKillApps: invoke('procs:killapps'),  // v2.6: «Завершить все приложения»
  devFull: invoke('dev:full'),
  fsVolumes: invoke('fs:volumes'),
  fsCat: invoke('fs:cat'),                  // v2.6: бинарное чтение файла (просмотрщик/плеер); v2.7: + maxMB
  fsOpenOnPc: invoke('fs:open-on-pc'),      // v2.7: скачать во временную папку и открыть системной программой (браузер/плеер/PDF)
  fsSaveText: invoke('fs:save-text'),       // v2.7.2: записать отредактированный текстовый файл обратно на телефон
  fsTmpWrite: invoke('fs:tmp-write'),       // v2.7.2: байты → временный локальный файл (HTML-превью)
  fsExtract: invoke('fs:extract'),          // v2.7: распаковка архива в папку с именем архива (свойства файла)
  shellOpenPath: invoke('shell:open-path'), // v2.7: открыть локальный файл системной программой
  // v2.8.0: файловый менеджер — архивы, категории, DOCX, USB-инструменты
  fsZipCreate: invoke('fs:zipcreate'),      // собрать ZIP из файлов/папок устройства
  fsZipList: invoke('fs:ziplist'),          // содержимое ZIP-архива без распаковки
  fsZipRead: invoke('fs:zipread'),          // прочитать файл ИЗ архива (байты)
  fsSearch: invoke('fs:search'),            // категории: все фото/музыка/видео/документы
  fsDocx: invoke('fs:docx'),                // DOCX → HTML для просмотра
  apkInstalledInfo: invoke('apk:installedinfo'), // установлена ли версия пакета на телефоне
  apkPhoneInstall: invoke('apk:phoneinstall'),   // установить APK, который уже лежит на телефоне
  appsRun: invoke('apps:run'),              // запустить установленное приложение на телефоне
  usbInfo: invoke('usb:info'),
  usbFormat: invoke('usb:format'),
  usbLabel: invoke('usb:label'),
  usbCheck: invoke('usb:check'),
  usbEject: invoke('usb:eject'),
  usbFakeTestStart: invoke('usb:faketest-start'),
  usbFakeTestCancel: invoke('usb:faketest-cancel'),
  miniClose: () => ipcRenderer.send('mini:close'), // v2.8.0: закрыть мини-окно APK (window.close запрещён в sandbox)
  apkLocalMeta: invoke('apk:localmeta'),    // v2.6: иконка/имя/пакет/версия локального APK
  apkRemoteMeta: invoke('apk:remotemeta'),  // v2.7: иконка/имя APK-файла, лежащего НА ТЕЛЕФОНЕ
  apkInstallBatch: invoke('apk:installbatch'), // v2.6: очередь установки (apk/xapk/apks/obb)
  apkInstallCancel: invoke('apk:installcancel'),
  appsMeta: invoke('apps:meta'),            // v2.6: размеры/даты для сортировки
  assocGet: invoke('assoc:get'),            // v2.6: состояние ассоциаций файлов
  assocSet: invoke('assoc:set'),
  // свои команды терминала (F16) — хранятся в «Сохранения/Мои команды.json»
  cmdsList: invoke('cmds:list'),
  cmdsAdd: invoke('cmds:add'),
  cmdsRemove: invoke('cmds:remove'),
  onMirrorChunk: (cb) => ipcRenderer.on('mirror:chunk', (_e, buf) => cb(buf)),
  onMirrorJpeg: (cb) => ipcRenderer.on('mirror:jpeg', (_e, frame) => cb(frame)), // {seq, buf}
  onShellOut: (cb) => ipcRenderer.on('shell:out', (_e, t) => cb(t)),
  onApkMiniFile: (cb) => ipcRenderer.on('apkmini:file', (_e, p) => cb(p)), // v2.7: новое имя APK в мини-окне

  // события из main
  onLogcat: (cb) => ipcRenderer.on('logcat:lines', (_e, lines) => cb(lines)),
  onTask: (cb) => ipcRenderer.on('task:event', (_e, ev) => cb(ev)),
  onTrayConnect: (cb) => ipcRenderer.on('tray:connect', (_e, h) => cb(h))
});

window.addEventListener('error', (e) => {
  try { ipcRenderer.send('log:renderer', (e.message || 'error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)); } catch (err) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { ipcRenderer.send('log:renderer', 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason).slice(0, 300)); } catch (err) {}
});
