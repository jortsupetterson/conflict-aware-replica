export function compareHLC(left, right) {
    if (left.wallTimeMs !== right.wallTimeMs)
        return left.wallTimeMs - right.wallTimeMs;
    if (left.logical !== right.logical)
        return left.logical - right.logical;
    if (left.clockId === right.clockId)
        return 0;
    return left.clockId < right.clockId ? -1 : 1;
}
export class HLC {
    last;
    constructor(clockId) {
        this.last = { wallTimeMs: 0, logical: 0, clockId };
    }
    next(nowMs = Date.now()) {
        const wallTimeMs = Math.max(nowMs, this.last.wallTimeMs);
        const logical = wallTimeMs === this.last.wallTimeMs ? this.last.logical + 1 : 0;
        const next = { wallTimeMs, logical, clockId: this.last.clockId };
        this.last = next;
        return next;
    }
    observe(stamp) {
        const mergedWall = Math.max(this.last.wallTimeMs, stamp.wallTimeMs, Date.now());
        const mergedLogical = mergedWall === this.last.wallTimeMs
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
    get current() {
        return this.last;
    }
}
