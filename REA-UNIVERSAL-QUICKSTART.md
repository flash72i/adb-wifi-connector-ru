# REA-UNIVERSAL-QUICKSTART.md — как мгновенно подключить REA к ЛЮБОМУ проекту в новой сессии

> Универсальный файл-ключ. Не привязан к проекту. Вставь его первым сообщением в новый чат —
> и агент сразу получит рабочий инструмент реверс-инжиниринга REA и поймёт, КАК им анализировать
> любые файлы: от JS и Electron до APK, MSIX, PE/.NET, ELF, прошивок, WASM и веб-сайтов.
> Репозиторий инструмента: **https://github.com/morluto/rea** (npm: `rea-agents`, лицензия MIT,
> сайт https://rea.tools, каталог MCP-команд: docs/mcp-contracts.md).

---

## 1. Подключение за 60 секунд (Linux-песочница)

```bash
# 1) Node >= 22.19 обязателен (системный может быть старым):
bash tools/bootstrap-rea.sh          # если файла нет — команды ниже:
#   curl -L https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz | tar -xJ -C /tmp/node22 --strip-components=1
#   export PATH=/tmp/node22/bin:$PATH && npm i -g rea-agents --prefix /tmp/rea
export PATH=/tmp/node22/bin:$PATH
/tmp/rea/bin/rea doctor              # проверка готовности окружения
```

Нюансы среды (проверено):
- Linux: нужен procps (`apt-get install procps`) — иначе любой анализ падает с
  `capability_unavailable: spawn ps ENOENT` (REA проверяет владение процессами).
- MCP-сервер REA к фиксированному toolset агента не подключается; использовать **CLI** (`rea <cmd> --json`).
- Нативный анализ (Ghidra/Hopper/IDA/JADX) отсутствует по умолчанию; JS/Electron/.NET/PE/ELF-парсинг
  работает без движков. `inspect-binary-layout` требует внешний Python:
  `REA_PWNTOOLS_PYTHON=/path/python` с pwntools 4.15.0, pyelftools 0.33, unicorn 2.1.2.

## 2. Какой командой анализировать что (шпаргалка)

| Цель | Команда |
|---|---|
| Каталог/архив/приложение (обзор) | `rea analyze <path> --json`, `rea inspect-artifact <path> --json` |
| JS / Electron / ASAR | `rea analyze-javascript-application <dir|asar> --json` (граф модулей, IPC, contextBridge, evidence) |
| Веб-страница/бандл | `rea analyze-web-bundle <url> --json`, `rea export-web-scripts <url> <dir>` |
| PE / .NET | `rea inspect-managed-artifact`, `rea inspect-managed-members`, `rea compare-managed-members` |
| APK / Android | `rea inspect-android-package`, `inspect-android-class/method`, `decode-android-resources` |
| Flutter/Dart AOT | `rea identify-flutter-build <APK>`, `rea inspect-dart-aot <APK>` — **ТОЛЬКО APK!** Для MSIX/app.so обход: распаковать и вытянуть строки из `app.so` regex'ом `[ -~]{4,}` + gzip `NOTICES.Z` (список зависимостей) |
| ELF/PE layout | `rea inspect-binary-layout` (нужен pwntools-Python, см. выше) |
| Mach-O / Go / WASM / EVM / firmware | `rea inspect-macho`, `inspect-go-binary`, `compare-wasm-interfaces`, `inspect-evm-interface`, `extract-firmware` |
| Процессы/UI/отладка | `rea capture-process`, `debug-with-gdb`, `capture-browser-scenario` |

Правило чтения результата: смотреть `normalized_result` + `limitations` + `confidence`;
REA никогда не считает «отсутствие находки = отсутствие сущности».

## 3. Если нужен бинарь из Microsoft Store (без Windows)

`tools/store_dl.py` (или по шагам): DisplayCatalog `products/<ProductId>?market=US&fieldsTemplate=Details`
→ `WuCategoryId` → FE3 SOAP (`fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx`):
GetCookie → SyncUpdates (FilterAppCategoryIds + фиксивный список InstalledNonLeafUpdateIDs +
DeviceAttributes) → GetExtendedUpdateInfo2 → подписанная CDN-ссылка. Сверять SHA1/SHA256 с дайджестами
ответа. TLS к fe3cr может требовать fallback без верификации сертификата в песочнице.

## 4. Гигиена и уроки

- Каждый ответ REA — JSON с `evidence_id`: сохраняй отчёты в workspace (`<target>-analysis.json`).
- Flutter-строки UI/фич живут в `app.so` (Dart AOT): ключи локализации `get:xxx`, тексты кнопок,
  пути `/sdcard/...`, форматы QR (`WIFI:T:ADB;…`) — дешёвый и мощный источник правды.
- Не верь скриншотам магазинов: они устаревшие; анализируй скачанный пакет.
- Большие артефакты держи в /tmp, в workspace — только отчёты и исходники.

*Версия файла 1.1, 2026-10-18. Проект-контекст моего владельца: UNIVERSAL-CONTEXT.md (рядом).*
