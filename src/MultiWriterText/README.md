# Immutable GC Contract for TextRGA Using MARK (aka “ack”)

This document defines an **immutable, non-coordinated garbage-collection contract** for a TextRGA that must retain history for correctness, but is allowed to compact history once all current writers have proven they are past a shared point.

Terminology note: this document uses the word **`ack`**, but it is **exactly the same thing as** the explicit history operation **`MARK(writerId, posId)`** (“I’m here” in the RGA coordinate space).

---

## Core Idea

Each writer periodically publishes an explicit operation:

```

ACK(writerId, posId) // == MARK(writerId, posId)

```

Where:

- `writerId` identifies the writer.
- `posId` refers to a position in the RGA operation coordinate space
  (e.g. an insert-id, or a tuple like `(writerId, seq)`).

`ACK` is part of the document’s replicated operation stream.

---

## Immutable Safety Invariant (Non-Negotiable)

A writer **MUST NOT** publish `ACK(writerId, posId)` unless it is true that:

> The writer has **integrated all document operations up to `posId`**
> (i.e. `posId` represents a **fully integrated prefix**, not just a seen point).

If this invariant is violated, GC becomes unsafe.

---

## Epoch Membership (Frozen Writer Set)

Garbage collection is performed relative to a **frozen writer set**:

```

epochWriters = WritersORSet.snapshot()

```

Rules:

- `epochWriters` is immutable for the duration of the GC decision.
- Writers removed from the OR-set must not be allowed to block GC indefinitely.
- Writers added later do not retroactively invalidate past GC.

---

## Determining the GC Cut Point (Single Reverse Traversal)

Given:

- `epochWriters`
- the operation log / history of the TextRGA

Algorithm:

1. Traverse the operation history from **newest → oldest**.
2. Maintain:

```

seenAck = Set<writerId>

```

3. For each operation encountered:

- If it is `ACK(w, pos)` and `w ∈ epochWriters`, then add `w` to `seenAck`.

4. The moment:

```

seenAck covers all epochWriters

```

then:

- Define the GC cut point `cut`:
  - either `cut = pos` of the last required ACK encountered, or
  - **safer**: `cut = min(pos of each writer’s first-seen ACK in this traversal)`

The “min-pos” variant guarantees the cut is not accidentally too far forward due to discovery order.

---

## What Becomes Collectable

Once `cut` is established, all history strictly within the **compacted prefix** may be removed:

- Tombstones whose delete-op is `<= cut`
- Operations `<= cut` that are fully covered by the prefix snapshot
- Any auxiliary per-op metadata that is only needed to interpret ops `<= cut`

Implementation-wise, you compact by:

1. Materializing a **snapshot** representing the document state at `cut`
2. Discarding or squashing operations `<= cut`
3. Keeping only the minimal structures required for:

- operations `> cut`
- correct future merges
- mapping positions after compaction

---

## Why This Works

This GC model works because:

- `ACK(writerId, posId)` is an explicit, replicated proof that the writer is past `posId`
- A frozen epoch prevents churn in membership from blocking or invalidating GC
- A single reverse traversal lets any node independently compute a safe cut point
- The invariant makes “past `posId`” mean “integrated the full prefix”, not “saw something once”

---

## Non-Goals

This contract does not attempt to provide:

- total ordering
- consensus
- backend replication safety
- correctness under invariant violation

It is strictly a **distributed UI / offline-first collaboration** garbage-collection contract.

---

## Summary

- Writers publish explicit `ACK(writerId, posId)` operations (same as MARK / “I’m here”).
- GC uses a frozen `epochWriters`.
- A node traverses newest→oldest until it has seen an ACK from every epoch writer.
- It computes a safe `cut` (preferably min-pos across those ACKs).
- It compacts everything `<= cut` into a snapshot and discards eligible tombstones/history.
- Safety depends on the immutable invariant: **ACK only after fully integrating the prefix**.

```

```
