// collectGarbage/index.js

const ROOT_KEY = "\u0000:0";

function parseOperationKey(operationKey) {
  const [writerIdentifier, sequenceNumberString] = operationKey.split(":");
  return { writerIdentifier, sequenceNumber: Number(sequenceNumberString) };
}

function compareOperationIdentifier(left, right) {
  if (left.writerIdentifier < right.writerIdentifier) return -1;
  if (left.writerIdentifier > right.writerIdentifier) return 1;
  return left.sequenceNumber - right.sequenceNumber;
}

function operationIdentifierToKey(operationIdentifier) {
  return `${operationIdentifier.writerIdentifier}:${operationIdentifier.sequenceNumber}`;
}

function walkOrder(text) {
  const result = [];
  const stack = [...(text.order.get(ROOT_KEY) ?? [])].reverse();

  while (stack.length) {
    const currentKey = stack.pop();
    result.push(currentKey);

    const childrenList = text.order.get(currentKey) ?? [];
    for (let index = childrenList.length - 1; index >= 0; index -= 1) {
      stack.push(childrenList[index]);
    }
  }

  return result;
}

function rebuildOrderFromEntries(entriesMap) {
  const orderMap = new Map();
  orderMap.set(ROOT_KEY, []);

  for (const [operationKey] of entriesMap) {
    if (!orderMap.has(operationKey)) orderMap.set(operationKey, []);
  }

  for (const [operationKey, entry] of entriesMap) {
    if (operationKey === ROOT_KEY) continue;
    const parentKey = entry.previousOperation ?? ROOT_KEY;
    if (!orderMap.has(parentKey)) orderMap.set(parentKey, []);
    orderMap.get(parentKey).push(operationKey);
  }

  for (const [parentKey, childrenList] of orderMap) {
    childrenList.sort((leftKey, rightKey) =>
      compareOperationIdentifier(
        parseOperationKey(leftKey),
        parseOperationKey(rightKey)
      )
    );
    orderMap.set(parentKey, childrenList);
  }

  return orderMap;
}

export function collectGarbage(writers, text) {
  const epochWriterIdentifiers = writers.liveWriterIdentifiers();
  if (epochWriterIdentifiers.length === 0) return;

  const requiredPositions = [];
  for (const writerIdentifier of epochWriterIdentifiers) {
    const ack = text.acks.get(writerIdentifier);
    if (!ack) return;
    requiredPositions.push(ack.position);
  }

  let cutPosition = requiredPositions[0];
  for (let index = 1; index < requiredPositions.length; index += 1) {
    const position = requiredPositions[index];
    if (compareOperationIdentifier(position, cutPosition) < 0)
      cutPosition = position;
  }

  const cutKey = operationIdentifierToKey(cutPosition);

  const linearOrder = walkOrder(text);
  const cutIndex = linearOrder.indexOf(cutKey);
  if (cutIndex <= 0) return;

  const removableKeys = new Set(linearOrder.slice(0, cutIndex));

  const keptEntries = new Map();
  keptEntries.set(ROOT_KEY, text.entries.get(ROOT_KEY));

  for (const operationKey of linearOrder.slice(cutIndex)) {
    const entry = text.entries.get(operationKey);
    if (entry) keptEntries.set(operationKey, entry);
  }

  for (const [operationKey, entry] of keptEntries) {
    if (operationKey === ROOT_KEY) continue;

    let parentKey = entry.previousOperation ?? ROOT_KEY;

    while (parentKey !== ROOT_KEY && removableKeys.has(parentKey)) {
      const parentEntry = text.entries.get(parentKey);
      if (!parentEntry) {
        parentKey = ROOT_KEY;
        break;
      }
      parentKey = parentEntry.previousOperation ?? ROOT_KEY;
    }

    if (parentKey !== entry.previousOperation) {
      keptEntries.set(operationKey, {
        previousOperation: parentKey,
        character: entry.character,
      });
    }
  }

  const keptTombstones = new Set();
  for (const tombstoneKey of text.tombstones) {
    if (keptEntries.has(tombstoneKey)) keptTombstones.add(tombstoneKey);
  }

  text.entries = keptEntries;
  text.tombstones = keptTombstones;
  text.order = rebuildOrderFromEntries(keptEntries);
}
