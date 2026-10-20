# Анализ ADB AppControl (adb.cybercat.dev/ru/pc/) — v1.8.6

Метод: скачан официальный zip (signed-эндпоинт /download/sign/), раскрыт; PE/.NET-анализ через REA
(`inspect-managed-artifact`, `inspect-managed-members`), строки, комплект файлов.

## Что внутри
- `ADBAppControl.exe` — .NET Framework x86, CIL, il-only, strong-name-signed (REA: runtime 2.5, 3 секции).
- `adb/` — platform-tools 35.0.2 + fastboot + adb_win7 + **компаньон-APK** `com.cybercat.acbridge.apk`
  (мост на устройстве для расширенных функций: авто-разрешения и т.п.).
- `adb/lang/*.tsv` — локализации (bg, cz, de, es, fr, hu, it, ka, nl, pl, pt, sk, tr, uk, vi, zh).
  **Русского языка в комплекте нет** (строки RU зашиты в .NET-ресурсы exe).

## Структура UI (типы, извлечённые REA)
Form1 (главное: списки приложений, пакетные операции), PairForm (сопряжение Wi-Fi),
ProcessManagerForm (менеджер процессов), FormPermissions + FormAutoPermissions (разрешения),
FormWizard (мастер debloat), SavePresetDialog (пресеты команд = «избранное консоли»),
SearchSettingsForm, FormKeyProtector (платная защита adb-ключей), ActivationForm (лицензия),
FormTutorial, FormEmergency, ReportForm, FormAboutApp, FormChangeLog, FormLoading, FormValidation.

## Карта функций → наша реализация (v2.2)
| AppControl | У нас |
|---|---|
| Менеджер приложений (user/system/disabled, пакеты) | Страница «Приложения» + свойства + разрешения |
| ProcessManager | Вкладка «Процессы» (ps + kill) — добавлено в v2.2 |
| Консоль + пресеты | Терминал adb shell + избранное (★) |
| Debloat wizard | «Мастер очистки» с curated-списком |
| Permissions manager | Разрешения в «Свойствах» (grant/revoke) |
| Tools: скриншот/разрешение/fastboot/scrcpy | Скриншот, wm size (через терминал), reboot-чипы, scrcpy |
| PairForm | Сопряжение кодом/QR-скриншотом (+ авто-пайплайн) |
| Бэкап APK | «Резервная копия выбранных» |
| Локализации | Полностью русский интерфейс |

## Выводы
- Ничего принципиально недоступного нам у AppControl нет; его козыри — зрелый UI и компаньон-APK.
- Компаньон-APK даёт им авто-разрешения без пользовательских кликов — у нас это осознанно не реализуется
  (требует установки своего APK на телефон пользователя).
- QR-показ-на-ПК у AppControl НЕ заявлен как фича — это редкая функция оригинала NodChan с их закрытым
  сервером сопряжения.
