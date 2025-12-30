// src/Writers/class.js
export class Writers {
  constructor(snapshot = undefined) {
    this.entries = new Map();
    if (snapshot?.entries) {
      for (const writerIdentifier of Object.keys(snapshot.entries)) {
        const entry = snapshot.entries[writerIdentifier];
        this.entries.set(writerIdentifier, {
          addOperation: entry.addOperation,
          removeOperation: entry.removeOperation ?? null,
        });
      }
    }
  }

  merge(contender) {
    const contenderEntries =
      contender?.entries instanceof Map ? contender.entries : new Map();
    for (const [writerIdentifier, contenderEntry] of contenderEntries) {
      const currentEntry = this.entries.get(writerIdentifier);
      if (!currentEntry) {
        this.entries.set(writerIdentifier, contenderEntry);
        continue;
      }
      const chosenAdd =
        compareOperationIdentifier(
          currentEntry.addOperation,
          contenderEntry.addOperation
        ) >= 0
          ? currentEntry.addOperation
          : contenderEntry.addOperation;

      const currentRemove = currentEntry.removeOperation ?? null;
      const contenderRemove = contenderEntry.removeOperation ?? null;

      const chosenRemove =
        currentRemove && contenderRemove
          ? compareOperationIdentifier(currentRemove, contenderRemove) >= 0
            ? currentRemove
            : contenderRemove
          : currentRemove ?? contenderRemove;

      this.entries.set(writerIdentifier, {
        addOperation: chosenAdd,
        removeOperation: chosenRemove,
      });
    }
  }

  snapshot() {
    const entries = {};
    for (const [writerIdentifier, entry] of this.entries) {
      entries[writerIdentifier] = {
        addOperation: entry.addOperation,
        removeOperation: entry.removeOperation,
      };
    }
    const order = Array.from(this.entries.keys()).sort();
    return { entries, order };
  }

  liveWriterIdentifiers() {
    const live = [];
    for (const [writerIdentifier, entry] of this.entries) {
      if (entry.removeOperation == null) live.push(writerIdentifier);
    }
    live.sort();
    return live;
  }
}

function compareOperationIdentifier(left, right) {
  if (left.writerIdentifier < right.writerIdentifier) return -1;
  if (left.writerIdentifier > right.writerIdentifier) return 1;
  return left.sequenceNumber - right.sequenceNumber;
}
