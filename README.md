# atzs859fu

Модуль для работы с алкотестером ATZS-859FU из программы терминала.
Написан под Electron 35 и serialport 12 (те же версии, что в telemedic-terminal-app 6.1.36).
Нативного кода в модуле нет, используется serialport, который уже есть в приложении,
так что пересобирать ничего не надо.

Протокол и тайминги проверены на живом устройстве.

## Запуск на Raspberry отдельно от терминала

Программа терминала держит порт, поэтому её надо закрыть.

```
pkill telemedic
cd ~/atzs859fu
node dist/examples/cli.js --find         # список портов, где алкотестер
node dist/examples/cli.js                # один тест
node dist/examples/cli.js --keep-ready   # тест перезапускается сам, выход Ctrl+C
node dist/examples/cli.js --demo         # без устройства, на эмуляторе
```

Хватает Node 18, который стоит в системе. Лог пишется в atzs-logs/*.csv.

## Как подключить в main-процессе Electron

```ts
import { app, ipcMain, BrowserWindow } from "electron";
import { Alcotester } from "atzs859fu";

const alco = new Alcotester(); // порт ищет сам, единицы ставит мг/л
alco.connect();                // при обрыве переподключается сам

const send = (channel: string, ...data: unknown[]) =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...data));
alco.on("state", (state, value) => send("alco:state", state, value));
alco.on("result", (r) => send("alco:result", r));
alco.on("fault", (f) => send("alco:fault", f));
alco.on("log", (entry) => { /* в лог терминала */ });

ipcMain.handle("alco:start", (_e, examId: string) => alco.startTest(examId));
ipcMain.handle("alco:stop", () => alco.stopTest());
app.on("before-quit", () => void alco.close());
```

Тест можно запускать заранее, например пока меряют давление. Отсчёт 4 секунды пройдёт
за это время, и человек сразу сможет дуть.

## Методы

- `connect()` - начать подключение
- `startTest(testId?)` - запустить тест, testId потом придёт в результате
- `stopTest()` - остановить тест, заодно выключает keepReady
- `setKeepReady(on)` - тест сам запускается заново после результата и ошибок
- `setUnit(unit)` - сменить единицы между тестами (Unit.BAC, Unit.MgL, Unit.Mg100ml, Unit.GL)
- `status()` - текущий шаг, порт, единицы, счётчики
- `close()` - освободить порт

## События

- `connection` `{connected, path}` - порт открылся или связь пропала
- `state` `(state, value)` - смена шага, список шагов в типе State
- `countdown` `(n)` - отсчёт 4, 3, 2, 1
- `blow` - можно дуть
- `collecting` - выдох пошёл, длится 2.04 с
- `analyzing` - анализ, около 4.1 с
- `blowError` `(n)` - выдох прерван, n раз подряд. Через 2 с устройство само ждёт выдоха снова
- `pause` `(ms)` - после 3 прерванных выдохов подряд пауза 10 с, потом тест запускается заново
- `result` `{testId, raw, unit, value, scaleVerified, at}` - результат, value = raw / 1000
- `fault` `{kind, text}` - no_response (нет ответа на старт), silence (завис посреди теста),
  bad_value (значение больше 5000), lost (пропала связь)
- `noBlow` - 60 с никто не дул, тест остановлен
- `log` - каждая строка лога, включая сырые байты (dir = "raw")

## Поиск порта

По умолчанию path = "auto". Из списка портов берутся только CH340 (1a86:7523), остальные
устройства не открываются. Занятые порты пропускаются. В каждый свободный CH340 отправляется
стоп (FD 05 08 A6 E2), алкотестер отвечает тем же пакетом. Стоп ничего не ломает, он только
завершает тест. Порт можно задать и явно: `new Alcotester({ path: "/dev/serial/by-path/..." })`.

Порт открывается с lock: true, как serialport делает по умолчанию, поэтому вторая программа
его не откроет.


## Разработка

```
npm install
npm test
```

Тесты идут на эмуляторе (MockBinding из serialport) в 20 раз быстрее реального устройства.
Все задержки можно поменять через опцию timing, значения по умолчанию лежат в DEFAULT_TIMING.
