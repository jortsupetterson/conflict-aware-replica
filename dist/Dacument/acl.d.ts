import type { AclAssignment, Role } from "./types.js";
export declare class AclLog {
    private readonly nodes;
    private readonly nodesById;
    private readonly nodesByActor;
    private readonly currentByActor;
    merge(input: AclAssignment[] | AclAssignment): AclAssignment[];
    snapshot(): AclAssignment[];
    isEmpty(): boolean;
    roleAt(actorId: string, stamp: AclAssignment["stamp"]): Role;
    entryAt(actorId: string, stamp: AclAssignment["stamp"]): AclAssignment | null;
    currentRole(actorId: string): Role;
    knownActors(): string[];
    private insert;
}
