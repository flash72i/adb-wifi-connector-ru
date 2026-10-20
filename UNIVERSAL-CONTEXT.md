# UNIVERSAL-CONTEXT.md — универсальный файл переноса контекста

> КАК ИСПОЛЬЗОВАТЬ: вставьте содержимое этого файла ПЕРВЫМ сообщением новой сессии
> (или дайте путь к нему) — ассистент сразу поймёт проект, окружение, инструменты и правила.
> Файл универсален: разделы «Проект» и «Roadmap» правятся под любую новую задачу,
> разделы «Окружение» и «Инструменты» подходят без правок.

---

## 0. Памятка ассистенту (читать первой)

- Пользователь: русскоязычный, Windows 11 x64, телефон Android 11+ в той же сети (192.168.1.6).
- Роутер пользователя **режет multicast/mDNS** между Wi-Fi и проводом → любое mDNS-обнаружение
  может молчать; всегда имей fallback: unicast-пробы, свип портов, ручной ввод IP:порт.
- Стиль общения: по-русски, без воды; результат = файл/ссылка на скачивание.
- Большие файлы пользователь скачать из встроенного просмотрщика НЕ может (обрезает до ~12 КБ).
  Канал передачи: **workupload.com** скриптом `tools/wu_upload.py` (инструкция
  `uploads/Как загрузить на_workupload_для_ИИ.txt`), проверять ссылку headless-браузером
  (title = имя файла) и давать SHA256.
- Архивы пользователю: структура папки = корневой лаунчер-exe + `app.log` + `APP/` + `SOURCE/`.
- Запрещено: копировать чужие иконки/бренд/код; обходить триал/IAP чужих приложений;
  выдавать нерабочие «кнопки-обманки». Если фича технически невозможна — честно сказать и
  предложить ближайший рабочий эквивалент + план.

## 1. Окружение песочницы (Linux)

- Node v20 системный НЕ подходит для многих задач; рабочий Node 22: `bash tools/bootstrap-rea.sh`
  (качает node-v22.23.3 в tools/, распаковывает в /tmp/node22, ставит rea-agents в /tmp/rea, procps).
- Python 3.11 (system + /opt/arena-python), PIL есть, playwright + системный chromium есть
  (`/usr/bin/chromium`, запуск с `--no-sandbox`), xvfb есть, mingw-w64 (x86_64) есть.
- Память ~1 ГБ: electron-builder FORK падает с ENOMEM → Windows-пакеты собирать ВРУЧНУЮ
  (official electron win zip + resources/app + resedit для иконки), см. `SOURCE/README-BUILD.md`.
- `/home/user` = workspace (персистится); `/tmp` = sessione; каталоги node_modules/dist в снапшот не входят.
- Внутри Python-heredoc литерал `/home/user` может переписываться средой — используй относительные пути.

## 2. Инструменты (проверенные, с оценкой эффективности)

### 2.1 REA — Reverse Engineer Anything · https://github.com/morluto/rea
MCP-сервер+CLI для агентского реверс-инжиниринга (npm `rea-agents`).
Эффективность в нашем проекте: **7/10**.
- Сильно: `analyze-javascript-application` (полный граф Electron-приложения с evidence),
  `inspect-artifact` (MSIX: манифест, инвентарь), честные limitations/confidence в каждом ответе.
- Слабо: Flutter/Dart-команды (`identify-flutter-build`, `inspect-dart-aot`) принимают ТОЛЬКО APK —
  для MSIX/app.so бесполезны; `inspect-binary-layout` требует внешний pwntools-Python
  (`REA_PWNTOOLS_PYTHON`); MCP к себе в инструменты не подключить (фиксированный toolset) —
  использовать CLI через bash.
- Обходы, которые сработали: ручной strings-анализ Dart AOT (`app.so`) дал ВСЮ карту UI/фич
  (ключи локализации `get:tools*`, лимиты триала, форматы QR `WIFI:T:ADB;…`), NOTICES.Z (gzip)
  дал список зависимостей, AppxManifest.xml — capabilities/autostart.

### 2.2 Скачивание пакетов Microsoft Store без скриншотов/Windows
`tools/store_dl.py`: DisplayCatalog (ProductId→WuCategoryId) → FE3 WSUS-SOAP
(GetCookie→SyncUpdates→GetExtendedUpdateInfo2) → подписанная CDN-ссылка; сверять SHA1/SHA256
с дайджестами из ответа. Работает из песочницы (TLS-фолбэк unverified для fe3cr).

### 2.3 Отдача файлов пользователю
`tools/wu_upload.py <файл>` (Playwright+chromium): перехватывать upload-сервер сетевым
listener'ом ПЕРЕД уничтожением blueimp-виджета; файл в input ставить ПОСЛЕ destroy виджета
(иначе виджет уносит файл); generateLink фильтровать по «Are you a human».

### 2.4 Сборка Windows-приложения из Linux (без electron-builder)
Официальный `electron-vX-win32-x64.zip` → `resources/app` + `resources/adb` + `resources/scrcpy`;
иконка/version-info: `node tools/patch-icon.js` (resedit: `IconFile.from`, `icons.map(i=>i.data)`,
`VersionInfo.outputToResourceEntries`); лаунчер: `tools/launcher.c` + windres (mingw).

## 3. Проект: ADB Wi-Fi Коннектор (RU)

- Чистая реализация по мотивам проприетарного `NodChan.adbwificonnector 2.6.0.0`
  (Store id 9P1STKXLHTL2, Flutter+Dart AOT, без русского языка, триал+IAP).
- Наш стек: Electron 33 + vanilla JS (Material-подобный UI, ru), adb platform-tools, scrcpy v5.
- Код: `adbwifi-ru/` (main.js, adb.js, mdns.js, preload.js, pairpage.js[удалить в v2],
  renderer/{index.html,styles.css,app.js,lib/jsQR.js,lib/qrcode.js}).
- Упаковка: `/tmp/winpkg` = APP; лаунчер `/tmp/ADB-WiFi-Connector-RU.exe`; топ-папка vN в /tmp/pkgN.
- История версий: 1.0.0 база → 1.0.1 mDNS/подсказки → 1.0.2 единый скан+scrcpy+kill-server →
  1.0.3 структура APP/SOURCE/лог+unicast-mDNS → 1.0.4 фикс `adb pair` (БАГ: был лишний аргумент
  'connect'!), QR-веб-страница (ОТКЛОНЕНА пользователем — убрать), авто-пайплайн кода.
- v2.0.0 выпущена (mirror WebCodecs, терминал, файлы, приложения, звуки, saved CRUD).
- v2.7.0 выпущена (см. README-RU.md): быстрое подключение (portScanFast + гонка poll/scan), диагностика mDNS raw+warn, вид проводника (список/значки/огромные с миниатюрами), текст/PDF(pdf.js)/HTML-в-браузер, распаковка архивов, карусель фото, плеер: автоплей+2 фулскрина+скачивание+10 визуализаций (vislib.js, по мотивам анимаций владельца), процессы с иконками и фильтром, ОТДЕЛЬНОЕ окно APK (apkmini) без основной программы, иконки APK-файлов с Android-бейджем.
- v2.1.0 выпущена: компактное зеркало + панель управления рядом, терминал-список с описаниями и
  красными ошибками, «Об устройстве» одной кнопкой, фикс стопа logcat, тома/SD в «Файлах»,
  свойства приложений + разрешения + бэкап APK пачкой, авто-последнее устройство (opt-in).
  sha256 v2.1.0: ab03bdc9659ece0f5e3612f3fe2d5839cc3933f7b56f66f9ad41c97ac82d41ba (workupload QpxMzEWNDax).
- Универсальный файл-ключ для REA в ЛЮБОМ проекте: REA-UNIVERSAL-QUICKSTART.md (корень + SOURCE/).
- Следующая задача: AOSP pairing-сервер (QR на ПК → скан телефоном → авто) с локальной валидацией
  через Linux `adb pair` против нашего сервера; не выпускать непроверенным.

## 4. Дорожная карта / открытые задачи

1. **v2.0** (в работе): встроенная трансляция экрана ВНУТРИ окна (h264 `screenrecord --output-format=h264 -`
   → WebCodecs VideoDecoder → canvas; тап/свайп через `input tap/swipe`), внешнее окно = scrcpy
   (windowsHide:true — убрать чёрный консольный терминал!), терминал adb shell с избранными командами,
   менеджер приложений (user/system/disabled + пакетное отключение = debloat-wizard по мотивам
   ADB AppControl https://adb.cybercat.dev/ru/pc/), файловый менеджер в обе стороны,
   сохранённые устройства (CRUD), БЕЗ автоподключения при старте, звуки действий (WebAudio),
   инфо об устройстве (model/manufacturer/battery/wm size), смена разрешения (wm size),
   UI-компоненты каталожного типа (loaders/toggles/tooltips/toasts — своя реализация в стиле проекта,
   референс-каталоги uiverse.io/reactbits.dev, НЕ копировать дизайн сайтов).
2. **QR «показал на ПК → телефон отсканировал → авто»**: требует своей реализации AOSP pairing-сервера
   (mDNS-responder `_adb-tls-pairing._tcp` + SPAKE2+ + TLS1.3-PSK + keystore adb). План валидации БЕЗ
   телефона: Linux platform-tools `adb pair 127.0.0.1:<port> <code>` против нашего сервера на localhost.
   Веб-страница-посредник пользователем ЗАПРЕЩЕНА. Пока фича не готова — не имитировать.
3. Автоподключение при старте — только явный opt-in в настройках (по умолчанию ВЫКЛ).

## 5. Чек-лист старта сессии

1. Прочитать этот файл; при необходимости `bash tools/bootstrap-rea.sh`.
2. Проверить `deliver/` и `/tmp/pkg*` — текущие артефакты; версия в `adbwifi-ru/package.json`.
3. Перед правками — смок-тест UI: `SCREENSHOT_DIR=/tmp/shots xvfb-run -a ./node_modules/.bin/electron . --no-sandbox`
   (+ `ELECTRON_ENABLE_LOGGING=1` для консоли рендера).
4. После сборки — zip структуры (launcher+app.log+APP+SOURCE), sha256, `tools/wu_upload.py`, проверка ссылки.
5. Ответ пользователю: ссылка + sha256 + что изменено + честные ограничения + просьба прислать app.log при проблемах.

---

## 6. Уроки (Lessons Learned) — дополнять, не удалять

1. Если `pkill -f <слово>` и это слово есть в тексте самой команды → оболочка убивает САМУ себя
   (bash -c содержит скрипт в cmdline). Используй `pkill -x <имя>` или bracket-трюк и проверь,
   что паттерн не встречается в тексте команды.
2. Прерванная `npm i electron` оставляет module без dist/ → лечится `node node_modules/electron/install.js`.
3. Новые страницы/роуты: добавляй их в БЕЛЫЙ СПИСОК hash-навигации И в rail, иначе страница не откроется (баг v2.0.0-rc).
4. /tmp и apt-пакеты НЕ переживают перезапуск песочницы; workspace переживает. Всё нужное держим
   в workspace (tools/, scrcpy-bundle/, deliver/) или восстанавливаем bootstrap-скриптами.
5. Вырезание функции из main.js строным поиском `index('}')` оставляет лишние `}` — проверяй `node --check`.
6. Хеш-суммы артефактов и ссылки workupload писать здесь же (раздел 3), чтобы не терять между сессиями:
   v2.0.0 sha256 62675818981e1c9944041066f24da8d4ecb16101232ac5018c520f7be0c3fd81.
8. Прерванный `npm i electron` лечится `node node_modules/electron/install.js`.
9. После удаления HTML-элемента обязательно убирай его обработчики из app.js — null.onclick роняет
   ВЕСЬ последующий код скрипта (так ломался переключатель страниц v2.0.0-rc).
7. Пользователь НЕ приемлет: веб-страницы-посредники вместо нативного UX; автоподключения без спроса;
   кнопки-обманки. Приемлет: раздельные поля IP/порт, звуки, встроенные окна, списки устройств с CRUD.
