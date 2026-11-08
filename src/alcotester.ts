import { EventEmitter } from "events";
import type { BindingInterface } from "@serialport/bindings-interface";
import type { SerialPortStream } from "@serialport/stream";
import { SerialPort } from "serialport";
import { FrameParser } from "./parser";
import { closePort, describeHolders, isBusyError, openPort, portHolders, scanPorts } from "./ports";
import { CMD_START, CMD_STOP, cmdUnit, describe, hex, Unit, UNIT_NAMES } from "./protocol";

export type State =
  | "no_device" // порт не найден или не открывается
  | "busy" // порт держит другая программа
  | "idle"
  | "starting" // "старт" отправлен, ждём ответа
  | "countdown"
  | "blow" // ждём выдоха
  | "collecting"
  | "analyzing"
  | "result"
  | "error" // выдох прерван, устройство само снова ждёт выдоха
  | "fault" // сбой: зависание или невозможное значение
  | "no_response" // на "старт" нет ответа
  | "cooldown" // пауза после нескольких прерванных выдохов подряд
  | "stopped";

const ACTIVE: State[] = ["starting", "countdown", "blow", "collecting", "analyzing"];
// из этих шагов перед новым стартом надо сначала отправить стоп
const STOP_FIRST: State[] = ["error", "fault", "no_response", "countdown", "blow", "collecting", "analyzing"];

/** Паузы в миллисекундах, значения по умолчанию взяты из журнала настоящего ATZS-859FU. */
export interface Timing {
  tick: number; // как часто проверять таймеры
  startDeadline: number; // ждать ответа на "старт"
  stopThenStart: number; // пауза между "стопом" и "стартом" при повторе
  silence: { countdown: number; collecting: number; analyzing: number }; // если шаг длится дольше, устройство зависло
  blowTimeout: number; // столько ждём выдоха; потом тест останавливается (или перезапускается при keepReady)
  pause: number; // пауза после нескольких прерванных выдохов подряд
  reconnect: number; // как часто искать или открывать порт заново
  probe: number; // сколько ждать ответа на стоп при поиске (до 3 попыток)
  recheck: number; // через сколько снова проверять порт, который не ответил как алкотестер
  fresh: number; // порт моложе этого проверяется при каждом поиске, пока не ответит
  retry: number; // keepReady: через сколько повторить после сбоя или "нет ответа"
  rearm: { idle: number; result: number; error: number }; // keepReady: через сколько снова запускать тест
  stats: number; // как часто писать статистику в журнал
}

export const DEFAULT_TIMING: Timing = {
  tick: 100,
  startDeadline: 3000,
  stopThenStart: 300,
  silence: { countdown: 3000, collecting: 6000, analyzing: 10000 }, // обычно 1,02 / 2,04 / 4,11 с
  blowTimeout: 60000,
  pause: 10000,
  reconnect: 1000,
  probe: 400, // устройство отвечает примерно за 15 мс
  recheck: 10000,
  fresh: 10000,
  retry: 10000,
  rearm: { idle: 500, result: 1000, error: 5000 }, // после ошибки устройство обычно само ждёт выдоха через 2 с
  stats: 600000,
};

export interface AlcotesterOptions {
  /** Порт или "auto" (по умолчанию): найти самому среди переходников CH340. */
  path?: string;
  baudRate?: number;
  /** Единицы при подключении (по умолчанию мг/л, null значит не менять). */
  unit?: Unit | null;
  /** Держать алкотестер в ожидании выдоха: запускать тест заново после результата и сбоев. */
  keepReady?: boolean;
  /** После скольких прерванных выдохов подряд делать паузу. */
  errorsBeforePause?: number;
  /** После паузы снова запустить тот же тест (иначе - остановиться). */
  restartAfterPause?: boolean;
  /** Сырое значение больше этого считается сбоем датчика или битым пакетом (5000 это 5 мг/л). */
  maxRaw?: number;
  /** Делитель сырого значения, 1000 взят из примера в документе и по эталону ещё не проверен. */
  divisor?: number;
  timing?: Partial<Omit<Timing, "silence" | "rearm">> & {
    silence?: Partial<Timing["silence"]>;
    rearm?: Partial<Timing["rearm"]>;
  };
  /** Доступ к портам: по умолчанию serialport, в тестах заглушка. */
  binding?: BindingInterface;
}

export type LogDir = "tx" | "rx" | "raw" | "state" | "info" | "error";

export interface LogEntry {
  time: Date;
  sinceStart: number; // мс с создания модуля
  dir: LogDir; // tx - к устройству, rx - разобранный пакет, raw - сырые байты, state - смена шага
  state: State; // шаг теста в этот момент
  hex: string;
  text: string;
}

export interface Result {
  testId?: string;
  raw: number;
  unit: Unit | null;
  value: number; // сырое значение, делённое на divisor
  scaleVerified: boolean; // делитель проверен по эталону
  at: Date;
}

export type FaultKind = "no_response" | "silence" | "bad_value" | "lost";

export interface Stats {
  tests: number;
  results: number;
  blowErrors: number;
  faults: number;
  noResponse: number;
  junk: number;
  lost: number;
}

export interface AlcotesterEvents {
  connection: [{ connected: boolean; path: string | null }];
  state: [State, unknown];
  countdown: [number];
  blow: [];
  collecting: [];
  analyzing: [];
  blowError: [number]; // сколько раз подряд
  pause: [number]; // мс
  noBlow: []; // выдоха не было blowTimeout мс
  result: [Result];
  fault: [{ kind: FaultKind; text: string }];
  stats: [Stats];
  log: [LogEntry];
}

// Алкотестер ATZS-859FU: порт, разбор пакетов, шаги теста и обработка сбоев, пример подключения есть в README.
export class Alcotester extends EventEmitter<AlcotesterEvents> {
  readonly path: string;
  readonly baudRate: number;
  keepReady: boolean;
  private readonly opt: Required<Omit<AlcotesterOptions, "timing" | "binding" | "path" | "baudRate" | "keepReady">>;
  private readonly timing: Timing;
  private readonly binding: BindingInterface;

  private port: SerialPortStream | null = null;
  private portPath: string | null = null;
  private parser = new FrameParser();
  private ticker: NodeJS.Timeout | null = null;
  private connecting = false;
  private closing = false;
  private nextConnect = 0;
  private lastProblem = "";
  private readonly checked = new Map<string, { at: number; note: string }>();
  private readonly t0 = Date.now();

  private _state: State = "no_device";
  private _value: unknown = null;
  private since = Date.now();
  private unit: Unit | null = null;
  private testId: string | undefined;
  private deadline: number | null = null; // ждём ответа на "старт" до
  private startAt: { at: number; text: string } | null = null; // "старт" после "стопа"
  private stopSent = 0;
  private errorsInRow = 0;
  private junkTimes: number[] = [];
  private junkWarned = 0;
  private statsLogged = Date.now();
  private readonly _stats: Stats = { tests: 0, results: 0, blowErrors: 0, faults: 0, noResponse: 0, junk: 0, lost: 0 };

  constructor(options: AlcotesterOptions = {}) {
    super();
    this.path = options.path ?? "auto";
    this.baudRate = options.baudRate ?? 9600;
    this.keepReady = options.keepReady ?? false;
    this.opt = {
      unit: options.unit === undefined ? Unit.MgL : options.unit,
      errorsBeforePause: options.errorsBeforePause ?? 3,
      restartAfterPause: options.restartAfterPause ?? true,
      maxRaw: options.maxRaw ?? 5000,
      divisor: options.divisor ?? 1000,
    };
    this.timing = {
      ...DEFAULT_TIMING,
      ...options.timing,
      silence: { ...DEFAULT_TIMING.silence, ...options.timing?.silence },
      rearm: { ...DEFAULT_TIMING.rearm, ...options.timing?.rearm },
    };
    this.binding = options.binding ?? (SerialPort.binding as BindingInterface);
  }

  // ----- для программы терминала

  get state(): State {
    return this._state;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  status() {
    return {
      state: this._state,
      value: this._value,
      connected: this.connected,
      path: this.portPath,
      unit: this.unit,
      testId: this.testId,
      keepReady: this.keepReady,
      stats: { ...this._stats },
    };
  }

  /** Начать искать или открывать порт; потом модуль сам переподключается при обрыве. */
  connect(): this {
    if (this.ticker) return this;
    this.closing = false;
    this.log("info", `Модуль ATZS-859FU: Node ${process.version}, ${process.platform} ${process.arch}, PID ${process.pid}, ` +
      `порт ${this.path}, ${this.baudRate} 8N1`);
    this.ticker = setInterval(() => this.tick(Date.now()), this.timing.tick);
    this.tick(Date.now());
    return this;
  }

  /** Отпустить порт и остановить таймеры. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.logStats("Итог за работу модуля");
    const port = this.port;
    this.port = null;
    if (port) {
      if (ACTIVE.includes(this._state)) this.send(CMD_STOP, "Завершение теста: модуль закрывается", port);
      await closePort(port);
    }
  }

  /** Запустить тест, testId (например, номер осмотра) вернётся в результате. */
  startTest(testId?: string): void {
    this.requirePort();
    this.testId = testId;
    this.errorsInRow = 0;
    this.begin(testId ? `Запуск теста (${testId})` : "Запуск теста");
  }

  /** Остановить тест и выключить keepReady. */
  stopTest(): void {
    this.requirePort();
    if (this.keepReady) this.setKeepReady(false);
    this.deadline = this.startAt = null;
    this.sendStop("Завершение теста");
    if ([...ACTIVE, "error", "fault", "no_response", "cooldown"].includes(this._state)) this.setState("stopped");
  }

  setKeepReady(on: boolean): void {
    this.keepReady = on;
    this.log("info", on ? "Режим «всегда готов» включён: тест запускается сам" : "Режим «всегда готов» выключен");
    if (!on && this.port && ACTIVE.includes(this._state)) {
      this.deadline = this.startAt = null;
      this.sendStop("Завершение теста: режим «всегда готов» выключен");
      this.setState("stopped");
    }
  }

  setUnit(unit: Unit): void {
    this.requirePort();
    if (this.keepReady) throw new Error("В режиме «всегда готов» единицы не меняются");
    if (ACTIVE.includes(this._state)) throw new Error("Единицы можно менять только между тестами");
    this.opt.unit = unit; // после переподключения ставим те же единицы
    this.sendUnit(unit);
  }

  // ----- порт

  private requirePort(): void {
    if (!this.port) throw new Error("Алкотестер не подключён");
  }

  private async tryConnect(): Promise<void> {
    this.connecting = true;
    try {
      if (this.path === "auto") {
        const r = await scanPorts(this.binding, {
          baudRate: this.baudRate, probeMs: this.timing.probe, recheckMs: this.timing.recheck,
          freshMs: this.timing.fresh,
          cache: this.checked, log: (dir, data, text) => this.log(dir, text, data),
        });
        if (this.closing) return void (r.port && (await closePort(r.port)));
        if (r.port && r.path) return this.attach(r.port, r.path, " (нашёл поиском: ответил на «стоп» как ATZS-859FU)");
        if (r.busy.length) return this.problem("busy", `Переходник CH340 занят: ${r.busy.join("; ")}`);
        return this.problem("no_device", "Алкотестер не найден. " +
          (r.notes.length ? r.notes.join("; ") : "Система не видит ни одного последовательного порта"));
      }
      const holders = portHolders(this.path);
      if (holders.length) return this.problem("busy", `Порт ${this.path} занят: ${describeHolders(holders)}`);
      try {
        const port = await openPort(this.binding, this.path, this.baudRate);
        if (this.closing) return void (await closePort(port));
        this.attach(port, this.path, "");
      } catch (err) {
        const text = (err as Error).message;
        if (isBusyError(err)) return this.problem("busy", `Порт ${this.path} занят другой программой: ${text}`);
        const ports = (await this.binding.list()).map((p) => `${p.path} ${p.vendorId ?? "?"}:${p.productId ?? "?"}`);
        this.problem("no_device", `Порт ${this.path} не открывается: ${text}. Система видит: ${ports.join("; ") || "ничего"}`);
      }
    } catch (err) {
      this.log("error", `Ошибка при подключении: ${(err as Error).stack ?? err}`);
    } finally {
      this.connecting = false;
      this.nextConnect = Date.now() + this.timing.reconnect;
    }
  }

  private problem(state: "busy" | "no_device", text: string): void {
    if (this.lastProblem !== text) this.log("error", `${text}. Пробую снова`);
    this.lastProblem = text;
    if (this._state !== state || this._value !== text) this.setState(state, text);
  }

  private attach(port: SerialPortStream, path: string, how: string): void {
    this.port = port;
    this.portPath = path;
    this.lastProblem = "";
    this.parser = new FrameParser();
    port.on("data", (chunk: Buffer) => this.onData(chunk));
    port.on("error", (err) => this.log("error", `Ошибка порта: ${err.message}`));
    port.on("close", () => this.onClose(port));
    this.log("info", `Порт открыт: ${path}${how}, ${this.baudRate} 8N1`);
    this.emit("connection", { connected: true, path });
    this.setState("idle");
    // с какими единицами устройство включается, мы не знаем, поэтому ставим сами
    if (this.opt.unit !== null) this.sendUnit(this.opt.unit);
  }

  private onClose(port: SerialPortStream): void {
    if (this.port !== port) return; // закрыли сами
    const during = ACTIVE.includes(this._state);
    this.port = null;
    this.deadline = this.startAt = null;
    this.count("lost");
    const text = `Связь с алкотестером потеряна${during ? " посреди теста" : ""}`;
    this.log("error", text);
    this.setState("no_device", text);
    this.emit("connection", { connected: false, path: this.portPath });
    this.emit("fault", { kind: "lost", text });
    this.portPath = null;
  }

  private send(data: Buffer, text: string, port = this.port): void {
    if (!port) throw new Error("Алкотестер не подключён");
    port.write(data);
    this.log("tx", text, data);
  }

  private sendStop(text: string): void {
    this.stopSent = Date.now();
    this.send(CMD_STOP, text);
  }

  private sendStart(text: string): void {
    this.startAt = null;
    this.send(CMD_START, text);
    this.deadline = Date.now() + this.timing.startDeadline;
    this.count("tests");
  }

  private sendUnit(unit: Unit): void {
    this.unit = unit;
    this.send(cmdUnit(unit), `Установить единицы: ${UNIT_NAMES[unit]}`);
  }

  private begin(text: string): void {
    this.startAt = null;
    if (STOP_FIRST.includes(this._state)) {
      // устройство могло остаться в тесте, сначала останавливаем
      this.sendStop("Завершение теста перед повтором");
      this.startAt = { at: Date.now() + this.timing.stopThenStart, text };
    } else {
      this.sendStart(text);
    }
    this.setState("starting");
  }

  // ----- пакеты от устройства

  private onData(chunk: Buffer): void {
    this.log("raw", `Прочитано из порта: ${chunk.length} байт`, chunk);
    this.handleParsed(Date.now(), chunk);
  }

  private handleParsed(now: number, chunk: Buffer): void {
    for (const item of this.parser.feed(chunk, now)) {
      if (item.kind === "junk") {
        this.onJunk(item.bytes, now);
        continue;
      }
      let { text, event } = describe(item.frame);
      const ownStop = event?.type === "stopAck" && now - this.stopSent > 1000;
      if (ownStop) text = "Устройство само завершило тест";
      if (item.crcOrder === "swapped") text += " [CRC младшим байтом вперёд, не как в документе]";
      this.log("rx", text, item.frame);
      this.deadline = null;
      if (!event) continue;
      if (ownStop && ACTIVE.includes(this._state)) {
        this.startAt = null;
        this.setState("stopped");
      }
      if (event.type === "stopAck" || event.type === "unitAck") continue;
      if (this._state === "cooldown" && event.type !== "result") {
        this.log("info", "Идёт пауза после прерванных выдохов: шаг не меняю");
        continue;
      }
      this.onEvent(event);
    }
  }

  private onEvent(event: Exclude<ReturnType<typeof describe>["event"], null>): void {
    switch (event.type) {
      case "countdown":
        this.setState("countdown", event.n);
        this.emit("countdown", event.n);
        break;
      case "blow":
        this.setState("blow");
        this.emit("blow");
        break;
      case "collecting":
        this.setState("collecting");
        this.emit("collecting");
        break;
      case "analyzing":
        this.setState("analyzing");
        this.emit("analyzing");
        break;
      case "blowError": {
        const n = ++this.errorsInRow;
        this.count("blowErrors");
        this.setState("error", n);
        this.emit("blowError", n);
        if (n >= this.opt.errorsBeforePause) {
          // обычно так бывает, если дуют без остановки или уже нет воздуха
          this.errorsInRow = 0;
          this.log("info", `${n} прерванных выдоха подряд: останавливаю тест на ${this.timing.pause / 1000} с`);
          this.sendStop("Завершение теста: пауза после прерванных выдохов");
          this.setState("cooldown", this.timing.pause);
          this.emit("pause", this.timing.pause);
        }
        break;
      }
      case "result":
        this.onResult(event.raw);
        break;
    }
  }

  private onResult(raw: number): void {
    if (this._state !== "collecting" && this._state !== "analyzing") {
      // например, хвост от теста, который начался до подключения
      this.log("error", `Результат пришёл не после выдоха (шаг: ${this._state}), не показываю`);
      this.sendStop("Завершение теста после лишнего результата");
      if (ACTIVE.includes(this._state)) this.setState("stopped");
      return;
    }
    if (raw > this.opt.maxRaw) {
      this.fault("bad_value", `Значение ${raw} вне диапазона алкотестера: сбой датчика или испорченный пакет`);
      return;
    }
    this.errorsInRow = 0;
    this.count("results");
    this.setState("result", raw);
    // по протоколу после результата нужно отправить стоп
    this.sendStop("Завершение теста после результата");
    this.emit("result", {
      testId: this.testId, raw, unit: this.unit, value: raw / this.opt.divisor,
      scaleVerified: false, at: new Date(),
    });
  }

  private onJunk(bytes: Buffer, now: number): void {
    this.log("rx", "Байты не по формату протокола (или с неверным CRC)", bytes);
    this.count("junk");
    this.junkTimes = [...this.junkTimes.slice(-4), now];
    if (this.junkTimes.length === 5 && now - this.junkTimes[0] < 60000 && now - this.junkWarned > 60000) {
      this.junkWarned = now;
      this.log("error", "Много испорченных пакетов за минуту: проверьте кабель и разъём");
    }
  }

  private fault(kind: FaultKind, text: string): void {
    this.count("faults");
    this.log("error", text);
    this.deadline = this.startAt = null;
    if (this.port) this.sendStop("Завершение теста после сбоя");
    this.setState("fault", text);
    this.emit("fault", { kind, text });
  }

  // ----- таймеры

  private tick(now: number): void {
    try {
      if (!this.port) {
        if (!this.connecting && !this.closing && now >= this.nextConnect) void this.tryConnect();
        return;
      }
      this.handleParsed(now, Buffer.alloc(0)); // дописать или выбросить застрявший обрывок пакета
      if (this.startAt && now >= this.startAt.at) this.sendStart(this.startAt.text);
      if (this.deadline && now > this.deadline) {
        this.deadline = null;
        this.count("noResponse");
        const text = `Нет ответа по протоколу ${this.timing.startDeadline / 1000} с после «старта»: проверьте, включён ли алкотестер`;
        this.log("error", text);
        this.setState("no_response", text);
        this.emit("fault", { kind: "no_response", text });
      }
      const age = now - this.since;
      const limit = (this.timing.silence as Record<string, number>)[this._state];
      if (limit && age > limit) {
        this.fault("silence", `Алкотестер замолчал посреди теста: шаг «${this._state}» длится больше ${limit / 1000} с`);
      }
      if (!this.keepReady && this._state === "blow" && age > this.timing.blowTimeout) {
        this.log("info", `Выдоха не было ${this.timing.blowTimeout / 1000} с: тест остановлен`);
        this.sendStop("Завершение теста: не дождались выдоха");
        this.setState("stopped");
        this.emit("noBlow");
      }
      if (!this.keepReady && this._state === "cooldown" && age > this.timing.pause) {
        if (this.opt.restartAfterPause && this.testId !== undefined) this.begin(`Запуск теста после паузы (${this.testId})`);
        else this.setState("stopped");
      }
      if (now - this.statsLogged > this.timing.stats) this.logStats("Статистика");
      if (this.keepReady) this.keepArmed(age);
    } catch (err) {
      // чтобы одна ошибка не остановила таймер
      this.log("error", `Ошибка в модуле: ${(err as Error).stack ?? err}`);
    }
  }

  /** keepReady: вернуть алкотестер в ожидание выдоха, если он из него вышел. */
  private keepArmed(age: number): void {
    const t = this.timing;
    if (this._state === "blow" && age > t.blowTimeout) {
      this.log("info", `«Всегда готов»: ${t.blowTimeout / 1000} с без выдоха, перезапускаю тест`);
    } else if (!((this._state === "idle" || this._state === "stopped") && age > t.rearm.idle
      || this._state === "result" && age > t.rearm.result
      || this._state === "error" && age > t.rearm.error
      || (this._state === "no_response" || this._state === "fault") && age > t.retry
      || this._state === "cooldown" && age > t.pause)) {
      return;
    }
    this.begin("Запуск теста («всегда готов»)");
  }

  // ----- журнал

  private setState(state: State, value: unknown = null): void {
    const now = Date.now();
    if (state !== this._state || value !== this._value) {
      const shown = value === null ? state : `${state} = ${value}`;
      this.log("state", `${this._state} → ${shown} (прошлый шаг длился ${((now - this.since) / 1000).toFixed(2)} с)`);
    }
    this._state = state;
    this._value = value;
    this.since = now;
    this.emit("state", state, value);
  }

  private count(key: keyof Stats): void {
    this._stats[key]++;
    this.emit("stats", { ...this._stats });
  }

  private logStats(title: string): void {
    this.statsLogged = Date.now();
    const s = this._stats;
    this.log("info", `${title}: запусков теста ${s.tests}, результатов ${s.results}, прерванных выдохов ${s.blowErrors}, ` +
      `сбоев ${s.faults}, без ответа ${s.noResponse}, испорченных пакетов ${s.junk}, обрывов связи ${s.lost}`);
  }

  private log(dir: LogDir, text: string, data: Buffer = Buffer.alloc(0)): void {
    const time = new Date();
    this.emit("log", { time, sinceStart: time.getTime() - this.t0, dir, state: this._state, hex: hex(data), text });
  }
}
