import { DAGNode } from "../DAGNode/class.js";

const ROOT: readonly string[] = [];

function afterKey(after: readonly string[]): string {
  return after.length < 2 ? (after[0] ?? "") : after.join(",");
}

export class CRText<CharT extends string = string> {
  private readonly nodes: DAGNode<CharT>[] = [];
  private readonly nodeById = new Map<string, DAGNode<CharT>>();
  private aliveCount = 0;
  private lastAliveIndex = -1;
  private readonly listeners = new Set<
    (nodes: readonly DAGNode<CharT>[]) => void
  >();

  constructor(snapshot?: readonly DAGNode<CharT>[]) {
    if (snapshot) {
      for (const node of snapshot) {
        if (this.nodeById.has(node.id)) continue;
        this.nodes.push(node);
        this.nodeById.set(node.id, node);
        if (!node.deleted) this.aliveCount++;
      }
    }
    this.sort();
  }

  get length(): number {
    return this.aliveCount;
  }

  // --- public API ---
  onChange(listener: (nodes: readonly DAGNode<CharT>[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DAGNode<CharT>[] {
    return this.nodes.slice();
  }

  toString(): string {
    let output = "";
    for (const node of this.nodes)
      if (!node.deleted) output += String(node.value);
    return output;
  }

  at(index: number): CharT | undefined {
    let target = Math.trunc(Number(index));
    if (Number.isNaN(target)) target = 0;
    if (target < 0) target = this.length + target;
    if (target < 0) return undefined;
    let aliveIndex = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (aliveIndex === target) return node.value;
      aliveIndex++;
    }
    return undefined;
  }

  insertAt(index: number, char: CharT): this {
    if (!Number.isInteger(index))
      throw new TypeError("CRText.insertAt: index must be an integer");
    if (index < 0)
      throw new RangeError("CRText.insertAt: negative index not supported");
    const length = this.aliveCount;
    if (index > length)
      throw new RangeError("CRText.insertAt: index out of bounds");

    const lastAliveId = this.lastAliveId();
    const after =
      index === length
        ? lastAliveId
          ? ([lastAliveId] as const)
          : ROOT
        : this.afterIdForAliveInsertAt(index);
    const node = new DAGNode<CharT>({ value: char, after });
    this.nodes.push(node);
    this.nodeById.set(node.id, node);
    this.aliveCount++;
    this.sort();
    this.emit([node]);
    return this;
  }

  deleteAt(index: number): CharT | undefined {
    if (!Number.isInteger(index))
      throw new TypeError("CRText.deleteAt: index must be an integer");
    if (index < 0)
      throw new RangeError("CRText.deleteAt: negative index not supported");

    let aliveIndex = 0;
    for (let idx = 0; idx < this.nodes.length; idx++) {
      const node = this.nodes[idx];
      if (node.deleted) continue;
      if (aliveIndex === index) {
        node.deleted = true;
        this.aliveCount--;
        if (this.aliveCount === 0) {
          this.lastAliveIndex = -1;
        } else if (idx === this.lastAliveIndex) {
          this.lastAliveIndex = idx - 1;
          while (
            this.lastAliveIndex >= 0 &&
            this.nodes[this.lastAliveIndex].deleted
          ) {
            this.lastAliveIndex--;
          }
        }
        this.emit([node]);
        return node.value;
      }
      aliveIndex++;
    }
    return undefined;
  }

  merge(remoteSnapshot: DAGNode<CharT>[] | DAGNode<CharT>): DAGNode<CharT>[] {
    const snapshot = Array.isArray(remoteSnapshot)
      ? remoteSnapshot
      : [remoteSnapshot];

    const changed: DAGNode<CharT>[] = [];
    for (const remote of snapshot) {
      const local = this.nodeById.get(remote.id);
      if (!local) {
        const clone = structuredClone(remote) as DAGNode<CharT>;
        this.nodes.push(clone);
        this.nodeById.set(clone.id, clone);
        if (!clone.deleted) this.aliveCount++;
        changed.push(clone);
      } else if (!local.deleted && remote.deleted) {
        local.deleted = true;
        this.aliveCount--;
        changed.push(local);
      }
    }

    if (changed.length) {
      this.sort();
      this.emit(changed);
    }
    return changed;
  }

  sort(compareFn?: (a: DAGNode<CharT>, b: DAGNode<CharT>) => number): this {
    if (compareFn) {
      this.nodes.sort(compareFn);
      this.recomputeLastAliveIndex();
      return this;
    }

    this.nodes.sort((left, right) => {
      const leftIsRoot = left.after.length === 0;
      const rightIsRoot = right.after.length === 0;
      if (leftIsRoot !== rightIsRoot) return leftIsRoot ? -1 : 1;

      const leftAfterKey = afterKey(left.after);
      const rightAfterKey = afterKey(right.after);
      if (leftAfterKey !== rightAfterKey)
        return leftAfterKey < rightAfterKey ? -1 : 1;

      if (left.id === right.id) return 0;
      if (leftIsRoot) return left.id > right.id ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });

    this.recomputeLastAliveIndex();
    return this;
  }

  // --- internals ---
  private afterIdForAliveInsertAt(index: number): readonly string[] {
    if (index === 0) return ROOT;

    let aliveIndex = 0;
    let previousAliveId: string | null = null;

    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (aliveIndex === index) break;
      previousAliveId = node.id;
      aliveIndex++;
    }

    if (previousAliveId) return [previousAliveId] as const;
    return ROOT;
  }

  private lastAliveId(): string | null {
    if (this.lastAliveIndex < 0) return null;
    const node = this.nodes[this.lastAliveIndex];
    if (!node || node.deleted) {
      this.recomputeLastAliveIndex();
      if (this.lastAliveIndex < 0) return null;
      return this.nodes[this.lastAliveIndex].id;
    }
    return node.id;
  }

  private recomputeLastAliveIndex(): void {
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      if (!this.nodes[index].deleted) {
        this.lastAliveIndex = index;
        return;
      }
    }
    this.lastAliveIndex = -1;
  }

  private emit(nodes: readonly DAGNode<CharT>[]): void {
    if (nodes.length === 0) return;
    for (const listener of this.listeners) listener(nodes);
  }
}
