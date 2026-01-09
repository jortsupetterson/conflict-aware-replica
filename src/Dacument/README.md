# Dacument

Dacument is a schema-driven, access-controlled CRDT document that signs every
operation and enforces ACL rules at merge time. It exposes a JS object-like API
for register fields and CRDT views for all other field types.

## Schema

```ts
import { Dacument } from "dacument";

const schema = Dacument.schema({
  title: Dacument.register({ jsType: "string", regex: /^[a-z ]+$/i }),
  body: Dacument.text(),
  items: Dacument.array({ jsType: "string" }),
  tags: Dacument.set({ jsType: "string" }),
  meta: Dacument.record({ jsType: "string" }),
});
```

## Create and load

```ts
const ownerId = "user-123"; // your app's authenticated user id
const { docId, snapshot, roleKeys } = await Dacument.create({ schema, ownerId });

const doc = await Dacument.load({
  schema,
  actorId: ownerId,
  roleKey: roleKeys.owner.privateKey,
  snapshot,
});
```

`create()` generates a `docId` and role keys, and returns a snapshot. Load the
document with the highest role key you have (viewers load without a key).
Snapshots do not include schema or schema ids; the caller must provide the schema.

`roleKeys` includes owner/manager/editor key pairs; store and distribute them
as needed.

## ACL

```ts
const bobId = "user-bob";
doc.acl.setRole(bobId, "editor");
doc.acl.setRole("user-viewer", "viewer");
await doc.flush();
```

Revoked actors read initial values instead of the live document state.
Revoked actors cannot call `snapshot()`.
`merge` events report minimal operation params like `insertAt`, `deleteAt`,
`push`, `pop`, `set`, and `add`.

## Events

- `doc.addEventListener("change", handler)` emits signed ops for network sync.
- `doc.addEventListener("merge", handler)` emits `{ actor, target, method, data }`.
- `doc.addEventListener("error", handler)` emits signing/verification errors.
- `doc.addEventListener("revoked", handler)` fires when the current actor is revoked.
- `doc.snapshot()` returns a loadable op log (`{ docId, roleKeys, ops }`).

Map keys must be JSON-compatible values. For string-keyed data, prefer `record`.

See `README.md` for full usage and guarantees.
