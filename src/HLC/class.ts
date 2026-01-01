export class HLC {
  constructor(
    public wallClockMs: number,
    public logicalCounter: number,
    public timestampId: string
  ) {}

  static now(clock?: HLC): HLC {
    const nowMs = Date.now();

    if (!clock) {
      return new HLC(nowMs, 0, crypto.randomUUID());
    }

    if (nowMs > clock.wallClockMs) {
      return new HLC(nowMs, 0, clock.timestampId);
    }

    return new HLC(
      clock.wallClockMs,
      clock.logicalCounter + 1,
      clock.timestampId
    );
  }

  static adjust(clock: HLC, seen: HLC): HLC {
    const nowMs = Date.now();
    const maxWall = Math.max(nowMs, clock.wallClockMs, seen.wallClockMs);

    let nextCounter: number;
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
}
