import { test } from "node:test";
import assert from "node:assert/strict";
import { CMD_START, CMD_STOP, cmdUnit, describe, FrameParser, hex, Kind, makeFrame, Unit } from "../src";

const b = (s: string) => Buffer.from(s.replace(/ /g, ""), "hex");

test("пакеты из документа и с настоящего устройства совпадают", () => {
  assert.equal(hex(CMD_START), "FD 05 02 A1 62");
  assert.equal(hex(CMD_STOP), "FD 05 08 A6 E2");
  assert.equal(hex(makeFrame(Kind.Start, [4])), "FD 06 02 04 2A D1");
  assert.equal(hex(makeFrame(Kind.Blow)), "FD 05 03 61 A3");
  assert.equal(hex(makeFrame(Kind.Collecting)), "FD 05 04 A3 E2");
  assert.equal(hex(makeFrame(Kind.BlowError)), "FD 05 05 63 23");
  assert.equal(hex(makeFrame(Kind.Analyzing)), "FD 05 06 62 63");
  assert.equal(hex(makeFrame(Kind.Result, [0x00, 0x35])), "FD 07 07 00 35 76 39");
  assert.equal(hex(makeFrame(Kind.Unit)), "FD 05 17 6E A3"); // ответ на смену единиц
  assert.equal(hex(cmdUnit(Unit.MgL)), "FD 06 17 01 B9 1F"); // в документе ошибочно A6 E2
  assert.equal(hex(cmdUnit(Unit.BAC)), "FD 06 17 00 79 DE");
});

test("результат разбирается старшим байтом вперёд", () => {
  assert.deepEqual(describe(b("FD 07 07 02 B7 77 B8")).event, { type: "result", raw: 695 });
  assert.deepEqual(describe(b("FD 06 02 03 E8 90")).event, { type: "countdown", n: 3 });
});

test("пакеты, разорванные на куски по 3 байта, собираются", () => {
  const p = new FrameParser();
  const stream = Buffer.concat([b("FD 06 02 04 2A D1"), b("FD 05 03 61 A3"), b("FD 07 07 00 00 61 F9")]);
  const out = [];
  for (let i = 0; i < stream.length; i += 3) out.push(...p.feed(stream.subarray(i, i + 3), i));
  assert.deepEqual(out.map((x) => x.kind), ["frame", "frame", "frame"]);
});

test("мусор отделяется, битый CRC уходит в мусор, обратный порядок CRC распознаётся", () => {
  let out = new FrameParser().feed(b("00 AA FD 05 03 61 A3 11"), 0);
  out.push(...new FrameParser().feed(Buffer.alloc(0), 1000));
  const p = new FrameParser();
  out = [...p.feed(b("00 AA FD 05 03 61 A3 11"), 0), ...p.feed(Buffer.alloc(0), 1000)];
  assert.deepEqual(out.map((x) => (x.kind === "frame" ? hex(x.frame) : `мусор ${hex(x.bytes)}`)),
    ["мусор 00 AA", "FD 05 03 61 A3", "мусор 11"]);

  const swapped = new FrameParser().feed(b("FD 05 03 A3 61"), 0);
  assert.equal(swapped[0].kind === "frame" && swapped[0].crcOrder, "swapped");

  const p2 = new FrameParser();
  const bad = [...p2.feed(b("FD 05 03 00 00 FD 05 04 A3 E2"), 0), ...p2.feed(Buffer.alloc(0), 1000)];
  assert.deepEqual(bad.map((x) => x.kind), ["junk", "frame"]);
});

test("недописанный пакет через 0,5 с уходит в мусор", () => {
  const p = new FrameParser();
  assert.deepEqual(p.feed(b("FD 07 07 00"), 0), []);
  const out = p.feed(Buffer.alloc(0), 800);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind === "junk" && hex(out[0].bytes), "FD 07 07 00");
});
