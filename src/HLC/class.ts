export class HLC {
  constructor(
    public wallClockMs: number,
    public logicalCounter: number,
    public timestampId: string
  ) {}

  static init(): HLC {
    return new HLC(Date.now(), 0, crypto.randomUUID());
  }

  static now(clock: HLC): HLC {
    const nowMs = Date.now();
    if (nowMs > clock.wallClockMs) return new HLC(nowMs, 0, clock.timestampId);
    return new HLC(
      clock.wallClockMs,
      clock.logicalCounter + 1,
      clock.timestampId
    );
  }

  static adjust(clock: HLC, seen: HLC): HLC {
    const nowMs = Date.now();
    const maxWall = Math.max(nowMs, clock.wallClockMs, seen.wallClockMs);

    let nextCounter = 0;
    if (maxWall === clock.wallClockMs && maxWall === seen.wallClockMs) {
      nextCounter = Math.max(clock.logicalCounter, seen.logicalCounter) + 1;
    } else if (maxWall === clock.wallClockMs) {
      nextCounter = clock.logicalCounter + 1;
    } else if (maxWall === seen.wallClockMs) {
      nextCounter = seen.logicalCounter + 1;
    } else {
      nextCounter = 0;
    }

    return new HLC(maxWall, nextCounter, clock.timestampId);
  }

  static isNewer(current: HLC, suggested: HLC): boolean {
    if (suggested.wallClockMs !== current.wallClockMs)
      return suggested.wallClockMs > current.wallClockMs;
    if (suggested.logicalCounter !== current.logicalCounter)
      return suggested.logicalCounter > current.logicalCounter;
    return suggested.timestampId > current.timestampId;
  }
}
