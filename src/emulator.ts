import { MockBinding, MockPortBinding } from "@serialport/binding-mock";
import type { BindingInterface, OpenOptions } from "@serialport/bindings-interface";
import { FrameParser } from "./parser";
import { Kind, makeFrame } from "./protocol";

// Эмулятор ATZS-859FU для тестов и демо, паузы взяты с настоящего устройства.
export class Emulator {
  blows = 0;
  waiting = false; // отправлено "дуйте", выдоха ещё не было
  muteUntil = 0; // до этого времени (Date.now()) молчит, как только что включённое устройство
  private port: MockPortBinding | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly parser = new FrameParser();

  // speed 0.05 даёт скорость в 20 раз выше настоящей, autoBlow дует сам через 1,5 с после приглашения
  constructor(readonly path: string, private readonly opt: { speed?: number; autoBlow?: boolean } = {}) {}

  /** Подключено к порту (вызывает MockLab при открытии). */
  attach(port: MockPortBinding): void {
    this.port = port;
  }

  /** Байты от терминала. */
  receive(data: Buffer): void {
    if (Date.now() < this.muteUntil) return;
    for (const item of this.parser.feed(data, Date.now())) {
      if (item.kind !== "frame") continue;
      const kind = item.frame[2];
      if (kind === Kind.Start) {
        this.cancel();
        for (let i = 0; i < 4; i++) this.later(20 + 1020 * i, makeFrame(Kind.Start, [4 - i]));
        this.later(4100, makeFrame(Kind.Blow), () => (this.waiting = true));
        if (this.opt.autoBlow) this.at(5600, () => this.blow());
      } else if (kind === Kind.Stop) {
        this.cancel();
        this.send(item.frame);
      } else if (kind === Kind.Unit) {
        this.send(makeFrame(Kind.Unit));
      }
    }
  }

  /** Имитировать выдох, вернёт false, если устройство сейчас не ждёт выдоха. */
  blow(): boolean {
    if (!this.waiting) return false;
    this.waiting = false;
    this.blows++;
    this.send(makeFrame(Kind.Collecting));
    // каждый третий выдох прерывается, чтобы было на чём проверять ошибки
    if (this.blows % 3 === 0) {
      this.later(900, makeFrame(Kind.BlowError));
      this.later(2940, makeFrame(Kind.Blow), () => (this.waiting = true));
    } else {
      const raw = this.blows % 2 ? 53 : 0;
      this.later(2040, makeFrame(Kind.Analyzing));
      this.later(6180, makeFrame(Kind.Result, [raw >> 8, raw & 0xff]));
    }
    return true;
  }

  /** Отправить что угодно, как будто это прислало устройство (для тестов сбоев). */
  send(data: Buffer): void {
    if (this.port?.isOpen) this.port.emitData(data);
  }

  /** Замолчать посреди теста (для тестов зависания). */
  hang(): void {
    this.cancel();
  }

  private cancel(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.waiting = false;
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms * (this.opt.speed ?? 1)));
  }

  private later(ms: number, frame: Buffer, then?: () => void): void {
    this.at(ms, () => {
      this.send(frame);
      then?.();
    });
  }
}

// Поддельные порты (эмуляторы, молчащие CH340 и другие устройства), binding подставляется вместо serialport.
export class MockLab {
  readonly opened: string[] = []; // какие порты открывали, чтобы проверить, что чужие не трогали
  readonly written = new Map<string, Buffer>(); // что отправляли в каждый порт
  private readonly devices = new Map<string, Emulator>();

  constructor() {
    MockBinding.reset();
  }

  addAlcotester(path: string, opt: { speed?: number; autoBlow?: boolean } = {}): Emulator {
    MockBinding.createPort(path, { echo: false, record: false, vendorId: "1a86", productId: "7523", manufacturer: "wch.cn" });
    const emu = new Emulator(path, opt);
    this.devices.set(path, emu);
    return emu;
  }

  /** Порт, который ничего не отвечает: например, другое устройство на CH340. */
  addSilent(path: string, vendorId = "1a86", productId = "7523"): void {
    MockBinding.createPort(path, { echo: false, record: false, vendorId, productId });
  }

  readonly binding: BindingInterface = {
    list: () => MockBinding.list(),
    open: async (options: OpenOptions) => {
      this.opened.push(options.path);
      const port = await MockBinding.open(options);
      const write = port.write.bind(port);
      const emu = this.devices.get(options.path);
      emu?.attach(port);
      port.write = async (buffer: Buffer) => {
        await write(buffer);
        this.written.set(options.path, Buffer.concat([this.written.get(options.path) ?? Buffer.alloc(0), buffer]));
        emu?.receive(buffer);
      };
      return port;
    },
  };
}
