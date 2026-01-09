export type HLCStamp = {
    /** Unix ms */
    readonly wallTimeMs: number;
    /** logical counter for same/older wallTimeMs */
    readonly logical: number;
    /** stable actor/node id for deterministic tie-break */
    readonly clockId: string;
};
export declare function compareHLC(left: HLCStamp, right: HLCStamp): number;
export declare class HLC {
    private last;
    constructor(clockId: string);
    next(nowMs?: number): HLCStamp;
    observe(stamp: HLCStamp): void;
    get current(): HLCStamp;
}
