import * as fs from "fs";
import type { BindingInterface, PortInfo } from "@serialport/bindings-interface";
import { SerialPortStream } from "@serialport/stream";
import { FrameParser } from "./parser";
import { CMD_STOP } from "./protocol";

// Алкотестер сидит на CH340, порты других устройств (тонометр, FT232, CP210x, STM32) поиск не открывает.
export const CANDIDATE_IDS = ["1a86:7523"];

export const portIds = (info: PortInfo): string =>
  `${(info.vendorId ?? "").toLowerCase()}:${(info.productId ?? "").toLowerCase()}`;

/** Открыть порт с lock: true, чтобы другие программы его не открыли. */
export function openPort(binding: BindingInterface, path: string, baudRate: number): Promise<SerialPortStream> {
  return new Promise((resolve, reject) => {
    const port = new SerialPortStream({ binding, path, baudRate, autoOpen: false, lock: true });
    port.open((err) => {
      if (err) return reject(err);
      // как в SSCOM у поставщика: DTR включён, RTS выключен
      port.set({ dtr: true, rts: false }, () => resolve(port));
    });
  });
}

export function closePort(port: SerialPortStream): Promise<void> {
  return new Promise((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve()));
}

/** Ошибка открытия значит "порт занят другой программой"? */
export const isBusyError = (err: unknown): boolean => /lock|busy/i.test(String((err as Error)?.message ?? err));

// Шлём стоп до tries раз и ждём в ответ тот же пакет, так отвечает только ATZS-859FU.
export function probe(port: SerialPortStream, timeoutMs: number, tries = 3): Promise<{ ok: boolean; got: Buffer }> {
  return new Promise((resolve) => {
    const parser = new FrameParser();
    let got = Buffer.alloc(0);
    let left = tries;
    let timer: NodeJS.Timeout;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      port.off("data", onData);
      resolve({ ok, got });
    };
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      for (const item of parser.feed(chunk, Date.now())) {
        if (item.kind === "frame" && item.frame.equals(CMD_STOP)) return finish(true);
      }
    };
    const attempt = () => {
      if (left-- <= 0) return finish(false);
      port.write(CMD_STOP);
      timer = setTimeout(attempt, timeoutMs);
    };
    port.on("data", onData);
    attempt();
  });
}

/** Сколько мс назад появился порт (по времени создания файла устройства). */
export function portAgeMs(path: string): number {
  try {
    return Date.now() - fs.statSync(path).ctimeMs;
  } catch {
    return 0;
  }
}

// Кто держит порт по данным /proc, свой процесс тоже считается, ведь порт может держать другая часть программы.
export function portHolders(path: string): { pid: number; name: string }[] {
  let target: string;
  try {
    target = fs.realpathSync(path);
  } catch {
    return [];
  }
  const holders: { pid: number; name: string }[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // процессы других пользователей так не видны
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
          holders.push({ pid: Number(pid), name: fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() });
          break;
        }
      } catch {
        // дескриптор успел закрыться
      }
    }
  }
  return holders;
}

export const describeHolders = (holders: { pid: number; name: string }[]): string =>
  holders.map((h) => `${h.name} (PID ${h.pid}${h.pid === process.pid ? ", эта же программа" : ""})`).join(", ");

export interface ScanResult {
  path: string | null;
  port: SerialPortStream | null; // открыт только у найденного алкотестера
  notes: string[]; // по строке на каждый порт
  busy: string[]; // кто держит переходники CH340
}

export interface ScanOptions {
  baudRate: number;
  probeMs: number;
  probeTries?: number;
  recheckMs: number; // столько не проверять порт, который не ответил
  freshMs?: number; // порт моложе этого не запоминаем как "не алкотестер": он мог ещё грузиться
  cache?: Map<string, { at: number; note: string }>; // порты, которые не ответили как алкотестер
  all?: boolean; // проверить все порты (для --find); найденные закрываются
  log?: (dir: "tx" | "rx" | "info", data: Buffer, text: string) => void;
}

/** Найти алкотестер среди переходников CH340: каждому свободному отправить "стоп". */
export async function scanPorts(binding: BindingInterface, opt: ScanOptions): Promise<ScanResult> {
  const result: ScanResult = { path: null, port: null, notes: [], busy: [] };
  const all = await binding.list();
  // встроенные порты без USB (ttyS*, ttyAMA*) алкотестером быть не могут
  const builtIn = all.filter((info) => !info.vendorId);
  if (builtIn.length) result.notes.push(`встроенных портов без USB: ${builtIn.length} (${builtIn[0].path} и др.), не трогаю`);
  for (const info of all.filter((i) => i.vendorId)) {
    const title = `${info.path} (${portIds(info)}${info.manufacturer ? `, ${info.manufacturer}` : ""})`;
    if (!CANDIDATE_IDS.includes(portIds(info))) {
      result.notes.push(`${title}: не CH340, не трогаю`);
      continue;
    }
    const holders = portHolders(info.path);
    if (holders.length) {
      result.notes.push(`${title}: занят, держит ${describeHolders(holders)}`);
      result.busy.push(describeHolders(holders));
      continue;
    }
    const old = opt.cache?.get(info.path);
    if (old && Date.now() - old.at < opt.recheckMs) {
      result.notes.push(old.note);
      continue;
    }
    let port: SerialPortStream;
    try {
      port = await openPort(binding, info.path, opt.baudRate);
    } catch (err) {
      if (isBusyError(err)) result.busy.push("другая программа (порт заперт)");
      result.notes.push(`${title}: не открывается (${(err as Error).message})`);
      continue;
    }
    opt.log?.("tx", CMD_STOP, `Поиск алкотестера: проверяю ${info.path} командой «стоп»`);
    const { ok, got } = await probe(port, opt.probeMs, opt.probeTries);
    opt.log?.(got.length ? "rx" : "info", got,
      `Поиск: ${info.path} ${ok ? "ответил как ATZS-859FU" : "не ответил как ATZS-859FU"}`);
    if (ok) {
      result.notes.push(`${title}: ATZS-859FU`);
      if (!opt.all) return { ...result, path: info.path, port };
      result.path ??= info.path;
      await closePort(port);
      continue;
    }
    await closePort(port);
    if (portAgeMs(info.path) < (opt.freshMs ?? 10000)) {
      result.notes.push(`${title}: только что подключён и пока не ответил, проверю ещё раз`);
      continue;
    }
    const note = `${title}: на «стоп» не ответил как ATZS-859FU (проверю снова через ${opt.recheckMs / 1000} с)`;
    result.notes.push(note);
    opt.cache?.set(info.path, { at: Date.now(), note });
  }
  return result;
}
