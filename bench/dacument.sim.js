import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { Dacument } from "../dist/index.js";

const schema = Dacument.schema({
  title: Dacument.register({ jsType: "string", regex: /^[a-z0-9 .-]+$/i }),
  body: Dacument.text(),
  items: Dacument.array({ jsType: "string" }),
  tags: Dacument.set({ jsType: "string" }),
  meta: Dacument.record({ jsType: "string" }),
});

const STEPS = 80;
const DELAY_MIN = 5;
const DELAY_MAX = 40;
const SETTLE_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
}

if (isMainThread) {
  const ownerId = Dacument.generateId();
  const { snapshot: initialSnapshot, roleKeys } = await Dacument.create({
    schema,
    ownerId,
  });
  const doc = await Dacument.load({
    schema,
    actorId: ownerId,
    roleKey: roleKeys.owner.privateKey,
    snapshot: initialSnapshot,
  });

  const actors = [
    { id: Dacument.generateId(), bad: false },
    { id: Dacument.generateId(), bad: false },
    { id: Dacument.generateId(), bad: true },
  ];

  const ownerOps = [];
  doc.addEventListener("change", (event) => ownerOps.push(...event.ops));

  for (const actor of actors) doc.acl.setRole(actor.id, "editor");
  await doc.flush();
  await doc.merge(ownerOps);
  ownerOps.length = 0;

  const snapshot = doc.snapshot();
  const workers = new Map();
  const states = new Map();
  let doneCount = 0;
  let finalizeRequested = false;

  function relay(_fromId, ops) {
    for (const worker of workers.values()) {
      setTimeout(() => worker.postMessage({ type: "ops", ops }), randomDelay());
    }
  }

  function onMessage(id, msg) {
    if (msg.type === "ops") {
      doc.merge(msg.ops).then(() => relay(id, msg.ops));
      return;
    }
    if (msg.type === "state") {
      states.set(id, msg.state);
      if (finalizeRequested && states.size === workers.size) finalize();
      return;
    }
    if (msg.type === "done") {
      doneCount += 1;
      if (doneCount === workers.size) requestFinalize();
    }
  }

  async function requestFinalize() {
    if (finalizeRequested) return;
    finalizeRequested = true;
    await doc.flush();
    setTimeout(() => {
      for (const worker of workers.values())
        worker.postMessage({ type: "finalize" });
    }, SETTLE_MS);
  }

  function finalize() {
    for (const [id, state] of states.entries()) {
      if (state.bad) continue;
      assert.equal(state.title, doc.title);
      assert.equal(state.body, doc.body.toString());
      assert.deepEqual(state.items, [...doc.items]);
    }
    console.log("dacument.sim: OK", {
      actors: actors.length,
      acceptedOps: doc.snapshot().ops.length,
    });
    for (const worker of workers.values()) worker.terminate();
    setTimeout(() => process.exit(0), 50);
  }

  for (const actor of actors) {
    const worker = new Worker(new URL(import.meta.url), {
      type: "module",
      workerData: {
        schema,
        snapshot,
        actorId: actor.id,
        roleKey: roleKeys.editor.privateKey,
        bad: actor.bad,
      },
    });
    workers.set(actor.id, worker);
    worker.on("message", (msg) => onMessage(actor.id, msg));
    worker.on("error", (err) => console.error("worker error", err));
  }
} else {
  const { schema, snapshot, actorId, roleKey, bad } = workerData;
  const doc = await Dacument.load({ schema, actorId, roleKey, snapshot });

  doc.addEventListener("change", (event) => {
    const ops = event.ops;
    if (bad && Math.random() < 0.4) {
      const tampered = ops.map((op, index) => {
        if (index !== 0) return op;
        const token = op.token;
        const hacked =
          token.slice(0, -1) + (token.slice(-1) === "a" ? "b" : "a");
        return { token: hacked };
      });
      parentPort.postMessage({ type: "ops", ops: tampered });
      return;
    }
    parentPort.postMessage({ type: "ops", ops });
  });

  parentPort.on("message", async (msg) => {
    if (msg.type === "ops") {
      await doc.merge(msg.ops);
      return;
    }
    if (msg.type === "finalize") {
      await doc.flush();
      parentPort.postMessage({
        type: "state",
        state: {
          bad,
          title: doc.title,
          body: doc.body.toString(),
          items: [...doc.items],
        },
      });
    }
  });

  function randomWord() {
    return Math.random().toString(36).slice(2, 7);
  }

  async function run() {
    for (let i = 0; i < STEPS; i++) {
      const choice = i % 5;
      if (choice === 0) doc.title = `note ${randomWord()}`;
      if (choice === 1) doc.body.insertAt(doc.body.length, ".");
      if (choice === 2) doc.items.push(randomWord());
      if (choice === 3) doc.tags.add(randomWord());
      if (choice === 4) doc.meta[`k${i}`] = randomWord();
      if (bad && i % 7 === 0) {
        try {
          doc.acl.setRole(Dacument.generateId(), "manager");
        } catch {
          // ignore unauthorized attempts
        }
      }
      await sleep(randomDelay());
    }
    await doc.flush();
    parentPort.postMessage({ type: "done" });
  }

  run().catch((err) => {
    parentPort.postMessage({ type: "done", error: err.message });
  });
}
