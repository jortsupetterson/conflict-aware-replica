import assert from "node:assert/strict";
import test from "node:test";
import { Bytes } from "bytecodec";
import { Dacument } from "../dist/index.js";

const schema = Dacument.schema({
  title: Dacument.register({ jsType: "string", regex: /^[a-z ]+$/ }),
  body: Dacument.text(),
  items: Dacument.array({ jsType: "string" }),
  tags: Dacument.set({ jsType: "string" }),
  meta: Dacument.record({ jsType: "string" }),
});

async function createOwnerDoc() {
  const ownerId = Dacument.generateId();
  const { snapshot, roleKeys } = await Dacument.create({ schema, ownerId });
  const doc = await Dacument.load({
    schema,
    actorId: ownerId,
    roleKey: roleKeys.owner.privateKey,
    snapshot,
  });
  return { doc, snapshot, roleKeys, ownerId };
}

test("create enforces schema and register behavior", async () => {
  const { doc } = await createOwnerDoc();
  const ops = [];
  doc.addEventListener("change", (event) => ops.push(...event.ops));

  doc.title = "hello";
  await doc.flush();
  await doc.merge(ops);
  ops.length = 0;
  assert.equal(doc.title, "hello");

  assert.throws(() => {
    doc.title = "Hello";
  }, /regex/i);

  assert.throws(() => {
    doc.items = ["x"];
  }, /read-only/i);

  assert.throws(() => {
    doc.unknown = "x";
  }, /unknown field/i);
});

test("local ops sign and merge across replicas", async () => {
  const { doc } = await createOwnerDoc();
  const ops = [];
  doc.addEventListener("change", (event) => ops.push(...event.ops));

  const peerId = Dacument.generateId();
  doc.acl.setRole(peerId, "viewer");
  await doc.flush();
  await doc.merge(ops);
  ops.length = 0;

  const snapshot = doc.snapshot();
  doc.title = "alpha";
  doc.body.insertAt(0, "h");
  doc.items.push("milk");
  doc.tags.add("x");
  doc.meta.note = "ok";
  await doc.flush();

  const peer = await Dacument.load({
    schema,
    actorId: peerId,
    snapshot,
  });

  const result = await peer.merge(ops);
  assert.equal(result.rejected, 0);
  assert.equal(peer.title, "alpha");
  assert.equal(peer.body.toString(), "h");
  assert.deepEqual([...peer.items], ["milk"]);
  assert.equal(peer.tags.has("x"), true);
  assert.equal(peer.meta.note, "ok");
});

test("acl roles gate writes by stamp", async () => {
  const { doc, roleKeys } = await createOwnerDoc();
  const ownerOps = [];
  doc.addEventListener("change", (event) => ownerOps.push(...event.ops));

  const bobId = Dacument.generateId();
  const replicaId = Dacument.generateId();
  doc.acl.setRole(bobId, "editor");
  doc.acl.setRole(replicaId, "viewer");
  await doc.flush();
  await doc.merge(ownerOps);
  ownerOps.length = 0;

  const bob = await Dacument.load({
    schema,
    actorId: bobId,
    roleKey: roleKeys.editor.privateKey,
    snapshot: doc.snapshot(),
  });

  const bobOps = [];
  bob.addEventListener("change", (event) => bobOps.push(...event.ops));

  bob.title = "bob";
  await bob.flush();

  await new Promise((resolve) => setTimeout(resolve, 5));
  doc.acl.setRole(bobId, "revoked");
  await doc.flush();
  await doc.merge(ownerOps);
  ownerOps.length = 0;

  const replica = await Dacument.load({
    schema,
    actorId: replicaId,
    snapshot: doc.snapshot(),
  });

  const acceptedFirst = await replica.merge([bobOps[0]]);
  assert.equal(acceptedFirst.accepted.length, 1);
  assert.equal(replica.title, "bob");

  await new Promise((resolve) => setTimeout(resolve, 5));
  bob.title = "bob again";
  await bob.flush();

  const acceptedSecond = await replica.merge([bobOps[1]]);
  assert.equal(acceptedSecond.accepted.length, 0);
});

test("revoked reads return initial values", async () => {
  const { doc, roleKeys } = await createOwnerDoc();
  const ownerOps = [];
  doc.addEventListener("change", (event) => ownerOps.push(...event.ops));

  const editorId = Dacument.generateId();
  doc.acl.setRole(editorId, "editor");
  await doc.flush();
  await doc.merge(ownerOps);
  ownerOps.length = 0;

  const editor = await Dacument.load({
    schema,
    actorId: editorId,
    roleKey: roleKeys.editor.privateKey,
    snapshot: doc.snapshot(),
  });

  doc.title = "alpha";
  doc.body.insertAt(0, "h");
  doc.items.push("milk");
  doc.tags.add("x");
  doc.meta.note = "ok";
  await doc.flush();

  const changeOps = ownerOps.slice();
  ownerOps.length = 0;
  await doc.merge(changeOps);
  await editor.merge(changeOps);

  assert.equal(editor.title, "alpha");
  assert.equal(editor.body.toString(), "h");

  doc.acl.setRole(editorId, "revoked");
  await doc.flush();

  const revokeOps = ownerOps.slice();
  ownerOps.length = 0;
  await doc.merge(revokeOps);
  await editor.merge(revokeOps);

  assert.equal(editor.title, null);
  assert.equal(editor.body.toString(), "");
  assert.deepEqual([...editor.items], []);
  assert.equal(editor.tags.has("x"), false);
  assert.equal(editor.meta.note, undefined);
  assert.throws(() => {
    editor.snapshot();
  }, /revoked/i);
});

test("managers cannot grant manager role", async () => {
  const { doc, roleKeys } = await createOwnerDoc();
  const ownerOps = [];
  doc.addEventListener("change", (event) => ownerOps.push(...event.ops));

  const managerId = Dacument.generateId();
  doc.acl.setRole(managerId, "manager");
  await doc.flush();
  await doc.merge(ownerOps);
  ownerOps.length = 0;

  const manager = await Dacument.load({
    schema,
    actorId: managerId,
    roleKey: roleKeys.manager.privateKey,
    snapshot: doc.snapshot(),
  });

  assert.throws(() => {
    manager.acl.setRole(Dacument.generateId(), "manager");
  }, /cannot grant/i);
});

test("invalid signature is rejected", async () => {
  const { doc, snapshot } = await createOwnerDoc();
  const ops = [];
  doc.addEventListener("change", (event) => ops.push(...event.ops));
  doc.title = "alpha";
  await doc.flush();

  const [header, payload, signature] = ops[0].token.split(".");
  const tamperedPayload =
    payload.slice(0, -1) + (payload.slice(-1) === "a" ? "b" : "a");
  const tampered = { token: [header, tamperedPayload, signature].join(".") };
  const peer = await Dacument.load({
    schema,
    actorId: Dacument.generateId(),
    snapshot,
  });

  const result = await peer.merge([tampered]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected, 1);
});

test("id generation is 256-bit base64url", async () => {
  const id = Dacument.generateId();
  assert.equal(typeof id, "string");
  assert.equal(id.length, 43);
  assert.equal(Bytes.fromBase64UrlString(id).byteLength, 32);
});
