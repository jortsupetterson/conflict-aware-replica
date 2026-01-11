# TypeScript Code Review Follow-Up

This document records decisions taken after reviewing "TypeScript Code Review for the dacument Repository.pdf".

## Implemented

- Make `Dacument.computeSchemaId` private. It is an internal derivation from schema and does not need to be part of the public API.
- Enable `noImplicitReturns` in `tsconfig.json` to catch accidental missing return values in internal helpers.
- Align record mutation helper returns so no-op updates still return the underlying result.

## Deferred or Declined (With Rationale)

- **Typed field state per schema (generic FieldState)**
  - Rationale: This is a large refactor with wide internal surface area. It would likely ripple into public types and increase API complexity.
  - Risk: Medium-to-high API impact for TypeScript users; difficult to guarantee no breakage.

- **Stronger generics for map/set key functions**
  - Rationale: Would change schema type signatures and could require end-user updates or new type annotations.
  - Risk: Public API type changes.

- **Index signature for CRRecord**
  - Rationale: It improves typing but risks conflicts with existing properties and methods. Also can mask mistakes by making everything indexable.
  - Risk: Potentially confusing type behavior for consumers.

- **Array-like index signatures for CRArray/CRText proxies**
  - Rationale: This would be a public typing change and could imply stronger guarantees than the CRDT can provide.
  - Risk: Public API type change for consumers.

- **Return types for view mutators (e.g., `add`, `insertAt`)**
  - Rationale: Changing these from `unknown` to `void` (or to fluent returns) is a public API change for TypeScript users who might rely on the return type.
  - Risk: API change; should be bundled into a major version if done.

- **Event listener map typing refactor**
  - Rationale: Type-safety improvement only; no runtime benefit. Worth doing, but not required for correctness.
  - Risk: Low, but still internal refactor work for limited gain.

- **Proxy privacy via `#private` fields/methods**
  - Rationale: Proxies and `#private` don't mix cleanly in this codebase; moving to true runtime-privacy risks breaking proxy behavior or requiring redesign.
  - Risk: Runtime behavior changes and migration effort.

- **Splitting `Dacument` into multiple modules**
  - Rationale: Improves maintainability but does not improve runtime correctness. The file is large but stable; refactor would be invasive.
  - Risk: High chance of introducing regressions without clear product value.

- **Tighter compiler flags (`noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`)**
  - Rationale: These are useful, but can be noisy and may force non-trivial churn. We started with `noImplicitReturns` as a targeted improvement.
  - Risk: Low runtime risk, but potentially high maintenance cost.

- **Type-checking dependencies (`skipLibCheck: false`)**
  - Rationale: Adds noise and slows builds; useful in CI but not required for core correctness.
  - Risk: Build friction rather than API impact.

- **Type definition testing (`tsd`)**
  - Rationale: Valuable, but a separate workflow change. Can be added later if we decide to enforce public type guarantees more strictly.
  - Risk: Process overhead; no direct runtime benefit.

## Revisit Triggers

Consider revisiting the deferred items if:
- A major version is planned and public type changes are acceptable.
- A contributor needs stronger internal typing to add features safely.
- A new runtime issue is traced to current type erasure or proxy exposure.
