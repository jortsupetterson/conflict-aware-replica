// src/Text/class.js
const ROOT = { writerIdentifier: "\u0000", sequenceNumber: 0 };

function operationIdentifierToKey(operationIdentifier) {
  return `${operationIdentifier.writerIdentifier}:${operationIdentifier.sequenceNumber}`;
}

function compareOperationIdentifier(left, right) {
  if (left.writerIdentifier < right.writerIdentifier) return -1;
  if (left.writerIdentifier > right.writerIdentifier) return 1;
  return left.sequenceNumber - right.sequenceNumber;
}

export class Text {
  constructor(snapshot = undefined) {
    this.entries = new Map();
    this.order = new Map();
    this.tombstones = new Set();
    this.applied = new Set();
    this.pending = new Map();
    this.acks = new Map();

    const rootKey = operationIdentifierToKey(ROOT);
    this.entries.set(rootKey, { previousOperation: rootKey, character: "" });
    this.order.set(rootKey, []);
    this.applied.add(rootKey);

    if (snapshot) this.#loadSnapshot(snapshot);
  }

  merge(contender) {
    const contenderSnapshot = contender?.snapshot
      ? contender.snapshot()
      : contender;
    if (!contenderSnapshot) return;
    this.#loadSnapshot(contenderSnapshot);
  }

  snapshot() {
    const entries = {};
    for (const [operationKey, entry] of this.entries)
      entries[operationKey] = entry;

    const order = {};
    for (const [operationKey, list] of this.order)
      order[operationKey] = list.slice();

    const tombstones = Array.from(this.tombstones.values());

    const acks = {};
    for (const [writerIdentifier, ack] of this.acks) {
      acks[writerIdentifier] = {
        position: ack.position,
        operation: ack.operation,
      };
    }

    return {
      rootOperation: ROOT,
      headOperation: ROOT,
      entries,
      order,
      tombstones,
      acks,
    };
  }

  insert(operation) {
    const operationKey = operationIdentifierToKey(
      operation.operationIdentifier
    );
    if (this.applied.has(operationKey)) return;

    const previousOperationKey =
      operation.previousOperationKey ?? operationIdentifierToKey(ROOT);

    if (!this.entries.has(previousOperationKey)) {
      const waiting = this.pending.get(previousOperationKey) ?? [];
      waiting.push(operation);
      this.pending.set(previousOperationKey, waiting);
      this.applied.add(operationKey);
      return;
    }

    this.#applyInsert(operation);
    this.applied.add(operationKey);
    this.#drain(operationKey);
  }

  delete(operation) {
    const operationKey = operationIdentifierToKey(
      operation.operationIdentifier
    );
    if (this.applied.has(operationKey)) return;
    this.tombstones.add(operation.targetOperationKey);
    this.applied.add(operationKey);
  }

  ack(operation) {
    const operationKey = operationIdentifierToKey(
      operation.operationIdentifier
    );
    if (this.applied.has(operationKey)) return;

    const positionKey =
      operation.positionOperationKey ?? operationIdentifierToKey(ROOT);
    if (!this.entries.has(positionKey)) {
      this.applied.add(operationKey);
      return;
    }

    this.acks.set(operation.writerIdentifier, {
      position: parseOperationKey(positionKey),
      operation: operation.operationIdentifier,
    });
    this.applied.add(operationKey);
  }

  #applyInsert(operation) {
    const operationKey = operationIdentifierToKey(
      operation.operationIdentifier
    );
    if (this.entries.has(operationKey)) return;

    const previousOperationKey =
      operation.previousOperationKey ?? operationIdentifierToKey(ROOT);

    this.entries.set(operationKey, {
      previousOperation: previousOperationKey,
      character: operation.character,
    });

    const siblings = this.order.get(previousOperationKey) ?? [];
    siblings.push(operationKey);
    siblings.sort((leftKey, rightKey) =>
      compareOperationIdentifier(
        parseOperationKey(leftKey),
        parseOperationKey(rightKey)
      )
    );
    this.order.set(previousOperationKey, siblings);

    if (!this.order.has(operationKey)) this.order.set(operationKey, []);
  }

  #drain(previousOperationKey) {
    const waiting = this.pending.get(previousOperationKey);
    if (!waiting) return;
    this.pending.delete(previousOperationKey);

    for (const operation of waiting) {
      this.#applyInsert(operation);
      this.#drain(operationIdentifierToKey(operation.operationIdentifier));
    }
  }

  #loadSnapshot(snapshot) {
    for (const operationKey of Object.keys(snapshot.entries ?? {})) {
      if (!this.entries.has(operationKey))
        this.entries.set(operationKey, snapshot.entries[operationKey]);
    }

    for (const operationKey of Object.keys(snapshot.order ?? {})) {
      if (!this.order.has(operationKey)) this.order.set(operationKey, []);
      const list = this.order.get(operationKey);
      for (const childKey of snapshot.order[operationKey] ?? []) {
        if (!list.includes(childKey)) list.push(childKey);
      }
      list.sort((leftKey, rightKey) =>
        compareOperationIdentifier(
          parseOperationKey(leftKey),
          parseOperationKey(rightKey)
        )
      );
    }

    for (const tombstoneKey of snapshot.tombstones ?? [])
      this.tombstones.add(tombstoneKey);

    for (const writerIdentifier of Object.keys(snapshot.acks ?? {})) {
      const ack = snapshot.acks[writerIdentifier];
      this.acks.set(writerIdentifier, ack);
    }
  }
}

function parseOperationKey(operationKey) {
  const [writerIdentifier, sequenceNumberString] = operationKey.split(":");
  return { writerIdentifier, sequenceNumber: Number(sequenceNumberString) };
}
