import { test } from "node:test";
import assert from "node:assert/strict";
import { Alcotester, AlcotesterOptions, CMD_STOP, cmdUnit, hex, Kind, makeFrame, Result, Unit } from "../src";
import { MockLab } from "../src/emulator";
import { fastTiming, journal, K, texts, waitFor } from "./helpers";

const ATZS = "/dev/mock/ttyUSB1";
const OTHER_CH340 = "/dev/mock/ttyUSB0"; // другое устройство на CH340: молчит
const STM32 = "/dev/mock/ttyACM0"; // не CH340: открывать нельзя вовсе

function setup(opt: AlcotesterOptions = {}, autoBlow = false) {
  const lab = new MockLab();
  lab.addSilent(STM32, "0483", "5740");
  lab.addSilent(OTHER_CH340);
  const emu = lab.addAlcotester(ATZS, { speed: K, autoBlow });
  const alco = new Alcotester({ binding: lab.binding, timing: fastTiming(), ...opt });
  const logs = journal(alco);
  return { lab, emu, alco, logs };
}

async function connected(alco: Alcotester) {
  alco.connect();
  await waitFor(() => alco.connected && alco.state === "idle", 2000, "подключение", alco);
  await new Promise((r) => setTimeout(r, 20)); // ответ на единицы
}

test("поиск: находит алкотестер, другим устройствам ничего не отправляет", async () => {
  const { lab, alco, logs } = setup();
  try {
    await connected(alco);
    assert.equal(alco.status().path, ATZS);
    assert.ok(!lab.opened.includes(STM32), "порт STM32 открывать нельзя");
    assert.equal(hex(lab.written.get(OTHER_CH340) ?? Buffer.alloc(0)), hex(Buffer.concat([CMD_STOP, CMD_STOP, CMD_STOP])),
      "молчащему CH340 - только стоп, до 3 попыток");
    assert.ok(hex(lab.written.get(ATZS)!).endsWith(hex(cmdUnit(Unit.MgL))), "после подключения ставятся единицы мг/л");
    assert.ok(texts(logs).some((t) => t.includes("нашёл поиском")));
  } finally {
    await alco.close();
  }
});

test("только что воткнутый алкотестер отвечает не сразу: всё равно находится", async () => {
  const { emu, alco } = setup();
  emu.muteUntil = Date.now() + 400; // первые попытки поиска уйдут в пустоту
  try {
    const t = Date.now();
    await connected(alco);
    assert.equal(alco.status().path, ATZS);
    assert.ok(Date.now() - t >= 350, "подключился раньше, чем устройство начало отвечать");
  } finally {
    await alco.close();
  }
});

test("полный тест: отсчёт, выдох, анализ, результат с номером осмотра и «стоп» после него", async () => {
  const { lab, emu, alco } = setup();
  try {
    await connected(alco);
    const seen: string[] = [];
    alco.on("countdown", (n) => seen.push(`отсчёт ${n}`));
    for (const e of ["blow", "collecting", "analyzing"] as const) alco.on(e, () => seen.push(e));
    let result: Result | undefined;
    alco.on("result", (r) => (result = r));
    alco.startTest("осмотр-17");
    await waitFor(() => alco.state === "blow", 1000, "дуйте", alco);
    emu.blow();
    await waitFor(() => result !== undefined, 1000, "результат", alco);
    assert.deepEqual(seen, ["отсчёт 4", "отсчёт 3", "отсчёт 2", "отсчёт 1", "blow", "collecting", "analyzing"]);
    assert.equal(result!.testId, "осмотр-17");
    assert.equal(result!.raw, 53);
    assert.equal(result!.unit, Unit.MgL);
    assert.equal(result!.value, 0.053);
    assert.equal(result!.scaleVerified, false);
    await waitFor(() => hex(lab.written.get(ATZS)!).endsWith(hex(CMD_STOP)), 200, "«стоп» после результата");
  } finally {
    await alco.close();
  }
});

test("3 прерванных выдоха подряд: пауза, потом тот же тест запускается снова", async () => {
  const { emu, alco } = setup();
  try {
    await connected(alco);
    const errors: number[] = [];
    alco.on("blowError", (n) => errors.push(n));
    let paused = 0;
    alco.on("pause", (ms) => (paused = ms));
    alco.startTest("осмотр-18");
    await waitFor(() => alco.state === "blow", 1000, "дуйте", alco);
    for (let i = 1; i <= 3; i++) {
      emu.send(makeFrame(Kind.Collecting));
      emu.send(makeFrame(Kind.BlowError));
      if (i < 3) {
        await waitFor(() => alco.state === "error", 500, `ошибка ${i}`, alco);
        emu.send(makeFrame(Kind.Blow));
        await waitFor(() => alco.state === "blow", 500, "снова дуйте", alco);
      }
    }
    await waitFor(() => alco.state === "cooldown", 500, "пауза", alco);
    assert.deepEqual(errors, [1, 2, 3]);
    assert.equal(paused, fastTiming().pause);
    emu.send(makeFrame(Kind.Blow)); // во время паузы шаг не меняется
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(alco.state, "cooldown");
    await waitFor(() => alco.state === "blow", 2000, "тест снова ждёт выдоха после паузы", alco);
    assert.equal(alco.status().testId, "осмотр-18");
  } finally {
    await alco.close();
  }
});

test("зависание посреди теста: сбой и «стоп»", async () => {
  const { lab, emu, alco } = setup();
  try {
    await connected(alco);
    let fault = "";
    alco.on("fault", (f) => (fault = f.kind));
    alco.startTest();
    await waitFor(() => alco.state === "blow", 1000, "дуйте", alco);
    emu.blow();
    await waitFor(() => alco.state === "collecting", 300, "сбор данных", alco);
    emu.hang();
    await waitFor(() => alco.state === "fault", 1000, "сбой", alco);
    assert.equal(fault, "silence");
    assert.ok(hex(lab.written.get(ATZS)!).endsWith(hex(CMD_STOP)));
  } finally {
    await alco.close();
  }
});

test("невозможное значение и результат без выдоха не показываются", async () => {
  const { emu, alco, logs } = setup();
  try {
    await connected(alco);
    const results: Result[] = [];
    alco.on("result", (r) => results.push(r));
    emu.send(makeFrame(Kind.Result, [0x00, 0x35])); // результат без теста
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(texts(logs).some((t) => t.includes("не после выдоха")));
    alco.startTest();
    await waitFor(() => alco.state === "blow", 1000, "дуйте", alco);
    emu.blow();
    await waitFor(() => alco.state === "analyzing", 500, "анализ", alco);
    emu.hang();
    emu.send(makeFrame(Kind.Result, [0xff, 0xff]));
    await waitFor(() => alco.state === "fault", 500, "сбой по значению", alco);
    assert.equal(results.length, 0);
  } finally {
    await alco.close();
  }
});

test("порт без ответа на «старт»: no_response", async () => {
  const { alco } = setup({ path: OTHER_CH340, unit: null });
  try {
    await connected(alco);
    alco.startTest();
    await waitFor(() => alco.state === "no_response", 1000, "нет ответа", alco);
  } finally {
    await alco.close();
  }
});

test("порт занят другой программой: busy, а после освобождения подключается", async () => {
  const { alco } = setup({ path: ATZS });
  const other = new Alcotester({ binding: (alco as any).binding, path: ATZS, timing: fastTiming() });
  try {
    await connected(alco);
    other.connect();
    await waitFor(() => other.state === "busy", 1000, "занят", other);
    await alco.close();
    await waitFor(() => other.connected, 1000, "подключение после освобождения", other);
  } finally {
    await alco.close();
    await other.close();
  }
});

test("обрыв связи: событие и повторный поиск", async () => {
  const { alco, logs } = setup();
  try {
    await connected(alco);
    const conn: boolean[] = [];
    alco.on("connection", (c) => conn.push(c.connected));
    alco.startTest();
    await waitFor(() => alco.state === "countdown", 1000, "отсчёт", alco);
    (alco as any).port.close();
    await waitFor(() => conn.length >= 2, 2000, "отключение и подключение", alco);
    assert.deepEqual(conn.slice(0, 2), [false, true]);
    assert.ok(texts(logs).some((t) => t.includes("потеряна посреди теста")));
  } finally {
    await alco.close();
  }
});

test("«всегда готов»: после результата тест запускается сам", async () => {
  const { emu, alco } = setup({ keepReady: true });
  try {
    await connected(alco);
    await waitFor(() => alco.state === "blow", 1500, "взвёлся сам", alco);
    let results = 0;
    alco.on("result", () => results++);
    emu.blow();
    await waitFor(() => results === 1, 1000, "результат", alco);
    await waitFor(() => alco.state === "blow", 1500, "снова ждёт выдоха", alco);
  } finally {
    await alco.close();
  }
});

test("никто не дует: тест останавливается, событие noBlow", async () => {
  const { alco } = setup({ timing: { ...fastTiming(), blowTimeout: 100 } });
  try {
    await connected(alco);
    let noBlow = false;
    alco.on("noBlow", () => (noBlow = true));
    alco.startTest();
    await waitFor(() => alco.state === "blow", 1000, "дуйте", alco);
    await waitFor(() => alco.state === "stopped" && noBlow, 1000, "остановка", alco);
  } finally {
    await alco.close();
  }
});
