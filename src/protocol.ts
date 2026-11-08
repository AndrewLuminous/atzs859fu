// Пакет ATZS-859FU: FD, длина (n + 5), тип, n байт данных и CRC16-MODBUS старшим байтом вперёд.

export const HEADER = 0xfd;

export enum Kind {
  Start = 0x02, // от терминала - запуск теста; от устройства - обратный отсчёт 4...1 раз в секунду
  Blow = 0x03, // устройство ждёт выдоха
  Collecting = 0x04, // выдох обнаружен, идёт сбор данных (2,04 с)
  BlowError = 0x05, // выдох прерван; через 2,04 с устройство само снова ждёт выдоха
  Analyzing = 0x06, // анализ (4,1 с)
  Result = 0x07, // результат: 2 байта, старший первым
  Stop = 0x08, // завершить тест; устройство отвечает тем же пакетом
  Unit = 0x17, // единицы; устройство отвечает FD 05 17 6E A3
}

export enum Unit {
  BAC = 0,
  MgL = 1,
  Mg100ml = 2,
  GL = 3,
}

export const UNIT_NAMES: Record<Unit, string> = {
  [Unit.BAC]: "%BAC",
  [Unit.MgL]: "мг/л",
  [Unit.Mg100ml]: "мг/100 мл",
  [Unit.GL]: "г/л",
};

export function crc16modbus(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export function makeFrame(kind: number, data: ArrayLike<number> = []): Buffer {
  const body = Buffer.from([HEADER, data.length + 5, kind, ...Array.from(data)]);
  const crc = crc16modbus(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff])]);
}

export const CMD_START = makeFrame(Kind.Start);
export const CMD_STOP = makeFrame(Kind.Stop);
export const cmdUnit = (unit: Unit): Buffer => makeFrame(Kind.Unit, [unit]);

export const hex = (data: Uint8Array): string =>
  Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/** Что сообщило устройство. */
export type DeviceEvent =
  | { type: "countdown"; n: number }
  | { type: "blow" }
  | { type: "collecting" }
  | { type: "blowError" }
  | { type: "analyzing" }
  | { type: "result"; raw: number }
  | { type: "stopAck" }
  | { type: "unitAck" };

/** Пакет от устройства -> текст для журнала и событие (null - неизвестный тип). */
export function describe(frame: Buffer): { text: string; event: DeviceEvent | null } {
  const kind = frame[2];
  const data = frame.subarray(3, frame.length - 2);
  switch (kind) {
    case Kind.Start:
      return data.length
        ? { text: `Обратный отсчёт: ${data[0]}`, event: { type: "countdown", n: data[0] } }
        : { text: "Запуск теста (эхо)", event: null };
    case Kind.Blow:
      return { text: "Ожидание выдоха: дуйте", event: { type: "blow" } };
    case Kind.Collecting:
      return { text: "Сбор данных", event: { type: "collecting" } };
    case Kind.BlowError:
      return { text: "Ошибка выдоха: выдох прерван", event: { type: "blowError" } };
    case Kind.Analyzing:
      return { text: "Анализ данных", event: { type: "analyzing" } };
    case Kind.Result: {
      const raw = data.reduce((acc, b) => acc * 256 + b, 0);
      return { text: `Результат: сырое значение ${raw}`, event: { type: "result", raw } };
    }
    case Kind.Stop:
      return { text: "Завершение теста (подтверждение)", event: { type: "stopAck" } };
    case Kind.Unit:
      return {
        text: data.length ? `Единицы: ${UNIT_NAMES[data[0] as Unit] ?? data[0]}` : "Единицы подтверждены",
        event: { type: "unitAck" },
      };
    default:
      return { text: `Неизвестный тип 0x${kind.toString(16).toUpperCase().padStart(2, "0")}`, event: null };
  }
}
