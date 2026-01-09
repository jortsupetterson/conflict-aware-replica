import { compareHLC } from "./clock.js";
import type { AclAssignment, Role } from "./types.js";

function compareAssignment(left: AclAssignment, right: AclAssignment): number {
  const cmp = compareHLC(left.stamp, right.stamp);
  if (cmp !== 0) return cmp;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export class AclLog {
  private readonly nodes: AclAssignment[] = [];
  private readonly nodesById = new Set<string>();
  private readonly nodesByActor = new Map<string, AclAssignment[]>();
  private readonly currentByActor = new Map<string, AclAssignment>();

  merge(input: AclAssignment[] | AclAssignment): AclAssignment[] {
    const nodes = Array.isArray(input) ? input : [input];
    const accepted: AclAssignment[] = [];

    for (const node of nodes) {
      if (this.nodesById.has(node.id)) continue;
      this.nodesById.add(node.id);
      this.nodes.push(node);
      this.insert(node);
      accepted.push(node);
    }

    return accepted;
  }

  snapshot(): AclAssignment[] {
    return this.nodes.slice();
  }

  isEmpty(): boolean {
    return this.nodes.length === 0;
  }

  roleAt(actorId: string, stamp: AclAssignment["stamp"]): Role {
    const list = this.nodesByActor.get(actorId);
    if (!list || list.length === 0) return "revoked";

    for (let index = list.length - 1; index >= 0; index--) {
      const entry = list[index];
      if (compareHLC(entry.stamp, stamp) <= 0) return entry.role;
    }

    return "revoked";
  }

  entryAt(actorId: string, stamp: AclAssignment["stamp"]): AclAssignment | null {
    const list = this.nodesByActor.get(actorId);
    if (!list || list.length === 0) return null;

    for (let index = list.length - 1; index >= 0; index--) {
      const entry = list[index];
      if (compareHLC(entry.stamp, stamp) <= 0) return entry;
    }

    return null;
  }

  currentRole(actorId: string): Role {
    const entry = this.currentByActor.get(actorId);
    return entry ? entry.role : "revoked";
  }

  knownActors(): string[] {
    return [...this.currentByActor.keys()];
  }

  private insert(node: AclAssignment): void {
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
    if (!inserted) list.unshift(node);

    const current = this.currentByActor.get(node.actorId);
    if (!current || compareAssignment(current, node) < 0) {
      this.currentByActor.set(node.actorId, node);
    }
  }
}
