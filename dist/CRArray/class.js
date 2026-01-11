import { DAGNode } from "../DAGNode/class.js";
const ROOT = [];
function afterKey(after) {
    return after.length < 2 ? (after[0] ?? "") : after.join(",");
}
function isIndexKey(value) {
    const length = value.length;
    if (length === 0)
        return false;
    const first = value.charCodeAt(0);
    if (first < 48 || first > 57)
        return false;
    if (length > 1 && first === 48)
        return false;
    for (let i = 1; i < length; i++) {
        const code = value.charCodeAt(i);
        if (code < 48 || code > 57)
            return false;
    }
    return true;
}
export class CRArray {
    nodes = [];
    nodeById = new Map();
    aliveCount = 0;
    lastAliveIndex = -1;
    listeners = new Set();
    constructor(snapshot) {
        if (snapshot) {
            for (const node of snapshot) {
                if (this.nodeById.has(node.id))
                    continue;
                this.nodes.push(node);
                this.nodeById.set(node.id, node);
                if (!node.deleted)
                    this.aliveCount++;
            }
        }
        this.sort();
        return new Proxy(this, {
            get: (target, property, receiver) => {
                if (typeof property === "string") {
                    if (property === "length")
                        return target.length;
                    if (isIndexKey(property))
                        return target.at(Number(property));
                }
                return Reflect.get(target, property, receiver);
            },
            set: (target, property, value, receiver) => {
                if (typeof property === "string" && isIndexKey(property)) {
                    const index = Number(property);
                    target.setAt(index, value);
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
                    if (Number(property) >= target.length)
                        return undefined;
                    return {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: target.at(Number(property)),
                    };
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });
    }
    get length() {
        return this.aliveCount;
    }
    // --- public API ---
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    snapshot() {
        return this.nodes.slice();
    }
    push(...items) {
        const lastAliveId = this.lastAliveId();
        let after = lastAliveId ? [lastAliveId] : ROOT;
        const changed = [];
        for (const item of items) {
            const node = new DAGNode({ value: item, after });
            this.nodes.push(node);
            this.nodeById.set(node.id, node);
            changed.push(node);
            after = [node.id];
            this.aliveCount++;
        }
        this.sort();
        this.emit(changed);
        return this.length;
    }
    unshift(...items) {
        let after = ROOT;
        const changed = [];
        for (const item of items) {
            const node = new DAGNode({ value: item, after });
            this.nodes.push(node);
            this.nodeById.set(node.id, node);
            changed.push(node);
            after = [node.id];
            this.aliveCount++;
        }
        this.sort();
        this.emit(changed);
        return this.length;
    }
    pop() {
        for (let index = this.lastAliveIndex; index >= 0; index--) {
            const node = this.nodes[index];
            if (node.deleted)
                continue;
            node.deleted = true;
            this.aliveCount--;
            this.lastAliveIndex = index - 1;
            while (this.lastAliveIndex >= 0 &&
                this.nodes[this.lastAliveIndex].deleted) {
                this.lastAliveIndex--;
            }
            this.emit([node]);
            return node.value;
        }
        return undefined;
    }
    shift() {
        for (const node of this.nodes) {
            if (!node.deleted) {
                node.deleted = true;
                this.aliveCount--;
                if (this.aliveCount === 0)
                    this.lastAliveIndex = -1;
                this.emit([node]);
                return node.value;
            }
        }
        return undefined;
    }
    at(index) {
        const length = this.aliveCount;
        let target = Math.trunc(Number(index));
        if (Number.isNaN(target))
            target = 0;
        if (target < 0)
            target = length + target;
        if (target < 0 || target >= length)
            return undefined;
        let aliveIndex = 0;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            if (aliveIndex === target)
                return node.value;
            aliveIndex++;
        }
        return undefined;
    }
    setAt(index, value) {
        if (!Number.isInteger(index))
            throw new TypeError("CRArray.setAt: index must be an integer");
        if (index < 0)
            throw new RangeError("CRArray.setAt: negative index not supported");
        let aliveIndex = 0;
        let deletedNode = null;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
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
        const newNode = new DAGNode({ value, after });
        this.nodes.push(newNode);
        this.nodeById.set(newNode.id, newNode);
        this.aliveCount++;
        this.sort();
        const changed = deletedNode ? [deletedNode, newNode] : [newNode];
        this.emit(changed);
        return this;
    }
    slice(start, end) {
        const length = this.aliveCount;
        let from = start === undefined ? 0 : Math.trunc(Number(start));
        if (Number.isNaN(from))
            from = 0;
        if (from < 0)
            from = Math.max(length + from, 0);
        else if (from > length)
            from = length;
        let to = end === undefined ? length : Math.trunc(Number(end));
        if (Number.isNaN(to))
            to = 0;
        if (to < 0)
            to = Math.max(length + to, 0);
        else if (to > length)
            to = length;
        if (to <= from)
            return [];
        const resultLength = to - from;
        const result = new Array(resultLength);
        let aliveIndex = 0;
        let resultIndex = 0;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            if (aliveIndex >= to)
                break;
            if (aliveIndex >= from)
                result[resultIndex++] = node.value;
            aliveIndex++;
        }
        if (resultIndex !== resultLength)
            result.length = resultIndex;
        return result;
    }
    includes(value) {
        const valueIsNaN = value !== value;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            const nodeValue = node.value;
            if (nodeValue === value)
                return true;
            if (valueIsNaN && nodeValue !== nodeValue)
                return true;
        }
        return false;
    }
    indexOf(value) {
        let aliveIndex = 0;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            if (node.value === value)
                return aliveIndex;
            aliveIndex++;
        }
        return -1;
    }
    find(predicate, thisArg) {
        return this.alive().find(predicate, thisArg);
    }
    findIndex(predicate, thisArg) {
        return this.alive().findIndex(predicate, thisArg);
    }
    forEach(callback, thisArg) {
        this.alive().forEach(callback, thisArg);
    }
    map(callback, thisArg) {
        return this.alive().map(callback, thisArg);
    }
    filter(predicate, thisArg) {
        return this.alive().filter(predicate, thisArg);
    }
    reduce(reducer, initialValue) {
        return this.alive().reduce(reducer, initialValue);
    }
    every(predicate, thisArg) {
        return this.alive().every(predicate, thisArg);
    }
    some(predicate, thisArg) {
        return this.alive().some(predicate, thisArg);
    }
    [Symbol.iterator]() {
        return this.alive()[Symbol.iterator]();
    }
    merge(remoteSnapshot) {
        const snapshot = Array.isArray(remoteSnapshot)
            ? remoteSnapshot
            : [remoteSnapshot];
        const changed = [];
        for (const remote of snapshot) {
            const local = this.nodeById.get(remote.id);
            if (!local) {
                const clone = structuredClone(remote);
                this.nodes.push(clone);
                this.nodeById.set(clone.id, clone);
                if (!clone.deleted)
                    this.aliveCount++;
                changed.push(clone);
            }
            else if (!local.deleted && remote.deleted) {
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
    sort(compareFn) {
        if (compareFn) {
            this.nodes.sort(compareFn);
            this.recomputeLastAliveIndex();
            return this;
        }
        this.nodes.sort((left, right) => {
            const leftIsRoot = left.after.length === 0;
            const rightIsRoot = right.after.length === 0;
            if (leftIsRoot !== rightIsRoot)
                return leftIsRoot ? -1 : 1;
            const leftAfterKey = afterKey(left.after);
            const rightAfterKey = afterKey(right.after);
            if (leftAfterKey !== rightAfterKey)
                return leftAfterKey < rightAfterKey ? -1 : 1;
            if (left.id === right.id)
                return 0;
            if (leftIsRoot)
                return left.id > right.id ? -1 : 1;
            return left.id < right.id ? -1 : 1;
        });
        this.recomputeLastAliveIndex();
        return this;
    }
    // --- internals ---
    alive() {
        const values = new Array(this.aliveCount);
        let aliveIndex = 0;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            values[aliveIndex++] = node.value;
        }
        if (aliveIndex !== values.length)
            values.length = aliveIndex;
        return values;
    }
    lastAliveId() {
        if (this.lastAliveIndex < 0)
            return null;
        const node = this.nodes[this.lastAliveIndex];
        if (!node || node.deleted) {
            this.recomputeLastAliveIndex();
            if (this.lastAliveIndex < 0)
                return null;
            return this.nodes[this.lastAliveIndex].id;
        }
        return node.id;
    }
    recomputeLastAliveIndex() {
        for (let index = this.nodes.length - 1; index >= 0; index--) {
            if (!this.nodes[index].deleted) {
                this.lastAliveIndex = index;
                return;
            }
        }
        this.lastAliveIndex = -1;
    }
    afterIdForAliveInsertAt(index) {
        if (index === 0)
            return ROOT;
        let aliveIndex = 0;
        let previousAliveId = null;
        for (const node of this.nodes) {
            if (node.deleted)
                continue;
            if (aliveIndex === index)
                break;
            previousAliveId = node.id;
            aliveIndex++;
        }
        if (previousAliveId)
            return [previousAliveId];
        return ROOT;
    }
    emit(nodes) {
        if (nodes.length === 0)
            return;
        for (const listener of this.listeners)
            listener(nodes);
    }
}
