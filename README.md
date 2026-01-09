# Dacument

Dacument is a schema-driven CRDT document that signs every operation and
enforces role-based ACLs at merge time. Local writes emit signed ops; state
advances only when ops are merged. It gives you a JS object-like API for
register fields and safe CRDT views for all other field types.

## Install

```sh
npm install dacument
```

## Quick start

```ts
import { Dacument } from "dacument";

const schema = Dacument.schema({
  title: Dacument.register({ jsType: "string", regex: /^[a-z ]+$/i }),
  body: Dacument.text(),
  items: Dacument.array({ jsType: "string" }),
  tags: Dacument.set({ jsType: "string" }),
  meta: Dacument.record({ jsType: "string" }),
});

const ownerId = "user-123"; // your app's authenticated user id
const { docId, snapshot, roleKeys } = await Dacument.create({ schema, ownerId });

const doc = await Dacument.load({
  schema,
  actorId: ownerId,
  roleKey: roleKeys.owner.privateKey,
  snapshot,
});

doc.title = "Hello world";
doc.body.insertAt(0, "H");
doc.tags.add("draft");
doc.items.push("milk");

doc.addEventListener("change", (event) => channel.send(event.ops));
channel.onmessage = (ops) => doc.merge(ops);

doc.addEventListener("merge", ({ actor, target, method, data }) => {
  // Update UI from a single merge stream.
});
```

`create()` returns `roleKeys` for owner/manager/editor; store them securely and
distribute the highest role key per actor as needed.

## Schema and fields

- `register` fields behave like normal properties: `doc.title = "hi"`.
- Other fields return safe CRDT views: `doc.items.push("x")`.
- Unknown fields and schema bypasses throw.
- UI updates should listen to `merge` events.

Supported CRDT field types:

- `register` - last writer wins register.
- `text` - text RGA.
- `array` - array RGA.
- `set` - OR-Set.
- `map` - OR-Map.
- `record` - OR-Record.

Map keys must be JSON-compatible values (`string`, `number`, `boolean`, `null`, arrays, or objects). For string-keyed data, prefer `record`.

## Roles and ACL

Roles are evaluated at the op stamp time (HLC).

- Owner: full control (including ownership transfer).
- Manager: can grant editor/viewer/revoked roles.
- Editor: can write non-ACL fields.
- Viewer: read-only.
- Revoked: reads are masked to initial values; writes are rejected.

Grant roles via `doc.acl` (viewer/revoked have no key):

```ts
const bobId = "user-bob";
doc.acl.setRole(bobId, "editor");
doc.acl.setRole("user-viewer", "viewer");
await doc.flush();
```

Each actor signs with the role key they were given (owner/manager/editor). Load
with the highest role key you have; viewers load without a key.
Role keys are generated once at `create()`; public keys are embedded in the
snapshot and never rotated.

## Networking and sync

Use `change` events to relay signed ops, and `merge` to apply them:

```ts
doc.addEventListener("change", (event) => send(event.ops));

// on remote
await peer.merge(ops);
```

Local writes do not update state until merged. If you want a single UI update
path, broadcast ops (even back to yourself) and drive UI from `merge` events.

`merge` events mirror the confirmed operation parameters (e.g. `insertAt`,
`deleteAt`, `push`, `pop`, `set`, `add`) so UIs can apply minimal updates
without snapshotting.

To add a new replica, share a snapshot and load it:

```ts
const bob = await Dacument.load({
  schema,
  actorId: bobId,
  roleKey: bobKey.privateKey,
  snapshot,
});
```

Snapshots do not include schema or schema ids; callers must supply the schema on load.

## Events and values

- `doc.addEventListener("change", handler)` emits signed ops for network sync.
- `doc.addEventListener("merge", handler)` emits `{ actor, target, method, data }`.
- `doc.addEventListener("error", handler)` emits signing/verification errors.
- `doc.addEventListener("revoked", handler)` fires when the current actor is revoked.
- `await doc.flush()` waits for pending signatures so all local ops are emitted.
- `doc.snapshot()` returns a loadable op log (`{ docId, roleKeys, ops }`).
- Revoked actors cannot snapshot; reads are masked to initial values.

## Guarantees

- Schema enforcement is strict; unknown fields are rejected.
- Ops are accepted only if the CRDT patch is valid and the signature verifies.
- Role checks are applied at the op stamp time (HLC).
- IDs are base64url nonces from `bytecodec.generateNonce()` (32 random bytes).
- Private keys are returned by `create()` and never stored by Dacument.

Eventual consistency is achieved when all signed ops are delivered to all
replicas. Dacument does not provide transport; use `change` events to wire it up.

## Compatibility

- ESM only (`type: module`).
- Requires WebCrypto (`node >= 18` or modern browsers).

## Scripts

- `npm test` runs the test suite (build included).
- `npm run bench` runs all CRDT micro-benchmarks (build included).
- `npm run sim:dacument` runs a worker-thread stress simulation.
- `npm run verify` runs tests, benchmarks, and the simulation in one go.

## Advanced exports

`CRArray`, `CRMap`, `CRRecord`, `CRRegister`, `CRSet`, and `CRText` are exported
from the package for building custom CRDT workflows.
