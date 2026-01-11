import { DAGNode } from "../DAGNode/class.js";

const ROOT: readonly string[] = [];

function afterKey(after: readonly string[]): string {
  return after.length < 2 ? (after[0] ?? "") : after.join(",");
}

function isIndexKey(value: string): boolean {
  const length = value.length;
  if (length === 0) return false;
  const first = value.charCodeAt(0);
  if (first < 48 || first > 57) return false;
  if (length > 1 && first === 48) return false;
  for (let i = 1; i < length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export class CRArray<T> {
  private readonly nodes: DAGNode<T>[] = [];
  private readonly nodeById = new Map<string, DAGNode<T>>();
  private aliveCount = 0;
  private lastAliveIndex = -1;
  private readonly listeners = new Set<
    (nodes: readonly DAGNode<T>[]) => void
  >();

  constructor(snapshot?: readonly DAGNode<T>[]) {
    if (snapshot) {
      for (const node of snapshot) {
        if (this.nodeById.has(node.id)) continue;
        this.nodes.push(node);
        this.nodeById.set(node.id, node);
        if (!node.deleted) this.aliveCount++;
      }
    }
    this.sort();
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === "string") {
          if (property === "length") return target.length;
          if (isIndexKey(property))
            return target.at(Number(property));
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (typeof property === "string" && isIndexKey(property)) {
          const index = Number(property);
          target.setAt(index, value as T);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
      has: (target, property) => {
        if (typeof property === "string" && isIndexKey(property)) {
          return Number(property) < target.length;
        }
        return Reflect.has(target, property);
      },
      ownKeys: (target) => {
        const keys = Reflect.ownKeys(target);
        const aliveCount = target.length;
        for (let index = 0; index < aliveCount; index++)
          keys.push(String(index));
        return keys;
      },
      getOwnPropertyDescriptor: (target, property) => {
        if (typeof property === "string" && isIndexKey(property)) {
          if (Number(property) >= target.length) return undefined;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: target.at(Number(property)),
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }) as this;
  }

  get length(): number {
    return this.aliveCount;
  }

  // --- public API ---
  onChange(listener: (nodes: readonly DAGNode<T>[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DAGNode<T>[] {
    return this.nodes.slice();
  }

  push(...items: T[]): number {
    const lastAliveId = this.lastAliveId();
    let after = lastAliveId ? ([lastAliveId] as const) : ROOT;

    const changed: DAGNode<T>[] = [];
    for (const item of items) {
      const node = new DAGNode<T>({ value: item, after });
      this.nodes.push(node);
      this.nodeById.set(node.id, node);
      changed.push(node);
      after = [node.id] as const;
      this.aliveCount++;
    }

    this.sort();
    this.emit(changed);
    return this.length;
  }

  unshift(...items: T[]): number {
    let after: readonly string[] = ROOT;

    const changed: DAGNode<T>[] = [];
    for (const item of items) {
      const node = new DAGNode<T>({ value: item, after });
      this.nodes.push(node);
      this.nodeById.set(node.id, node);
      changed.push(node);
      after = [node.id] as const;
      this.aliveCount++;
    }

    this.sort();
    this.emit(changed);
    return this.length;
  }

  pop(): T | undefined {
    for (let index = this.lastAliveIndex; index >= 0; index--) {
      const node = this.nodes[index];
      if (node.deleted) continue;
      node.deleted = true;
      this.aliveCount--;
      this.lastAliveIndex = index - 1;
      while (
        this.lastAliveIndex >= 0 &&
        this.nodes[this.lastAliveIndex].deleted
      ) {
        this.lastAliveIndex--;
      }
      this.emit([node]);
      return node.value;
    }
    return undefined;
  }

  shift(): T | undefined {
    for (const node of this.nodes) {
      if (!node.deleted) {
        node.deleted = true;
        this.aliveCount--;
        if (this.aliveCount === 0) this.lastAliveIndex = -1;
        this.emit([node]);
        return node.value;
      }
    }
    return undefined;
  }

  at(index: number): T | undefined {
    const length = this.aliveCount;
    let target = Math.trunc(Number(index));
    if (Number.isNaN(target)) target = 0;
    if (target < 0) target = length + target;
    if (target < 0 || target >= length) return undefined;
    let aliveIndex = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (aliveIndex === target) return node.value;
      aliveIndex++;
    }
    return undefined;
  }

  setAt(index: number, value: T): this {
    if (!Number.isInteger(index))
      throw new TypeError("CRArray.setAt: index must be an integer");
    if (index < 0)
      throw new RangeError("CRArray.setAt: negative index not supported");

    let aliveIndex = 0;
    let deletedNode: DAGNode<T> | null = null;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (aliveIndex === index) {
        node.deleted = true;
        this.aliveCount--;
        deletedNode = node;
        break;
      }
      aliveIndex++;
    }

    if (index > aliveIndex)
      throw new RangeError("CRArray.setAt: index out of bounds");

    const after = this.afterIdForAliveInsertAt(index);
    const newNode = new DAGNode<T>({ value, after });
    this.nodes.push(newNode);
    this.nodeById.set(newNode.id, newNode);
    this.aliveCount++;
    this.sort();
    const changed = deletedNode ? [deletedNode, newNode] : [newNode];
    this.emit(changed);
    return this;
  }

  slice(start?: number, end?: number): T[] {
    const length = this.aliveCount;

    let from = start === undefined ? 0 : Math.trunc(Number(start));
    if (Number.isNaN(from)) from = 0;
    if (from < 0) from = Math.max(length + from, 0);
    else if (from > length) from = length;

    let to = end === undefined ? length : Math.trunc(Number(end));
    if (Number.isNaN(to)) to = 0;
    if (to < 0) to = Math.max(length + to, 0);
    else if (to > length) to = length;

    if (to <= from) return [];

    const resultLength = to - from;
    const result = new Array<T>(resultLength);
    let aliveIndex = 0;
    let resultIndex = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (aliveIndex >= to) break;
      if (aliveIndex >= from) result[resultIndex++] = node.value;
      aliveIndex++;
    }
    if (resultIndex !== resultLength) result.length = resultIndex;
    return result;
  }

  includes(value: T): boolean {
    const valueIsNaN = value !== value;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      const nodeValue = node.value;
      if (nodeValue === value) return true;
      if (valueIsNaN && nodeValue !== nodeValue) return true;
    }
    return false;
  }

  indexOf(value: T): number {
    let aliveIndex = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (node.value === value) return aliveIndex;
      aliveIndex++;
    }
    return -1;
  }

  find(
    predicate: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): T | undefined {
    return this.alive().find(predicate, thisArg as never);
  }

  findIndex(
    predicate: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): number {
    return this.alive().findIndex(predicate, thisArg as never);
  }

  forEach(
    callback: (value: T, index: number, array: T[]) => void,
    thisArg?: unknown
  ): void {
    this.alive().forEach(callback, thisArg as never);
  }

  map<U>(
    callback: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown
  ): U[] {
    return this.alive().map(callback, thisArg as never);
  }

  filter(
    predicate: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): T[] {
    return this.alive().filter(predicate, thisArg as never);
  }

  reduce<U>(
    reducer: (prev: U, curr: T, index: number, array: T[]) => U,
    initialValue: U
  ): U {
    return this.alive().reduce(reducer, initialValue);
  }

  every(
    predicate: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): boolean {
    return this.alive().every(predicate, thisArg as never);
  }

  some(
    predicate: (value: T, index: number, array: T[]) => boolean,
    thisArg?: unknown
  ): boolean {
    return this.alive().some(predicate, thisArg as never);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.alive()[Symbol.iterator]();
  }

  merge(remoteSnapshot: DAGNode<T>[] | DAGNode<T>): DAGNode<T>[] {
    const snapshot = Array.isArray(remoteSnapshot)
      ? remoteSnapshot
      : [remoteSnapshot];

    const changed: DAGNode<T>[] = [];
    for (const remote of snapshot) {
      const local = this.nodeById.get(remote.id);
      if (!local) {
        const clone = structuredClone(remote) as DAGNode<T>;
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

  sort(compareFn?: (a: DAGNode<T>, b: DAGNode<T>) => number): this {
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
  private alive(): T[] {
    const values = new Array<T>(this.aliveCount);
    let aliveIndex = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      values[aliveIndex++] = node.value;
    }
    if (aliveIndex !== values.length) values.length = aliveIndex;
    return values;
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

  private emit(nodes: readonly DAGNode<T>[]): void {
    if (nodes.length === 0) return;
    for (const listener of this.listeners) listener(nodes);
  }
}
