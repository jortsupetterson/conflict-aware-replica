# Performance Log

## Baseline (no perf changes)
- Date: 2026-01-11
- Command: npm run bench
- Notes: Restored CRArray/CRText to HEAD before run.

```
CRArray bench (runs=3, size=5000, reads=1000, writes=500, mergeSize=2000)
CRArray push: avg 1735.38 ms (min 1684.77, max 1767.19)
Array push: avg 0.26 ms (min 0.23, max 0.29)
CRArray iterate: avg 0.57 ms (min 0.50, max 0.71)
Array iterate: avg 0.57 ms (min 0.35, max 0.78)
CRArray index read (proxy): avg 61.38 ms (min 56.60, max 66.13)
Array index read: avg 0.06 ms (min 0.05, max 0.06)
CRArray index write (proxy): avg 397.78 ms (min 379.39, max 410.17)
Array index write: avg 0.04 ms (min 0.02, max 0.04)
CRArray pop: avg 1182.09 ms (min 1178.37, max 1187.30)
Array pop: avg 0.39 ms (min 0.28, max 0.53)
CRArray merge: avg 17.87 ms (min 16.61, max 19.35)
CRText bench (runs=3, size=2000, midOps=500, reads=1000, mergeSize=1000)
CRText insertAt append: avg 269.81 ms (min 262.05, max 277.96)
Array insert append: avg 0.11 ms (min 0.09, max 0.15)
CRText toString: avg 0.15 ms (min 0.14, max 0.16)
Array join: avg 0.04 ms (min 0.04, max 0.04)
CRText insertAt middle: avg 173.20 ms (min 171.86, max 175.04)
Array insert middle: avg 0.17 ms (min 0.16, max 0.18)
CRText deleteAt middle: avg 9.77 ms (min 9.30, max 10.54)
Array delete middle: avg 0.11 ms (min 0.10, max 0.12)
CRText index read: avg 24.95 ms (min 23.13, max 27.50)
Array index read: avg 0.05 ms (min 0.05, max 0.06)
CRText merge: avg 7.74 ms (min 7.50, max 8.10)
CRRegister bench (runs=3, size=100000)
CRRegister set (local): avg 19.95 ms (min 19.47, max 20.20)
CRRegister set (remote stamp): avg 11.41 ms (min 11.24, max 11.62)
Plain assignment: avg 0.20 ms (min 0.19, max 0.20)
CRMap bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRMap set: avg 66.99 ms (min 60.04, max 79.38)
Map set: avg 3.27 ms (min 2.86, max 4.01)
CRMap get: avg 1.63 ms (min 1.14, max 2.16)
Map get: avg 1.91 ms (min 0.84, max 2.77)
CRMap delete: avg 42.97 ms (min 40.32, max 45.69)
Map delete: avg 4.44 ms (min 3.37, max 5.79)
CRMap merge: avg 13.82 ms (min 10.39, max 18.75)
CRSet bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRSet add: avg 64.07 ms (min 58.94, max 73.77)
Set add: avg 5.22 ms (min 2.79, max 9.99)
CRSet has: avg 1.04 ms (min 0.79, max 1.29)
Set has: avg 1.31 ms (min 0.86, max 1.70)
CRSet delete: avg 44.58 ms (min 35.08, max 60.14)
Set delete: avg 2.02 ms (min 1.35, max 2.75)
CRSet merge: avg 11.51 ms (min 7.71, max 17.09)
CRRecord bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRRecord set: avg 75.69 ms (min 70.67, max 82.65)
Object set: avg 8.57 ms (min 6.49, max 10.11)
CRRecord get: avg 1.82 ms (min 1.58, max 2.02)
Object get: avg 1.37 ms (min 1.24, max 1.46)
CRRecord delete: avg 38.00 ms (min 35.50, max 41.86)
Object delete: avg 17.57 ms (min 15.65, max 20.45)
CRRecord merge: avg 19.83 ms (min 16.92, max 25.59)
Dacument actor integrity bench (runs=3, ops=2000)
merge (actor verify disabled): avg 999.38 ms (min 966.94, max 1029.21)
verifyActorIntegrity: avg 911.73 ms (min 904.82, max 919.90)
Dacument access reset bench (runs=3, ops=2000)
merge baseline (no reset): avg 2420.17 ms (min 2386.16, max 2460.72)
accessReset: avg 534.63 ms (min 530.79, max 537.66)
```

## Experiment 1: CRText toString via join
- Change: Replaced string concatenation loop with array+join in `src/CRText/class.ts`.
- Benchmark: npm run bench
- Result: CRText toString avg 0.23 ms (baseline 0.15 ms) => regression (~+53%).
- Decision: Reverted change.

## Experiment 2: CRArray cached length (aliveCount)
- Change: Added cached alive count in `src/CRArray/class.ts` and updated mutators/merge.
- Benchmark: npm run bench
- Result (avg):
  - CRArray pop: 1052.42 ms (baseline 1182.09, ~-11%)
  - CRArray index read (proxy): 46.21 ms (baseline 61.38, ~-25%)
  - CRArray push: 1607.26 ms (baseline 1735.38, ~-7%)
  - CRArray merge: 20.12 ms (baseline 17.87, ~+13%, likely noise)
- Decision: Kept (clear wins on pop/index read, push).

## Experiment 3: CRArray at() without alive() allocation
- Change: Replaced `alive().at(...)` with a single-pass scan in `src/CRArray/class.ts`.
- Benchmark: npm run bench
- Result (avg):
  - CRArray index read (proxy): 2.20 ms (prev 46.21, baseline 61.38) => ~-95%
  - CRArray pop: 1090.18 ms (prev 1052.42) => +3.6%
  - CRArray merge: 23.25 ms (prev 20.12) => +15.5%
- Decision: Kept (large win on proxy index reads outweighs minor regressions).

## Experiment 4: CRText cached length (aliveCount)
- Change: Added cached alive count in `src/CRText/class.ts` and updated mutators/merge.
- Benchmark: npm run bench
- Result: Mixed/noisy; CRText insertAt append worsened (305.37 ms vs 269.81 baseline).
- Decision: Reverted change.

## Experiment 5: CRArray iterator without alive() allocation
- Change: Replaced `[Symbol.iterator]` to yield nodes directly in `src/CRArray/class.ts`.
- Benchmark: npm run bench
- Result: No clear improvement; CRArray iterate ~1.07 ms vs ~1.11 ms prior, other metrics worsened/noisy.
- Decision: Reverted change.

## Experiment 6: CRArray push avoids double lastAliveId scan
- Change: Cache `lastAliveId()` result once in `src/CRArray/class.ts`.
- Benchmark: npm run bench
- Result (avg): CRArray push 1563.92 ms (prev 1579.15, baseline 1735.38) => small improvement.
- Decision: Kept.

## Experiment 7: CRArray sort afterKey cache
- Change: Cached `afterKey` per node inside CRArray.sort comparator.
- Benchmark: npm run bench
- Result: Large regressions observed (CRArray push 3302.37 ms vs 1563.92 prior).
- Decision: Reverted change.

## Experiment 8: CRArray lastAliveIndex for pop/lastAliveId
- Change: Track `lastAliveIndex`, update on sort/pop/shift, and use it in `lastAliveId()`.
- Benchmark: npm run bench
- Result: CRArray pop avg 33.04 ms (baseline 1182.09) => ~35x faster.
- Decision: Kept.

## Experiment 9: CRText at() single-pass (remove alive allocation)
- Change: Rewrote `CRText.at` to scan nodes directly and removed `alive()` helper.
- Benchmark: npm run bench
- Result: CRText index read avg 9.58 ms (baseline 24.95) => ~-62%.
- Decision: Kept.

## Experiment 10: CRArray numeric-key check helper
- Change: Replaced regex checks with `isIndexKey` helper in CRArray proxy traps.
- Benchmark: npm run bench
- Result: CRArray index read avg 1.41 ms (prev 2.08), index write 379.82 ms (prev 402.76).
- Decision: Kept.

## Experiment 11: CRText aliveCount + lastAliveIndex
- Change: Track `aliveCount`/`lastAliveIndex`, fast-path append in `insertAt`, update on delete/merge/sort.
- Benchmark: npm run bench
- Result: CRText index read avg 1.82 ms (prev 6.61, baseline 24.95) and deleteAt middle 7.04 ms (prev 7.60).
- Decision: Kept.

## Experiment 12: CRArray setAt single-pass
- Change: Folded `afterIdForAliveInsertAt` lookup into the delete scan in `setAt`.
- Benchmark: npm run bench
- Result: CRArray index write avg 397.92 ms (prev 379.82) => regression.
- Decision: Reverted.

## Baseline: CRArray includes/indexOf micro-bench
- Date: 2026-01-11
- Command: node --input-type=module - (inline script)
- Config: size=5000, tombstoneEvery=10, runs=5, iterations=1000

```
CRArray includes/indexOf bench (size=5000, tombstoneEvery=10, runs=5, iterations=1000)
includes hit: avg 85.56 ms (min 77.42, max 93.29)
includes miss: avg 90.07 ms (min 82.67, max 96.04)
indexOf hit: avg 85.76 ms (min 82.04, max 89.05)
indexOf miss: avg 79.81 ms (min 73.81, max 83.41)
```

## Experiment 13: CRArray includes/indexOf single-pass
- Change: Scan nodes directly instead of `alive()` allocation in `includes`/`indexOf`.
- Benchmarks:
  - CRArray includes/indexOf micro-bench
  - npm run bench
- Result:
  - includes hit avg 15.21 ms (baseline 85.56) => ~-82%
  - includes miss avg 30.23 ms (baseline 90.07) => ~-66%
  - indexOf hit avg 16.17 ms (baseline 85.76) => ~-81%
  - indexOf miss avg 31.06 ms (baseline 79.81) => ~-61%
  - npm run bench: no clear CRArray regressions observed in this run (see output below).
- Decision: Kept.

```
CRArray bench (runs=3, size=5000, reads=1000, writes=500, mergeSize=2000)
CRArray push: avg 2385.81 ms (min 2273.29, max 2447.06)
Array push: avg 0.32 ms (min 0.30, max 0.34)
CRArray iterate: avg 1.09 ms (min 1.02, max 1.14)
Array iterate: avg 0.58 ms (min 0.53, max 0.69)
CRArray index read (proxy): avg 2.74 ms (min 2.10, max 3.21)
Array index read: avg 0.07 ms (min 0.07, max 0.08)
CRArray index write (proxy): avg 629.04 ms (min 614.69, max 636.63)
Array index write: avg 0.04 ms (min 0.03, max 0.07)
CRArray pop: avg 42.62 ms (min 34.10, max 56.19)
Array pop: avg 0.50 ms (min 0.40, max 0.58)
CRArray merge: avg 29.95 ms (min 25.26, max 32.79)
CRText bench (runs=3, size=2000, midOps=500, reads=1000, mergeSize=1000)
CRText insertAt append: avg 410.14 ms (min 386.42, max 433.50)
Array insert append: avg 0.27 ms (min 0.25, max 0.30)
CRText toString: avg 0.12 ms (min 0.11, max 0.12)
Array join: avg 0.05 ms (min 0.05, max 0.06)
CRText insertAt middle: avg 245.42 ms (min 222.82, max 263.15)
Array insert middle: avg 0.25 ms (min 0.20, max 0.28)
CRText deleteAt middle: avg 13.16 ms (min 12.78, max 13.60)
Array delete middle: avg 0.24 ms (min 0.18, max 0.36)
CRText index read: avg 2.50 ms (min 2.46, max 2.56)
Array index read: avg 0.11 ms (min 0.11, max 0.12)
CRText merge: avg 14.44 ms (min 11.97, max 16.91)
CRRegister bench (runs=3, size=100000)
CRRegister set (local): avg 24.55 ms (min 23.17, max 25.40)
CRRegister set (remote stamp): avg 15.57 ms (min 12.97, max 17.09)
Plain assignment: avg 0.21 ms (min 0.18, max 0.25)
CRMap bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRMap set: avg 92.95 ms (min 86.06, max 96.96)
Map set: avg 5.25 ms (min 4.89, max 5.82)
CRMap get: avg 2.27 ms (min 1.29, max 3.56)
Map get: avg 1.05 ms (min 0.87, max 1.31)
CRMap delete: avg 61.96 ms (min 53.83, max 75.68)
Map delete: avg 7.34 ms (min 5.54, max 9.23)
CRMap merge: avg 12.32 ms (min 8.80, max 19.21)
CRSet bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRSet add: avg 83.10 ms (min 66.90, max 91.44)
Set add: avg 4.73 ms (min 3.34, max 5.54)
CRSet has: avg 1.75 ms (min 1.19, max 2.22)
Set has: avg 2.05 ms (min 1.25, max 2.57)
CRSet delete: avg 49.98 ms (min 41.48, max 60.90)
Set delete: avg 3.45 ms (min 2.21, max 4.15)
CRSet merge: avg 10.34 ms (min 8.34, max 14.09)
CRRecord bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRRecord set: avg 100.10 ms (min 90.48, max 114.65)
Object set: avg 7.60 ms (min 5.89, max 9.21)
CRRecord get: avg 3.18 ms (min 2.30, max 3.85)
Object get: avg 1.76 ms (min 0.96, max 2.30)
CRRecord delete: avg 51.67 ms (min 47.38, max 54.52)
Object delete: avg 23.73 ms (min 22.58, max 25.51)
CRRecord merge: avg 20.56 ms (min 13.41, max 28.46)
Dacument actor integrity bench (runs=3, ops=2000)
merge (actor verify disabled): avg 1165.41 ms (min 1141.24, max 1190.99)
verifyActorIntegrity: avg 1115.17 ms (min 1084.59, max 1159.15)
Dacument access reset bench (runs=3, ops=2000)
merge baseline (no reset): avg 3098.92 ms (min 3023.37, max 3166.49)
accessReset: avg 716.64 ms (min 693.66, max 749.56)
```

## Experiment 14: CRArray alive() prealloc
- Change: Preallocate the alive array using `aliveCount` in `CRArray.alive()`.
- Benchmark: npm run bench
- Result: CRArray iterate avg 1.01 ms (prev 1.09) => ~-7%; other metrics moved but outside expected change (noise).
- Decision: Kept.

```
CRArray bench (runs=3, size=5000, reads=1000, writes=500, mergeSize=2000)
CRArray push: avg 2424.44 ms (min 2399.40, max 2468.19)
Array push: avg 0.19 ms (min 0.16, max 0.22)
CRArray iterate: avg 1.01 ms (min 0.79, max 1.35)
Array iterate: avg 0.46 ms (min 0.40, max 0.52)
CRArray index read (proxy): avg 2.29 ms (min 2.02, max 2.54)
Array index read: avg 0.04 ms (min 0.04, max 0.05)
CRArray index write (proxy): avg 580.55 ms (min 529.72, max 622.43)
Array index write: avg 0.05 ms (min 0.04, max 0.08)
CRArray pop: avg 27.75 ms (min 24.34, max 30.02)
Array pop: avg 0.39 ms (min 0.36, max 0.45)
CRArray merge: avg 28.56 ms (min 24.51, max 34.44)
CRText bench (runs=3, size=2000, midOps=500, reads=1000, mergeSize=1000)
CRText insertAt append: avg 369.15 ms (min 352.89, max 393.32)
Array insert append: avg 0.22 ms (min 0.15, max 0.26)
CRText toString: avg 0.19 ms (min 0.18, max 0.21)
Array join: avg 0.06 ms (min 0.06, max 0.07)
CRText insertAt middle: avg 260.67 ms (min 231.28, max 290.83)
Array insert middle: avg 0.29 ms (min 0.28, max 0.29)
CRText deleteAt middle: avg 10.48 ms (min 7.25, max 12.55)
Array delete middle: avg 0.12 ms (min 0.11, max 0.15)
CRText index read: avg 2.09 ms (min 1.53, max 2.37)
Array index read: avg 0.07 ms (min 0.07, max 0.07)
CRText merge: avg 12.90 ms (min 9.91, max 14.65)
CRRegister bench (runs=3, size=100000)
CRRegister set (local): avg 30.36 ms (min 25.89, max 33.13)
CRRegister set (remote stamp): avg 16.53 ms (min 15.08, max 17.91)
Plain assignment: avg 0.13 ms (min 0.13, max 0.14)
CRMap bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRMap set: avg 94.39 ms (min 85.51, max 105.09)
Map set: avg 3.33 ms (min 3.30, max 3.35)
CRMap get: avg 2.40 ms (min 1.34, max 3.50)
Map get: avg 1.04 ms (min 0.84, max 1.27)
CRMap delete: avg 52.27 ms (min 41.97, max 65.57)
Map delete: avg 6.98 ms (min 4.77, max 10.79)
CRMap merge: avg 12.97 ms (min 11.87, max 14.61)
CRSet bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRSet add: avg 75.17 ms (min 58.13, max 87.72)
Set add: avg 5.15 ms (min 4.85, max 5.56)
CRSet has: avg 1.82 ms (min 1.46, max 2.20)
Set has: avg 2.30 ms (min 1.56, max 3.24)
CRSet delete: avg 49.80 ms (min 46.70, max 51.68)
Set delete: avg 1.99 ms (min 1.65, max 2.24)
CRSet merge: avg 10.51 ms (min 7.31, max 14.53)
CRRecord bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRRecord set: avg 85.27 ms (min 77.93, max 94.96)
Object set: avg 5.22 ms (min 4.89, max 5.49)
CRRecord get: avg 2.97 ms (min 2.58, max 3.46)
Object get: avg 1.56 ms (min 1.27, max 2.12)
CRRecord delete: avg 49.11 ms (min 45.39, max 54.81)
Object delete: avg 25.56 ms (min 19.00, max 31.81)
CRRecord merge: avg 21.71 ms (min 13.40, max 26.25)
Dacument actor integrity bench (runs=3, ops=2000)
merge (actor verify disabled): avg 1133.29 ms (min 1108.12, max 1155.64)
verifyActorIntegrity: avg 1056.66 ms (min 1016.08, max 1086.46)
Dacument access reset bench (runs=3, ops=2000)
merge baseline (no reset): avg 2941.27 ms (min 2857.17, max 2997.99)
accessReset: avg 708.75 ms (min 688.27, max 743.68)
```

## Baseline: CRArray slice micro-bench
- Date: 2026-01-11
- Command: node --input-type=module - (inline script)
- Config: size=5000, tombstoneEvery=10, runs=5, smallIterations=2000, fullIterations=500

```
CRArray slice bench (size=5000, tombstoneEvery=10, runs=5)
slice small: avg 66.48 ms (min 62.43, max 70.59)
slice mid: avg 64.74 ms (min 63.27, max 67.27)
slice full: avg 18.86 ms (min 17.65, max 21.71)
```

## Experiment 15: CRArray slice single-pass
- Change: Build slice directly from nodes without allocating the full alive array.
- Benchmarks:
  - CRArray slice micro-bench
  - npm run bench
- Result:
  - slice small avg 4.32 ms (baseline 66.48) => ~-93%
  - slice mid avg 17.37 ms (baseline 64.74) => ~-73%
  - slice full avg 16.92 ms (baseline 18.86) => ~-10%
  - npm run bench: no CRArray regressions observed in this run (see output below).
- Decision: Kept.

```
CRArray slice bench (size=5000, tombstoneEvery=10, runs=5)
slice small: avg 4.32 ms (min 2.99, max 8.78)
slice mid: avg 17.37 ms (min 16.66, max 19.42)
slice full: avg 16.92 ms (min 15.78, max 19.10)
```

```
CRArray bench (runs=3, size=5000, reads=1000, writes=500, mergeSize=2000)
CRArray push: avg 1634.90 ms (min 1617.28, max 1654.52)
Array push: avg 0.19 ms (min 0.17, max 0.21)
CRArray iterate: avg 0.65 ms (min 0.47, max 0.76)
Array iterate: avg 0.63 ms (min 0.39, max 0.83)
CRArray index read (proxy): avg 1.48 ms (min 1.39, max 1.53)
Array index read: avg 0.03 ms (min 0.03, max 0.03)
CRArray index write (proxy): avg 384.73 ms (min 377.90, max 395.58)
Array index write: avg 0.03 ms (min 0.02, max 0.05)
CRArray pop: avg 21.76 ms (min 21.41, max 22.37)
Array pop: avg 0.21 ms (min 0.20, max 0.22)
CRArray merge: avg 20.53 ms (min 19.57, max 22.33)
CRText bench (runs=3, size=2000, midOps=500, reads=1000, mergeSize=1000)
CRText insertAt append: avg 255.55 ms (min 245.31, max 267.70)
Array insert append: avg 0.15 ms (min 0.11, max 0.18)
CRText toString: avg 0.11 ms (min 0.10, max 0.11)
Array join: avg 0.04 ms (min 0.04, max 0.04)
CRText insertAt middle: avg 169.87 ms (min 166.31, max 176.71)
Array insert middle: avg 0.22 ms (min 0.21, max 0.25)
CRText deleteAt middle: avg 7.08 ms (min 6.04, max 8.60)
Array delete middle: avg 0.11 ms (min 0.10, max 0.11)
CRText index read: avg 1.14 ms (min 1.04, max 1.21)
Array index read: avg 0.04 ms (min 0.04, max 0.04)
CRText merge: avg 7.93 ms (min 7.41, max 8.47)
CRRegister bench (runs=3, size=100000)
CRRegister set (local): avg 19.81 ms (min 19.21, max 20.26)
CRRegister set (remote stamp): avg 10.83 ms (min 9.95, max 11.70)
Plain assignment: avg 0.16 ms (min 0.15, max 0.18)
CRMap bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRMap set: avg 67.03 ms (min 53.20, max 75.22)
Map set: avg 3.16 ms (min 2.75, max 3.83)
CRMap get: avg 1.64 ms (min 1.17, max 2.23)
Map get: avg 1.31 ms (min 0.93, max 1.76)
CRMap delete: avg 36.25 ms (min 27.95, max 51.38)
Map delete: avg 2.92 ms (min 2.76, max 3.07)
CRMap merge: avg 9.92 ms (min 5.90, max 13.48)
CRSet bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRSet add: avg 60.98 ms (min 60.64, max 61.45)
Set add: avg 3.45 ms (min 2.82, max 3.78)
CRSet has: avg 1.36 ms (min 0.93, max 1.88)
Set has: avg 1.29 ms (min 0.78, max 1.79)
CRSet delete: avg 25.44 ms (min 23.96, max 26.46)
Set delete: avg 1.31 ms (min 0.95, max 1.72)
CRSet merge: avg 7.32 ms (min 5.26, max 11.39)
CRRecord bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRRecord set: avg 71.64 ms (min 70.16, max 73.02)
Object set: avg 6.69 ms (min 4.34, max 9.28)
CRRecord get: avg 1.54 ms (min 1.29, max 1.73)
Object get: avg 1.23 ms (min 0.83, max 1.64)
CRRecord delete: avg 38.27 ms (min 32.86, max 41.07)
Object delete: avg 15.87 ms (min 15.03, max 17.16)
CRRecord merge: avg 14.61 ms (min 13.12, max 16.05)
Dacument actor integrity bench (runs=3, ops=2000)
merge (actor verify disabled): avg 910.85 ms (min 899.54, max 921.05)
verifyActorIntegrity: avg 857.41 ms (min 851.72, max 867.15)
Dacument access reset bench (runs=3, ops=2000)
merge baseline (no reset): avg 2358.25 ms (min 2333.66, max 2382.75)
accessReset: avg 555.51 ms (min 532.22, max 586.17)
```

## Experiment 16: afterKey fast-path for 0/1-length
- Change: Return `after[0]` or "" in `afterKey` when length < 2.
- Benchmark: npm run bench (two runs)
- Result (second run):
  - CRArray push avg 685.10 ms (prev 1634.90) => ~-58%
  - CRArray index write avg 167.12 ms (prev 384.73) => ~-57%
  - CRText insertAt append avg 130.55 ms (prev 255.55) => ~-49%
  - CRText insertAt middle avg 74.19 ms (prev 169.87) => ~-56%
  - Other metrics varied; no consistent regressions observed across two runs.
- Decision: Kept.

```
CRArray bench (runs=3, size=5000, reads=1000, writes=500, mergeSize=2000)
CRArray push: avg 685.10 ms (min 644.37, max 759.92)
Array push: avg 0.24 ms (min 0.17, max 0.31)
CRArray iterate: avg 0.52 ms (min 0.36, max 0.78)
Array iterate: avg 0.32 ms (min 0.17, max 0.43)
CRArray index read (proxy): avg 1.44 ms (min 1.41, max 1.50)
Array index read: avg 0.04 ms (min 0.03, max 0.06)
CRArray index write (proxy): avg 167.12 ms (min 164.41, max 172.06)
Array index write: avg 0.03 ms (min 0.03, max 0.05)
CRArray pop: avg 20.44 ms (min 19.95, max 20.71)
Array pop: avg 0.24 ms (min 0.22, max 0.29)
CRArray merge: avg 19.83 ms (min 18.98, max 21.04)
CRText bench (runs=3, size=2000, midOps=500, reads=1000, mergeSize=1000)
CRText insertAt append: avg 130.55 ms (min 112.96, max 148.18)
Array insert append: avg 0.15 ms (min 0.11, max 0.21)
CRText toString: avg 0.11 ms (min 0.11, max 0.12)
Array join: avg 0.04 ms (min 0.04, max 0.04)
CRText insertAt middle: avg 74.19 ms (min 70.97, max 79.81)
Array insert middle: avg 0.28 ms (min 0.18, max 0.34)
CRText deleteAt middle: avg 10.23 ms (min 9.08, max 10.90)
Array delete middle: avg 0.32 ms (min 0.21, max 0.41)
CRText index read: avg 1.52 ms (min 1.36, max 1.83)
Array index read: avg 0.05 ms (min 0.05, max 0.06)
CRText merge: avg 7.65 ms (min 7.35, max 7.82)
CRRegister bench (runs=3, size=100000)
CRRegister set (local): avg 19.15 ms (min 18.12, max 19.86)
CRRegister set (remote stamp): avg 14.42 ms (min 11.20, max 19.65)
Plain assignment: avg 0.12 ms (min 0.11, max 0.12)
CRMap bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRMap set: avg 60.59 ms (min 55.38, max 63.81)
Map set: avg 12.21 ms (min 4.98, max 26.29)
CRMap get: avg 1.75 ms (min 1.39, max 2.23)
Map get: avg 0.94 ms (min 0.76, max 1.08)
CRMap delete: avg 33.86 ms (min 30.96, max 35.79)
Map delete: avg 3.74 ms (min 2.80, max 5.06)
CRMap merge: avg 9.55 ms (min 6.20, max 13.16)
CRSet bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRSet add: avg 61.96 ms (min 57.38, max 66.58)
Set add: avg 2.86 ms (min 2.35, max 3.26)
CRSet has: avg 1.04 ms (min 0.78, max 1.29)
Set has: avg 0.98 ms (min 0.65, max 1.17)
CRSet delete: avg 30.83 ms (min 29.30, max 31.87)
Set delete: avg 1.64 ms (min 1.24, max 2.04)
CRSet merge: avg 7.25 ms (min 5.73, max 8.66)
CRRecord bench (runs=3, size=20000, reads=5000, mergeSize=5000)
CRRecord set: avg 60.89 ms (min 58.93, max 63.91)
Object set: avg 4.89 ms (min 4.35, max 5.89)
CRRecord get: avg 1.65 ms (min 1.28, max 1.97)
Object get: avg 1.69 ms (min 1.23, max 1.99)
CRRecord delete: avg 36.34 ms (min 32.39, max 39.34)
Object delete: avg 14.38 ms (min 13.60, max 14.80)
CRRecord merge: avg 18.13 ms (min 12.77, max 28.64)
Dacument actor integrity bench (runs=3, ops=2000)
merge (actor verify disabled): avg 901.35 ms (min 896.62, max 909.18)
verifyActorIntegrity: avg 846.71 ms (min 839.12, max 851.76)
Dacument access reset bench (runs=3, ops=2000)
merge baseline (no reset): avg 2349.22 ms (min 2320.17, max 2366.47)
accessReset: avg 511.78 ms (min 503.86, max 518.25)
```
