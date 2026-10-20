// qrpair.js — подключение телефона по QR-коду (Android 11+ «Подключить устройство по QR-коду»)
//
// Как это работает (протокол Google, подтверждён по исходникам AOSP):
//  1) ПК показывает QR вида WIFI:T:ADB;S:<имя>;P:<пароль>;;
//  2) телефон после сканирования публикует mDNS-сервис _adb-tls-pairing._tcp
//     с instance-name = S — ровно пока открыт экран сканера QR;
//  3) ПК находит этот сервис и получает ip:port. Ищем ТРЕМЯ способами по кругу
//     (владелец жаловался «телефон висит в Подключении устройства бесконечно» — раньше
//     использовался только свой mDNS, которого части сетей/фаерволов недостаточно):
//       a) собственный multicast/QU-клиент (mdns.js, обычный и эфемерный порт);
//       b) `adb mdns services` — собственный mDNS-стек adb (работает там, где наш глушат);
//       c) unicast-свип подсети (роутеры, режущие multicast).
//  4) `adb pair ip:port пароль` выполняет SPAKE2-сопряжение тем же паролем;
//  5) после сопряжения ищем TLS-порт отладки (mDNS/adb mdns/свип портов) и `adb connect`.
'use strict';
const crypto = require('crypto');
const adb = require('./adb');
const mdns = require('./mdns');

const LISTEN_TIMEOUT_MS = 150000;  // сколько ждём сканирования QR телефоном
const CONNECT_TIMEOUT_MS = 30000;  // сколько ждём появления порта отладки после сопряжения

let session = null;

function genPassword(len = 10) {
  // только [A-Za-z0-9]: adb-сервер режет строку «pair:<password>:<host>» по первому «:»,
  // а спецсимволы в WIFI:-формате QR требуют экранирования — не рискуем
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += abc[crypto.randomInt(abc.length)];
  return out;
}

function genServiceName() {
  // S — станет mDNS instance-name на телефоне: латиница/цифры/дефис, без точек
  return 'adbpc-' + crypto.randomBytes(5).toString('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Запустить QR-сессию. Возвращает {ok, qrText} синхронно, поиск идёт в фоне.
 * deps.sendStatus(stage, message, extra?) — статусы в renderer (task:event → qr-status)
 * deps.onConnected(host, port, model)     — вызывается при успешном подключении
 * deps.log(...a)                          — журнал main-процесса
 */
function start(deps) {
  if (session && !session.finished) return { ok: false, error: 'QR-сессия уже идёт' };
  deps = deps || {};
  const service = genServiceName();
  const password = genPassword(10);
  const qrText = `WIFI:T:ADB;S:${service};P:${password};;`;
  session = { service, password, qrText, cancelled: false, finished: false };
  run(session, deps).catch(e => {
    if (session && !session.finished) {
      session.finished = true;
      try { deps.sendStatus && deps.sendStatus('error', 'Внутренняя ошибка QR-сессии: ' + (e && e.message || e)); } catch (err) {}
    }
  });
  return { ok: true, qrText, service };
}

function cancel() {
  if (session && !session.finished) { session.cancelled = true; session.finished = true; }
}

function isRunning() { return !!(session && !session.finished); }

// Строгий матч: instance ровно из НАШЕГО QR (первая метка до точки). Чужие телефоны/ПК в сети
// публикуют другие имена — случайное совпадение 40 бит hex практически исключено (A3-ревью).
function isOurPairing(r, service) {
  const inst = String(r.instance || r.name || '');
  if (!String(r.service || '').includes('_adb-tls-pairing')) return false;
  if (!r.host || !r.port) return false;
  return inst.split('.')[0] === service;
}

async function run(s, deps) {
  const sendStatus = (stage, message, extra) => {
    try { deps.sendStatus && deps.sendStatus(stage, message, extra); } catch (e) {}
  };
  const log = (...a) => { try { deps.log && deps.log(...a); } catch (e) {} };

  sendStatus('listening', 'Ожидание сканирования… На телефоне: «Беспроводная отладка» → «Подключить устройство по QR-коду», наведите камеру на код и НЕ закрывайте экран сканера.');

  // 1) ждём, пока телефон опубликует сервис сопряжения с нашим именем — тремя источниками
  let target = null;
  const t0 = Date.now();
  let round = 0;
  let lastHint = 0;
  while (!s.cancelled && !target && Date.now() - t0 < LISTEN_TIMEOUT_MS) {
    round++;
    // источник A: собственный mDNS-клиент, чередуя обычный и эфемерный порт (фаервол режет 5353)
    const ephemeral = round % 2 === 1;
    const recs = await mdns.discover(1200, { ephemeral }).catch(() => []);
    target = (recs || []).find(r => isOurPairing(r, s.service));
    // источник B: собственный mDNS-стек adb (живёт в другом процессе, другие права/сокеты)
    if (!target) {
      const am = await adb.mdnsServices().catch(() => ({ items: [] }));
      target = ((am && am.items) || []).find(r => isOurPairing(r, s.service));
      if (target) log('found via adb mdns services');
    }
    // источник C: каждые 2 раунда — прямой unicast-опрос всех хостов подсети
    if (!target && round % 2 === 0) {
      const uni = await mdns.discoverUnicast(1800, { ephemeral: true }).catch(() => []);
      target = (uni || []).find(r => isOurPairing(r, s.service));
      if (target) log('found via unicast sweep');
    }
    if (!target && Date.now() - lastHint > 20000) {
      lastHint = Date.now();
      sendStatus('listening', 'Ищу телефон по сети (' + Math.round((Date.now() - t0) / 1000) + ' с)… Проверьте: телефон и ПК в одной Wi-Fi-сети, экран сканера на телефоне открыт. Если не находится — проверьте, что сеть Windows помечена «Частная».');
    }
  }
  if (s.cancelled) return;
  if (!target) {
    s.finished = true;
    sendStatus('error', 'Телефон не найден за 2,5 минуты. Проверьте: 1) обе сети Wi-Fi совпадают; 2) экран «Подключить по QR-коду» на телефоне открыт; 3) сеть Windows — «Частная» (иначе Windows режет обнаружение); 4) брандмауэр разрешает приложению UDP 5353. Затем нажмите «Другой код».');
    return;
  }

  // 2) сопряжение паролем из QR
  sendStatus('found', `Телефон найден: ${target.host}:${target.port}. Сопряжение…`);
  log('pairing', target.host + ':' + target.port);
  const pr = await adb.pair(target.host, target.port, s.password);
  if (s.cancelled) return;
  if (!pr.ok) {
    s.finished = true;
    const msg = String(pr.error || pr.message || 'ошибка').split('\n')[0].slice(0, 200);
    sendStatus('error', 'Сопряжение не удалось: ' + msg);
    return;
  }

  // 3) подключение: adb мог сделать это сам (auto-connect), иначе ищем порт по mDNS/свипу
  sendStatus('paired', 'Сопряжение выполнено. Подключение…');
  const serial = await connectPhase(s, target.host, log);
  if (s.cancelled) return;
  if (!serial) {
    s.finished = true;
    sendStatus('error', 'Сопряжение выполнено, но подключиться не удалось. Посмотрите порт на экране «Беспроводная отладка» и подключитесь по IP вручную.');
    return;
  }
  const [host, portStr] = serial.split(':');
  let model = '';
  try { model = (await adb.modelName(serial)).model; } catch (e) {}
  s.finished = true;
  sendStatus('connecting', 'Подключено: ' + serial);
  try { deps.onConnected && deps.onConnected(host, parseInt(portStr, 10) || 5555, model); } catch (e) {}
  sendStatus('connected', 'Подключено: ' + (model || serial), { host, port: parseInt(portStr, 10) || 5555, model });
}

// v2.7.0: фаза подключения ПОСЛЕ сопряжения полностью переписана — раньше здесь было
// две беды: (1) полный свип 15 000 портов (~24 с) стартовал только ПОСЛЕ 30-секундного
// бесплодного цикла mDNS-опросов, (2) каждый раунд делал sleep(1200) + медленные adb-вызовы.
// Теперь: свип запускается ПЕРВЫМ ДЕЛОМ с ранним выходом (первый открытый порт находится
// за ~1–2 с), параллельно опрашивается adb devices (автоподключение), найденные порты
// пробуются подключением немедленно. Типичное время «Подключение…»: 3–8 секунд.
async function connectPhase(s, host, log) {
  const t0 = Date.now();
  let stopped = false;
  // (1) быстрый свип портов — запускаем сразу, он и есть главный источник кандидатов
  const scanP = adb.portScanFast(host).catch(() => []);
  // (2) параллельно: adb мог уже сам подключить устройство после сопряжения
  const pollP = (async () => {
    while (!stopped && !s.cancelled && Date.now() - t0 < CONNECT_TIMEOUT_MS) {
      const d = await adb.devices().catch(() => ({ ok: false, list: [] }));
      for (const dev of (d.list || [])) {
        if (dev.state === 'device' && dev.serial.startsWith(host + ':')) return dev.serial;
      }
      await sleep(800);
    }
    return null;
  })();
  const tried = new Set();
  const tryPort = async (p) => {
    if (!p || tried.has(p)) return null;
    tried.add(p);
    try {
      const c = await adb.connect(host, p);
      if (c.ok) return host + ':' + p;
    } catch (e) {}
    return null;
  };
  // ГОНКА источников: кто первый даст рабочий serial — тот и выигрывает
  let serial = null;
  while (!s.cancelled && !serial && Date.now() - t0 < CONNECT_TIMEOUT_MS) {
    const winner = await Promise.race([
      pollP.then(r => (r ? { type: 'poll', serial: r } : null)),
      scanP.then(ports => ({ type: 'scan', ports })),
      sleep(500).then(() => null)
    ]);
    if (!winner) continue;
    if (winner.type === 'poll' && winner.serial) { serial = winner.serial; break; }
    // scan: перебираем найденные порты (обычно 1–2)
    for (const p of (winner.ports || [])) {
      serial = await tryPort(p);
      if (serial || s.cancelled) break;
    }
    if (!serial && winner.type === 'scan' && !(winner.ports || []).length) {
      // свип ничего не нашёл — пробуем mDNS-порт отладки напрямую
      const recs = await mdns.discover(700).catch(() => []);
      const all = (recs || []).concat((await adb.mdnsServices().catch(() => ({ items: [] }))).items || []);
      const conn = all.find(r => String(r.service || '').includes('_adb-tls-connect') && r.host === host && r.port);
      if (conn) serial = await tryPort(conn.port);
    }
    if (winner.type === 'scan') {
      // свип завершён; ждём только poll до конца таймаута
      const r = await Promise.race([pollP, sleep(Math.max(0, CONNECT_TIMEOUT_MS - (Date.now() - t0))).then(() => null)]);
      serial = r || serial;
      break;
    }
  }
  stopped = true;
  return serial;
}

module.exports = { start, cancel, isRunning };
