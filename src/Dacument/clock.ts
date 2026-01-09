export type HLCStamp = {
  /** Unix ms */
  readonly wallTimeMs: number;
  /** logical counter for same/older wallTimeMs */
  readonly logical: number;
  /** stable actor/node id for deterministic tie-break */
  readonly clockId: string;
};

export function compareHLC(left: HLCStamp, right: HLCStamp): number {
  if (left.wallTimeMs !== right.wallTimeMs)
    return left.wallTimeMs - right.wallTimeMs;
  if (left.logical !== right.logical) return left.logical - right.logical;
  if (left.clockId === right.clockId) return 0;
  return left.clockId < right.clockId ? -1 : 1;
}

export class HLC {
  private last: HLCStamp;

  constructor(clockId: string) {
    this.last = { wallTimeMs: 0, logical: 0, clockId };
  }

  next(nowMs = Date.now()): HLCStamp {
    const wallTimeMs = Math.max(nowMs, this.last.wallTimeMs);
    const logical =
      wallTimeMs === this.last.wallTimeMs ? this.last.logical + 1 : 0;
    const next = { wallTimeMs, logical, clockId: this.last.clockId };
    this.last = next;
    return next;
  }

  observe(stamp: HLCStamp): void {
    const mergedWall = Math.max(
      this.last.wallTimeMs,
      stamp.wallTimeMs,
      Date.now()
    );
    const mergedLogical =
      mergedWall === this.last.wallTimeMs
        ? Math.max(this.last.logical, stamp.logical) + 1
        : mergedWall === stamp.wallTimeMs
        ? stamp.logical
        : 0;
    this.last = {
      wallTimeMs: mergedWall,
      logical: mergedLogical,
      clockId: this.last.clockId,
    };
  }

  get current(): HLCStamp {
    return this.last;
  }
}
