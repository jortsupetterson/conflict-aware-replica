# A UX-First LATEST-INTENTION-WINS (LIW) Register

_For Offline-Capable Distributed User Interfaces_

## Abstract

This document defines a **LATEST-INTENTION-WINS (LIW)** resolution model for **single-value primitive registers** in offline-capable **distributed user interfaces**.

LIW is a **UI-level intent resolution mechanism**, not a distributed systems consistency model.
It is explicitly designed to preserve **human intent**, **UX safety**, and **explicit decision points** under imperfect network conditions.

This specification **matches the `LIWRegister` implementation exactly**.

---

## What This Model Is (and Is Not)

### This model **is** for

- Offline-first UIs and PWAs
- Local-first application state
- Realtime form inputs, toggles, and settings
- Human-authored intent synchronized across devices
- UI-level state reconciliation

### This model **is not** for

- Backend replication
- Database synchronization
- CRDT correctness
- Financial or ledger systems
- Distributed consensus

LIW assumes **humans**, **UIs**, and **unreliable clocks**.

---

## Scope and Assumptions

- **Layer:** UI / application state
- **Data type:** single-value register
- **Supported value types:** `string | number | boolean`
- **System:** multi-device, offline-capable UI
- No central coordinator
- No logical clocks
- No total ordering
- Offline writes may arrive arbitrarily late
- Merge semantics are **application-defined**

All unsupported value types are rejected at runtime.

---

## Environment Requirements

`LIWRegister` **requires a browser UI runtime** that provides:

- `navigator.onLine: boolean`

This signal captures whether the device was **online at the moment the value was written**.

It is treated strictly as a **UX-level signal**, not a correctness guarantee.

If `navigator.onLine` is unavailable, **construction fails immediately**.

LIW is **undefined** in headless, server-side, or backend-only runtimes.

---

## Register State

Each register instance carries exactly:

- `value: string | number | boolean`
- `online: boolean` (captured at creation time)
- `timestamp: number` (wall-clock milliseconds)

No other metadata exists or is inferred.

---

## Snapshot Format

A register may be serialized as a snapshot string:

```ts
type LIWSnapshot = `{"value":${
  | string
  | number
  | boolean},"online":${boolean},"timestamp":${number}}`;
```

Snapshots are JSON-encoded and parsed during resolution.

---

## Resolution API (Authoritative)

### `resolveIntent(snapshot): Promise<void>`

- Accepts a serialized `LIWSnapshot`
- Parses it into a **received** `LIWRegister`
- Compares it against the **stored** instance (`this`)
- **Does not return a value**
- **Does not mutate the stored instance**
- Emits the resolution result via callbacks

State updates are **external** to the register.

---

## Required Callbacks

### `onresolved(resolved: LIWRegister)`

- **Mandatory**
- Called exactly once per `resolveIntent()` invocation
- Receives the final resolved register instance
- Caller is responsible for storing or applying it

If missing, resolution fails with a runtime error.

---

### `onconflict(received, stored): Promise<LIWRegister>`

- **Required only in conflict scenarios**
- Must return a `LIWRegister`
- May be asynchronous
- May return either:

  - a new instance, or
  - one of the provided instances

Invalid return values cause a runtime error.

---

## Type Safety Rules

- `typeof received.value` **must match** `typeof stored.value`
- Mismatched value types cause immediate failure
- No coercion or conversion is allowed

---

## Decision Model (Exact Semantics)

Let:

- `receivedTs = received.timestamp`
- `storedTs = this.timestamp`
- `receivedOnline = received.online`

### 1. Online + non-newer timestamp → explicit conflict

```text
if receivedOnline === true
and receivedTs <= storedTs
```

- Resolution is **ambiguous**
- `onconflict(received, stored)` is invoked
- The returned `LIWRegister` is passed to `onresolved`

If `onconflict` is missing → runtime error.

---

### 2. Offline + non-newer timestamp → clearly stale

```text
if receivedOnline === false
and receivedTs <= storedTs
```

- Received intent is treated as stale
- Stored register is kept
- `onresolved(stored)` is called
- No conflict handler is invoked

---

### 3. Default → accept received

All other cases:

- Received intent is accepted
- `onresolved(received)` is called

This includes:

- newer timestamps
- offline → online transitions
- uncertain but forward-moving state

---

## Core Philosophy

> **Assume the received value represents the newest user intent —
> unless available UX signals make that unsafe.**

The system is optimistic by default, but **never silently destructive**.

---

## Conflict Semantics

Conflict resolution is:

- Explicit
- Mandatory
- Application-defined

LIW **never guesses** merge behavior.

The UI owns reconciliation.

---

## Properties

This LIW model:

- operates strictly at the UI layer
- uses wall-clock time as a heuristic
- uses online/offline state as a UX signal
- avoids silent intent loss
- tolerates long offline periods
- makes ambiguity visible
- preserves user trust

---

## Limitations (Intentional)

- No correctness guarantees
- No total ordering
- No convergence proofs
- Not suitable for backend replication

These constraints are **by design**, not omissions.

---

## Conclusion

`LIWRegister` is not a CRDT, not a database primitive, and not a consensus tool.

It exists to answer exactly one question:

> **“What is the least harmful thing to do for the user right now?”**

Anything stronger requires different abstractions.
