import { Alcotester, AlcotesterOptions, DEFAULT_TIMING, LogEntry } from "../src";

/** Во сколько раз быстрее настоящего устройства идут тесты. */
export const K = 0.05;

/** Все паузы модуля, умноженные на K. */
export function fastTiming(k = K): NonNullable<AlcotesterOptions["timing"]> {
  const t = DEFAULT_TIMING;
  return {
    tick: 5,
    startDeadline: t.startDeadline * k,
    stopThenStart: t.stopThenStart * k,
    silence: { countdown: t.silence.countdown * k, collecting: t.silence.collecting * k, analyzing: t.silence.analyzing * k },
    blowTimeout: t.blowTimeout * k,
    pause: t.pause * k,
    reconnect: 50,
    probe: 30,
    recheck: 1500,
    retry: t.retry * k,
    rearm: { idle: t.rearm.idle * k, result: t.rearm.result * k, error: t.rearm.error * k },
  };
}

export async function waitFor(cond: () => boolean, ms: number, what: string, alco?: Alcotester): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`не дождались: ${what}` + (alco ? `; сейчас ${alco.state} = ${String(alco.status().value)}` : ""));
}

/** Собрать журнал модуля. */
export function journal(alco: Alcotester): LogEntry[] {
  const logs: LogEntry[] = [];
  alco.on("log", (e) => logs.push(e));
  return logs;
}

export const texts = (logs: LogEntry[], from = 0) => logs.slice(from).map((e) => `${e.dir}: ${e.text}`);
