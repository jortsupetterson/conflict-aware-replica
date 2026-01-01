import { HLC } from "../HLC/class";
type Entry<T> = { value: T; hlc: HLC };

export class LWWRegister<T> {
  private clock = HLC.now();
  private current?: Entry<T>;

  /** UI/local propose: generates HLC internally */
  suggest(value: T): Entry<T> {
    this.clock = HLC.now(this.clock);
    return { value, hlc: this.clock };
  }

  /** Any suggestion observed (UI-generated or received): updates clock and applies LIW decision */
  race(suggested: Entry<T>): boolean {
    this.clock = HLC.observe(this.clock, suggested.hlc);

    if (!this.current || HLC.isNewer(this.current.hlc, suggested.hlc)) {
      this.current = suggested;
      return true; // accepted
    }
    return false; // rejected
  }

  get snapshot(): Entry<T> | undefined {
    return this.current;
  }

  get value(): T | undefined {
    return this.current?.value;
  }

  static wins(current: HLC, suggested: HLC): boolean {
    if (suggested.wallClockMs !== current.wallClockMs) {
      return suggested.wallClockMs > current.wallClockMs;
    }
    if (suggested.logicalCounter !== current.logicalCounter) {
      return suggested.logicalCounter > current.logicalCounter;
    }
    return suggested.timestampId > current.timestampId;
  }
}
