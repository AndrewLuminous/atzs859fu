import { crc16modbus, HEADER } from "./protocol";

export type Parsed =
  | { kind: "frame"; frame: Buffer; crcOrder: "doc" | "swapped" } // doc это CRC старшим байтом вперёд, как в документе
  | { kind: "junk"; bytes: Buffer };

// Собирает пакеты из потока байт, недописанный пакет через 0,5 с и мусор через 0,2 с уходят в junk.
export class FrameParser {
  private buf = Buffer.alloc(0);
  private junk: number[] = [];
  private last = 0;

  feed(chunk: Buffer, now: number): Parsed[] {
    if (chunk.length) {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.last = now;
    }
    const out: Parsed[] = [];
    for (;;) {
      this.parse(out);
      if (this.buf.length && now - this.last > 500) {
        // обрывок пакета так и не дописался: сдвигаемся на байт
        this.junk.push(this.buf[0]);
        this.buf = this.buf.subarray(1);
        continue;
      }
      break;
    }
    if (this.junk.length && !this.buf.length && now - this.last > 200) {
      out.push({ kind: "junk", bytes: Buffer.from(this.junk) });
      this.junk = [];
    }
    return out;
  }

  private parse(out: Parsed[]): void {
    while (this.buf.length) {
      if (this.buf[0] !== HEADER) {
        this.drop();
        continue;
      }
      if (this.buf.length < 2) return;
      const length = this.buf[1];
      if (length < 5 || length > 64) {
        this.drop();
        continue;
      }
      if (this.buf.length < length) return;
      const frame = Buffer.from(this.buf.subarray(0, length));
      const crc = crc16modbus(frame.subarray(0, length - 2));
      const [hi, lo] = [frame[length - 2], frame[length - 1]];
      let crcOrder: "doc" | "swapped";
      if (hi === crc >> 8 && lo === (crc & 0xff)) crcOrder = "doc";
      else if (hi === (crc & 0xff) && lo === crc >> 8) crcOrder = "swapped";
      else {
        this.drop();
        continue;
      }
      if (this.junk.length) {
        out.push({ kind: "junk", bytes: Buffer.from(this.junk) });
        this.junk = [];
      }
      out.push({ kind: "frame", frame, crcOrder });
      this.buf = this.buf.subarray(length);
    }
  }

  private drop(): void {
    this.junk.push(this.buf[0]);
    this.buf = this.buf.subarray(1);
  }
}
