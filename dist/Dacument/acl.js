import { compareHLC } from "./clock.js";
function compareAssignment(left, right) {
    const cmp = compareHLC(left.stamp, right.stamp);
    if (cmp !== 0)
        return cmp;
    if (left.id === right.id)
        return 0;
    return left.id < right.id ? -1 : 1;
}
export class AclLog {
    nodes = [];
    nodesById = new Set();
    nodesByActor = new Map();
    currentByActor = new Map();
    merge(input) {
        const nodes = Array.isArray(input) ? input : [input];
        const accepted = [];
        for (const node of nodes) {
            if (this.nodesById.has(node.id))
                continue;
            this.nodesById.add(node.id);
            this.nodes.push(node);
            this.insert(node);
            accepted.push(node);
        }
        return accepted;
    }
    snapshot() {
        return this.nodes.slice();
    }
    reset() {
        this.nodes.length = 0;
        this.nodesById.clear();
        this.nodesByActor.clear();
        this.currentByActor.clear();
    }
    isEmpty() {
        return this.nodes.length === 0;
    }
    roleAt(actorId, stamp) {
        const list = this.nodesByActor.get(actorId);
        if (!list || list.length === 0)
            return "revoked";
        for (let index = list.length - 1; index >= 0; index--) {
            const entry = list[index];
            if (compareHLC(entry.stamp, stamp) <= 0)
                return entry.role;
        }
        return "revoked";
    }
    currentRole(actorId) {
        const entry = this.currentByActor.get(actorId);
        return entry ? entry.role : "revoked";
    }
    currentEntry(actorId) {
        return this.currentByActor.get(actorId) ?? null;
    }
    publicKeyAt(actorId, stamp) {
        const list = this.nodesByActor.get(actorId);
        if (!list || list.length === 0)
            return null;
        for (let index = list.length - 1; index >= 0; index--) {
            const entry = list[index];
            if (compareHLC(entry.stamp, stamp) > 0)
                continue;
            if (entry.publicKeyJwk)
                return entry.publicKeyJwk;
        }
        return null;
    }
    knownActors() {
        return [...this.currentByActor.keys()];
    }
    insert(node) {
        const list = this.nodesByActor.get(node.actorId) ?? [];
        if (list.length === 0) {
            list.push(node);
            this.nodesByActor.set(node.actorId, list);
            this.currentByActor.set(node.actorId, node);
            return;
        }
        let inserted = false;
        for (let index = list.length - 1; index >= 0; index--) {
            if (compareAssignment(list[index], node) <= 0) {
                list.splice(index + 1, 0, node);
                inserted = true;
                break;
            }
        }
        if (!inserted)
            list.unshift(node);
        const current = this.currentByActor.get(node.actorId);
        if (!current || compareAssignment(current, node) < 0) {
            this.currentByActor.set(node.actorId, node);
        }
    }
}
