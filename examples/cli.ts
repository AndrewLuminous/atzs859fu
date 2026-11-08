// Проверка модуля на Raspberry без программы терминала, команды запуска описаны в README.
import * as fs from "fs";
import * as path from "path";
import type { BindingInterface } from "@serialport/bindings-interface";
import { SerialPort } from "serialport";
import { Alcotester, DEFAULT_TIMING, LogEntry, scanPorts, UNIT_NAMES } from "../src";
import { MockLab } from "../src/emulator";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function find(): Promise<number> {
  const r = await scanPorts(SerialPort.binding as BindingInterface, {
    baudRate: 9600, probeMs: DEFAULT_TIMING.probe, recheckMs: 0, all: true,
  });
  console.log("Последовательные порты:");
  for (const note of r.notes.length ? r.notes : ["не видно ни одного"]) console.log("  " + note);
  console.log(r.path ? `\nАлкотестер ATZS-859FU: ${r.path}` :
    `\nАлкотестер не найден${r.busy.length ? ": переходник CH340 занят другой программой" : ""}`);
  return r.path ? 0 : 1;
}

function csvJournal(dir: string): (e: LogEntry) => void {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const file = path.join(dir, `atzs-${stamp}.csv`);
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  fs.writeFileSync(file, "время,секунд_с_запуска,направление,состояние,hex,расшифровка\n");
  console.log(`Журнал: ${file}`);
  return (e) => {
    const t = e.time.toTimeString().slice(0, 8) + "." + String(e.time.getMilliseconds()).padStart(3, "0");
    fs.appendFileSync(file, [t, (e.sinceStart / 1000).toFixed(3), e.dir, e.state, e.hex, q(e.text)].join(",") + "\n");
  };
}

async function main(): Promise<number> {
  if (flag("--find")) return find();

  let binding: BindingInterface | undefined;
  if (flag("--demo")) {
    const lab = new MockLab();
    lab.addSilent("/dev/demo/ttyACM0", "0483", "5740");
    lab.addAlcotester("/dev/demo/ttyUSB0", { autoBlow: true });
    binding = lab.binding;
  }
  const keepReady = flag("--keep-ready");
  const alco = new Alcotester({ path: value("--port") ?? "auto", keepReady, binding });
  const write = csvJournal(value("--log-dir") ?? "atzs-logs");
  alco.on("log", (e) => {
    write(e);
    if (e.dir === "raw" || e.dir === "state") return; // в консоль - без сырых байтов и смен шага
    const arrow = { tx: "->", rx: "<-", info: "  ", error: "!!" }[e.dir as "tx" | "rx" | "info" | "error"];
    console.log(`${e.time.toTimeString().slice(0, 8)}  ${arrow} ${e.hex.padEnd(23)} ${e.text}`);
  });

  let done: (code: number) => void = () => undefined;
  const finished = new Promise<number>((r) => (done = r));
  alco.on("result", (r) => {
    console.log(`\nРезультат: сырое значение ${r.raw}; ${r.value.toFixed(3)} ${r.unit === null ? "" : UNIT_NAMES[r.unit]}` +
      ` (делитель 1000 ещё не проверен)\n`);
    if (!keepReady) setTimeout(() => done(0), 300);
  });
  alco.on("fault", (f) => !keepReady && f.kind !== "lost" && setTimeout(() => done(1), 300));
  process.on("SIGINT", () => done(0));
  process.on("SIGTERM", () => done(0));
  process.on("SIGHUP", () => done(0)); // окно терминала закрыли

  alco.connect();
  if (!keepReady) {
    const end = Date.now() + 10000;
    while (!alco.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (!alco.connected) {
      console.log(`\nНе подключился за 10 с: ${String(alco.status().value ?? "")}`);
      await alco.close();
      return 1;
    }
    await new Promise((r) => setTimeout(r, 500)); // ответ на команду единиц
    alco.startTest("проверка из консоли");
    setTimeout(() => done(1), 90000);
  }
  const code = await finished;
  await alco.close();
  return code;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(2);
});
