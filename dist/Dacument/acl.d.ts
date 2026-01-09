import type { AclAssignment, Role } from "./types.js";
export declare class AclLog {
    private readonly nodes;
    private readonly nodesById;
    private readonly nodesByActor;
    private readonly currentByActor;
    merge(input: AclAssignment[] | AclAssignment): AclAssignment[];
    snapshot(): AclAssignment[];
    reset(): void;
    isEmpty(): boolean;
    roleAt(actorId: string, stamp: AclAssignment["stamp"]): Role;
    currentRole(actorId: string): Role;
    currentEntry(actorId: string): AclAssignment | null;
    knownActors(): string[];
    private insert;
}
