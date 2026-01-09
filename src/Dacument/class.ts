import { Bytes, generateNonce } from "bytecodec";
import { generateSignPair } from "zeyra";
import { v7 as uuidv7 } from "uuid";
import { CRArray } from "../CRArray/class.js";
import { CRMap } from "../CRMap/class.js";
import { CRRecord } from "../CRRecord/class.js";
import { CRRegister } from "../CRRegister/class.js";
import { CRSet } from "../CRSet/class.js";
import { CRText } from "../CRText/class.js";
import { AclLog } from "./acl.js";
import { HLC, compareHLC } from "./clock.js";
import { decodeToken, signToken, verifyToken } from "./crypto.js";
import {
  type AclAssignment,
  type DacumentEventMap,
  type DocFieldAccess,
  type DocSnapshot,
  type DocValue,
  type FieldSchema,
  type JsTypeName,
  type JsValue,
  type OpPayload,
  type RoleKeys,
  type RolePublicKeys,
  type SchemaDefinition,
  type SchemaId,
  type SignedOp,
  type Role,
  array,
  map,
  record,
  register,
  set,
  text,
  isJsValue,
  isValueOfType,
  schemaIdInput,
} from "./types.js";

const TOKEN_TYP = "DACOP";

type FieldState = {
  schema: FieldSchema;
  crdt:
    | CRArray<any>
    | CRText<any>
    | CRMap<any, any>
    | CRSet<any>
    | CRRecord<any>
    | CRRegister<any>;
  view?: unknown;
};

type AckState = {
  actorId: string;
  stamp: AclAssignment["stamp"];
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stableKey(value: JsValue): string {
  if (value === null) return "null";
  if (Array.isArray(value))
    return `[${value.map((entry) => stableKey(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, JsValue>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
    );
    const body = entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableKey(val)}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function isDagNode(
  node: unknown
): node is { id: string; value: unknown; after: string[]; deleted?: boolean } {
  if (!isObject(node)) return false;
  if (typeof node.id !== "string") return false;
  if (!Array.isArray(node.after) || !node.after.every((id) => typeof id === "string"))
    return false;
  if (node.deleted !== undefined && typeof node.deleted !== "boolean") return false;
  return true;
}

function isAclPatch(value: unknown): value is {
  id: string;
  target: string;
  role: Role;
} {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.target !== "string") return false;
  if (typeof value.role !== "string") return false;
  return true;
}

function isAckPatch(value: unknown): value is { seen: AckState["stamp"] } {
  if (!isObject(value)) return false;
  if (!isObject(value.seen)) return false;
  const seen = value.seen as AckState["stamp"];
  return (
    typeof seen.wallTimeMs === "number" &&
    typeof seen.logical === "number" &&
    typeof seen.clockId === "string"
  );
}

function isPatchEnvelope(value: unknown): value is { nodes: unknown[] } {
  return isObject(value) && Array.isArray(value.nodes);
}

function indexMapForNodes(
  nodes: Array<{ id: string; deleted?: boolean }>
): Map<string, number> {
  const map = new Map<string, number>();
  let aliveIndex = 0;
  for (const node of nodes) {
    map.set(node.id, aliveIndex);
    if (!node.deleted) aliveIndex += 1;
  }
  return map;
}

function createEmptyField(
  crdt: FieldSchema
):
  | CRArray<any>
  | CRText<any>
  | CRMap<any, any>
  | CRSet<any>
  | CRRecord<any>
  | CRRegister<any> {
  switch (crdt.crdt) {
    case "register":
      return new CRRegister();
    case "text":
      return new CRText();
    case "array":
      return new CRArray();
    case "map":
      return new CRMap({ key: crdt.key as (value: unknown) => string });
    case "set":
      return new CRSet({ key: crdt.key as (value: unknown) => string });
    case "record":
      return new CRRecord();
  }
}

function roleNeedsKey(role: Role): role is "owner" | "manager" | "editor" {
  return role === "owner" || role === "manager" || role === "editor";
}

async function generateRoleKeys(): Promise<RoleKeys> {
  const ownerPair = await generateSignPair();
  const managerPair = await generateSignPair();
  const editorPair = await generateSignPair();
  return {
    owner: { privateKey: ownerPair.signingJwk, publicKey: ownerPair.verificationJwk },
    manager: { privateKey: managerPair.signingJwk, publicKey: managerPair.verificationJwk },
    editor: { privateKey: editorPair.signingJwk, publicKey: editorPair.verificationJwk },
  };
}

function toPublicRoleKeys(roleKeys: RoleKeys): RolePublicKeys {
  return {
    owner: roleKeys.owner.publicKey,
    manager: roleKeys.manager.publicKey,
    editor: roleKeys.editor.publicKey,
  };
}

export class Dacument<S extends SchemaDefinition> {
  static schema = <Schema extends SchemaDefinition>(schema: Schema): Schema => schema;
  static register = register;
  static text = text;
  static array = array;
  static set = set;
  static map = map;
  static record = record;

  static generateId(): string {
    return generateNonce();
  }


  static async computeSchemaId(schema: SchemaDefinition): Promise<SchemaId> {
    const normalized = schemaIdInput(schema);
    const sortedKeys = Object.keys(normalized).sort();
    const ordered: Record<string, unknown> = {};
    for (const key of sortedKeys) ordered[key] = normalized[key];
    const json = JSON.stringify(ordered);
    const data = new Uint8Array(Bytes.fromString(json));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Bytes.toBase64UrlString(new Uint8Array(digest));
  }

  static async create<Schema extends SchemaDefinition>(params: {
    schema: Schema;
    ownerId: string;
    docId?: string;
  }): Promise<{
    docId: string;
    schemaId: SchemaId;
    roleKeys: RoleKeys;
    snapshot: DocSnapshot;
  }> {
    if (!params.ownerId)
      throw new Error("Dacument.create: ownerId is required");
    const docId = params.docId ?? Dacument.generateId();
    const schemaId = await Dacument.computeSchemaId(params.schema);
    const roleKeys = await generateRoleKeys();
    const publicKeys = toPublicRoleKeys(roleKeys);

    const clock = new HLC(params.ownerId);
    const header = {
      alg: "ES256",
      typ: TOKEN_TYP,
      kid: `${params.ownerId}:owner`,
    } as const;
    const ops: SignedOp[] = [];

    const capturePatches = <TNode>(
      subscribe: (listener: (nodes: readonly TNode[]) => void) => () => void,
      mutate: () => void
    ): TNode[] => {
      const patches: TNode[] = [];
      const stop = subscribe((nodes) => patches.push(...nodes));
      try {
        mutate();
      } finally {
        stop();
      }
      return patches;
    };

    const sign = async (payload: OpPayload): Promise<void> => {
      const token = await signToken(roleKeys.owner.privateKey, header, payload);
      ops.push({ token });
    };

    await sign({
      iss: params.ownerId,
      sub: docId,
      iat: nowSeconds(),
      stamp: clock.next(),
      kind: "acl.set",
      schema: schemaId,
      patch: {
        id: uuidv7(),
        target: params.ownerId,
        role: "owner",
      },
    });

    for (const [field, schema] of Object.entries(params.schema)) {
      if (schema.crdt === "register") {
        if (schema.initial === undefined) continue;
        if (!isValueOfType(schema.initial, schema.jsType))
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        if (
          schema.regex &&
          typeof schema.initial === "string" &&
          !schema.regex.test(schema.initial)
        )
          throw new Error(`Dacument.create: '${field}' failed regex`);
        await sign({
          iss: params.ownerId,
          sub: docId,
          iat: nowSeconds(),
          stamp: clock.next(),
          kind: "register.set",
          schema: schemaId,
          field,
          patch: { value: schema.initial },
        });
        continue;
      }

      if (schema.crdt === "text") {
        const initial = schema.initial ?? "";
        if (typeof initial !== "string")
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        if (!initial) continue;
        const crdt = new CRText();
        const nodes = capturePatches(
          (listener) => crdt.onChange(listener),
          () => {
            for (const char of initial) crdt.insertAt(crdt.length, char);
          }
        );
        if (nodes.length)
          await sign({
            iss: params.ownerId,
            sub: docId,
            iat: nowSeconds(),
            stamp: clock.next(),
            kind: "text.patch",
            schema: schemaId,
            field,
            patch: { nodes },
          });
        continue;
      }

      if (schema.crdt === "array") {
        const initial = schema.initial ?? [];
        if (!Array.isArray(initial))
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        if (initial.length === 0) continue;
        for (const value of initial) {
          if (!isValueOfType(value, schema.jsType))
            throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        }
        const crdt = new CRArray();
        const nodes = capturePatches(
          (listener) => crdt.onChange(listener),
          () => {
            crdt.push(...initial);
          }
        );
        if (nodes.length)
          await sign({
            iss: params.ownerId,
            sub: docId,
            iat: nowSeconds(),
            stamp: clock.next(),
            kind: "array.patch",
            schema: schemaId,
            field,
            patch: { nodes },
          });
        continue;
      }

      if (schema.crdt === "set") {
        const initial = schema.initial ?? [];
        if (!Array.isArray(initial))
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        if (initial.length === 0) continue;
        for (const value of initial) {
          if (!isValueOfType(value, schema.jsType))
            throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        }
        const crdt = new CRSet({
          key: schema.key as (value: unknown) => string,
        });
        const nodes = capturePatches(
          (listener) => crdt.onChange(listener),
          () => {
            for (const value of initial) crdt.add(value);
          }
        );
        if (nodes.length)
          await sign({
            iss: params.ownerId,
            sub: docId,
            iat: nowSeconds(),
            stamp: clock.next(),
            kind: "set.patch",
            schema: schemaId,
            field,
            patch: { nodes },
          });
        continue;
      }

      if (schema.crdt === "map") {
        const initial = schema.initial ?? [];
        if (!Array.isArray(initial))
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        if (initial.length === 0) continue;
        for (const entry of initial) {
          if (!Array.isArray(entry) || entry.length !== 2)
            throw new Error(`Dacument.create: invalid initial entry for '${field}'`);
          const [key, value] = entry;
          if (!isJsValue(key))
            throw new Error(
              `Dacument.create: map key for '${field}' must be JSON-compatible`
            );
          if (!isValueOfType(value, schema.jsType))
            throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        }
        const crdt = new CRMap({
          key: schema.key as (value: unknown) => string,
        });
        const nodes = capturePatches(
          (listener) => crdt.onChange(listener),
          () => {
            for (const [key, value] of initial) crdt.set(key, value);
          }
        );
        if (nodes.length)
          await sign({
            iss: params.ownerId,
            sub: docId,
            iat: nowSeconds(),
            stamp: clock.next(),
            kind: "map.patch",
            schema: schemaId,
            field,
            patch: { nodes },
          });
        continue;
      }

      if (schema.crdt === "record") {
        const initial = schema.initial ?? {};
        if (!isObject(initial) || Array.isArray(initial))
          throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        const props = Object.keys(initial);
        if (props.length === 0) continue;
        for (const prop of props) {
          const value = initial[prop];
          if (!isValueOfType(value, schema.jsType))
            throw new Error(`Dacument.create: invalid initial value for '${field}'`);
        }
        const crdt = new CRRecord();
        const nodes = capturePatches(
          (listener) => crdt.onChange(listener),
          () => {
            for (const prop of props) (crdt as any)[prop] = initial[prop];
          }
        );
        if (nodes.length)
          await sign({
            iss: params.ownerId,
            sub: docId,
            iat: nowSeconds(),
            stamp: clock.next(),
            kind: "record.patch",
            schema: schemaId,
            field,
            patch: { nodes },
          });
        continue;
      }
    }

    const snapshot: DocSnapshot = {
      docId,
      roleKeys: publicKeys,
      ops,
    };

    return { docId, schemaId, roleKeys, snapshot };
  }

  static async load<Schema extends SchemaDefinition>(params: {
    schema: Schema;
    actorId: string;
    roleKey?: JsonWebKey;
    snapshot: DocSnapshot;
  }): Promise<DacumentDoc<Schema>> {
    const schemaId = await Dacument.computeSchemaId(params.schema);
    const doc = new Dacument<Schema>({
      schema: params.schema,
      schemaId,
      docId: params.snapshot.docId,
      actorId: params.actorId,
      roleKey: params.roleKey,
      roleKeys: params.snapshot.roleKeys,
    }) as DacumentDoc<Schema>;

    const result = await doc.merge(params.snapshot.ops);
    if (result.rejected)
      throw new Error("Dacument.load: snapshot contains invalid ops");
    return doc;
  }

  public readonly docId: string;
  public readonly actorId: string;
  public readonly schema: S;
  public readonly schemaId: SchemaId;
  private readonly fields = new Map<string, FieldState>();
  private readonly aclLog = new AclLog();
  private readonly clock: HLC;
  private readonly roleKey?: JsonWebKey;
  private readonly roleKeys: RolePublicKeys;
  private readonly opLog: SignedOp[] = [];
  private readonly opTokens = new Set<string>();
  private currentRole: Role;
  private readonly revokedCrdtByField = new Map<string, FieldState["crdt"]>();
  private readonly eventListeners = new Map<
    keyof DacumentEventMap,
    Set<(event: DacumentEventMap[keyof DacumentEventMap]) => void>
  >();
  private readonly pending = new Set<Promise<void>>();
  private readonly ackByActor = new Map<string, AclAssignment["stamp"]>();

  public readonly acl: {
    setRole: (actorId: string, role: Role) => void;
    getRole: (actorId: string) => Role;
    knownActors: () => string[];
    snapshot: () => AclAssignment[];
  };

  constructor(params: {
    schema: S;
    schemaId: SchemaId;
    docId: string;
    actorId: string;
    roleKey?: JsonWebKey;
    roleKeys: RolePublicKeys;
  }) {
    this.schema = params.schema;
    this.schemaId = params.schemaId;
    this.docId = params.docId;
    this.actorId = params.actorId;
    this.roleKey = params.roleKey;
    this.roleKeys = params.roleKeys;
    this.clock = new HLC(this.actorId);

    this.assertSchemaKeys();

    for (const [key, schema] of Object.entries(this.schema)) {
      const crdt = createEmptyField(schema);
      this.fields.set(key, { schema, crdt });
    }

    this.acl = {
      setRole: (actorId, role) => this.setRole(actorId, role),
      getRole: (actorId) => this.aclLog.currentRole(actorId),
      knownActors: () => this.aclLog.knownActors(),
      snapshot: () => this.aclLog.snapshot(),
    };
    this.currentRole = this.aclLog.currentRole(this.actorId);

    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property !== "string")
          return Reflect.get(target, property, receiver);
        if (property in target) return Reflect.get(target, property, receiver);
        if (!target.fields.has(property)) return undefined;
        const field = target.fields.get(property) as FieldState;
        if (field.schema.crdt === "register") {
          const crdt = target.readCrdt(property, field) as CRRegister<any>;
          return crdt.get();
        }
        if (!field.view) field.view = target.createFieldView(property, field);
        return field.view;
      },
      set: (target, property, value, receiver) => {
        if (typeof property !== "string")
          return Reflect.set(target, property, value, receiver);
        if (property in target) return Reflect.set(target, property, value, receiver);
        const field = target.fields.get(property);
        if (!field) throw new Error(`Dacument: unknown field '${property}'`);
        if (field.schema.crdt !== "register")
          throw new Error(`Dacument: field '${property}' is read-only`);
        target.setRegisterValue(property, value);
        return true;
      },
      has: (target, property) => {
        if (typeof property !== "string") return Reflect.has(target, property);
        if (property in target) return true;
        return target.fields.has(property);
      },
      ownKeys: (target) => [...target.fields.keys()],
      getOwnPropertyDescriptor: (target, property) => {
        if (typeof property !== "string")
          return Reflect.getOwnPropertyDescriptor(target, property);
        if (target.fields.has(property))
          return { configurable: true, enumerable: true };
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      deleteProperty: () => false,
    }) as this;
  }

  addEventListener<K extends keyof DacumentEventMap>(
    type: K,
    listener: (event: DacumentEventMap[K]) => void
  ): void {
    const listeners =
      this.eventListeners.get(type) ??
      new Set<(event: DacumentEventMap[keyof DacumentEventMap]) => void>();
    listeners.add(listener as (event: DacumentEventMap[keyof DacumentEventMap]) => void);
    this.eventListeners.set(type, listeners);
  }

  removeEventListener<K extends keyof DacumentEventMap>(
    type: K,
    listener: (event: DacumentEventMap[K]) => void
  ): void {
    const listeners = this.eventListeners.get(type);
    if (!listeners) return;
    listeners.delete(
      listener as (event: DacumentEventMap[keyof DacumentEventMap]) => void
    );
    if (listeners.size === 0) this.eventListeners.delete(type);
  }

  onChange(listener: (ops: SignedOp[]) => void): () => void {
    const handler = (event: DacumentEventMap["change"]) => listener(event.ops);
    this.addEventListener("change", handler);
    return () => this.removeEventListener("change", handler);
  }

  onFieldChange<K extends keyof S & string>(
    field: K,
    listener: (value: DocValue<S>[K]) => void
  ): () => void {
    const handler = (event: DacumentEventMap["merge"]) => {
      if (event.target === field) listener(this.fieldValue(field) as DocValue<S>[K]);
    };
    this.addEventListener("merge", handler);
    return () => this.removeEventListener("merge", handler);
  }

  onAnyFieldChange(
    listener: (field: keyof S & string, value: DocValue<S>[keyof S & string]) => void
  ): () => void {
    const handler = (event: DacumentEventMap["merge"]) =>
      listener(
        event.target as keyof S & string,
        this.fieldValue(event.target) as DocValue<S>[keyof S & string]
      );
    this.addEventListener("merge", handler);
    return () => this.removeEventListener("merge", handler);
  }

  onError(listener: (error: Error) => void): () => void {
    const handler = (event: DacumentEventMap["error"]) => listener(event.error);
    this.addEventListener("error", handler);
    return () => this.removeEventListener("error", handler);
  }

  onRevoked(listener: (event: DacumentEventMap["revoked"]) => void): () => void {
    const handler = (event: DacumentEventMap["revoked"]) => listener(event);
    this.addEventListener("revoked", handler);
    return () => this.removeEventListener("revoked", handler);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  snapshot(): DocSnapshot {
    if (this.isRevoked()) throw new Error("Dacument: revoked actors cannot snapshot");
    return {
      docId: this.docId,
      roleKeys: this.roleKeys,
      ops: this.opLog.slice(),
    };
  }

  async merge(
    input: SignedOp | SignedOp[] | string | string[]
  ): Promise<{ accepted: SignedOp[]; rejected: number }> {
    const tokens = Array.isArray(input) ? input : [input];
    const decodedOps: Array<{ token: string; payload: OpPayload }> = [];
    const accepted: SignedOp[] = [];
    let rejected = 0;

    for (const item of tokens) {
      const token = typeof item === "string" ? item : item.token;
      const decoded = decodeToken(token);
      if (!decoded) {
        rejected++;
        continue;
      }
      const payload = decoded.payload as OpPayload;
      if (!this.isValidPayload(payload)) {
        rejected++;
        continue;
      }
      if (payload.sub !== this.docId || payload.schema !== this.schemaId) {
        rejected++;
        continue;
      }
      decodedOps.push({ token, payload });
    }

    decodedOps.sort((left, right) => {
      const cmp = compareHLC(left.payload.stamp, right.payload.stamp);
      if (cmp !== 0) return cmp;
      if (left.token === right.token) return 0;
      return left.token < right.token ? -1 : 1;
    });

    for (const { token, payload } of decodedOps) {
      const prevRole = this.currentRole;
      const signerRole = this.resolveSignerRole(payload);
      if (!signerRole || !roleNeedsKey(signerRole)) {
        rejected++;
        continue;
      }

      const publicKey = this.roleKeys[signerRole];
      const verified = await verifyToken(publicKey, token, TOKEN_TYP);
      if (!verified) {
        rejected++;
        continue;
      }

      if (payload.kind !== "acl.set" && !this.canWriteField(signerRole)) {
        rejected++;
        continue;
      }

      const applied = this.applyRemotePayload(payload, signerRole);
      if (!applied) {
        rejected++;
        continue;
      }

      const nextRole = this.aclLog.currentRole(this.actorId);
      if (nextRole !== prevRole) {
        this.currentRole = nextRole;
        if (nextRole === "revoked")
          this.emitRevoked(prevRole, payload);
      }

      if (!this.opTokens.has(token)) {
        this.opTokens.add(token);
        this.opLog.push({ token });
      }
      accepted.push({ token });
    }

    return { accepted, rejected };
  }

  ack(): void {
    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    const seen = this.clock.current;
    this.ackByActor.set(this.actorId, seen);
    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "ack",
        schema: this.schemaId,
        patch: { seen },
      },
      role
    );
  }


  private setRegisterValue(field: string, value: unknown): void {
    const state = this.fields.get(field);
    if (!state) throw new Error(`Dacument: unknown field '${field}'`);
    const schema = state.schema;
    if (schema.crdt !== "register")
      throw new Error(`Dacument: field '${field}' is not a register`);
    if (!isValueOfType(value, schema.jsType))
      throw new Error(`Dacument: invalid value for '${field}'`);
    if (schema.regex && typeof value === "string" && !schema.regex.test(value))
      throw new Error(`Dacument: '${field}' failed regex`);

    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    if (!this.canWriteField(role))
      throw new Error(`Dacument: role '${role}' cannot write '${field}'`);

    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "register.set",
        schema: this.schemaId,
        field,
        patch: { value },
      },
      role
    );
  }

  private createFieldView(field: string, state: FieldState): unknown {
    switch (state.schema.crdt) {
      case "text":
        return this.createTextView(field, state);
      case "array":
        return this.createArrayView(field, state);
      case "set":
        return this.createSetView(field, state);
      case "map":
        return this.createMapView(field, state);
      case "record":
        return this.createRecordView(field, state);
      default:
        return undefined;
    }
  }

  private shadowFor(field: string, state: FieldState) {
    const snapshot = (state.crdt as any).snapshot?.();
    const cloned = snapshot ? structuredClone(snapshot) : undefined;
    switch (state.schema.crdt) {
      case "text":
        return new CRText(cloned);
      case "array":
        return new CRArray(cloned);
      case "set":
        return new CRSet({
          snapshot: cloned,
          key: state.schema.key as (value: unknown) => string,
        });
      case "map":
        return new CRMap({
          snapshot: cloned,
          key: state.schema.key as (value: unknown) => string,
        });
      case "record":
        return new CRRecord(cloned);
      case "register": {
        const reg = new CRRegister();
        if (cloned && Array.isArray(cloned)) reg.merge(cloned);
        return reg;
      }
      default:
        throw new Error(`Dacument: unknown field '${field}'`);
    }
  }

  private isRevoked(): boolean {
    return this.currentRole === "revoked";
  }

  private readCrdt(field: string, state: FieldState): FieldState["crdt"] {
    if (!this.isRevoked()) return state.crdt;
    return this.revokedCrdt(field, state);
  }

  private revokedCrdt(field: string, state: FieldState): FieldState["crdt"] {
    const existing = this.revokedCrdtByField.get(field);
    if (existing) return existing;

    const schema = state.schema;
    let crdt: FieldState["crdt"];

    switch (schema.crdt) {
      case "register": {
        const reg = new CRRegister();
        if (schema.initial !== undefined) reg.set(schema.initial as any);
        crdt = reg;
        break;
      }
      case "text": {
        const text = new CRText();
        const initial = typeof schema.initial === "string" ? schema.initial : "";
        for (const char of initial) text.insertAt(text.length, char);
        crdt = text;
        break;
      }
      case "array": {
        const arr = new CRArray();
        const initial = Array.isArray(schema.initial) ? schema.initial : [];
        if (initial.length) arr.push(...initial);
        crdt = arr;
        break;
      }
      case "set": {
        const setCrdt = new CRSet({
          key: schema.key as (value: unknown) => string,
        });
        const initial = Array.isArray(schema.initial) ? schema.initial : [];
        for (const value of initial) setCrdt.add(value);
        crdt = setCrdt;
        break;
      }
      case "map": {
        const mapCrdt = new CRMap({
          key: schema.key as (value: unknown) => string,
        });
        const initial = Array.isArray(schema.initial) ? schema.initial : [];
        for (const entry of initial) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [key, value] = entry;
          mapCrdt.set(key, value);
        }
        crdt = mapCrdt;
        break;
      }
      case "record": {
        const recordCrdt = new CRRecord();
        const initial =
          schema.initial && isObject(schema.initial) && !Array.isArray(schema.initial)
            ? schema.initial
            : {};
        for (const [prop, value] of Object.entries(initial))
          (recordCrdt as any)[prop] = value;
        crdt = recordCrdt;
        break;
      }
      default:
        throw new Error(`Dacument: unknown field '${field}'`);
    }

    this.revokedCrdtByField.set(field, crdt);
    return crdt;
  }

  private createTextView(field: string, state: FieldState) {
    const doc = this;
    const readCrdt = () => doc.readCrdt(field, state) as CRText<any>;
    return {
      get length() {
        return readCrdt().length;
      },
      toString() {
        return readCrdt().toString();
      },
      at(index: number) {
        return readCrdt().at(index);
      },
      insertAt(index: number, value: string) {
        doc.assertValueType(field, value);
        const stamp = doc.clock.next();
        const role = doc.aclLog.roleAt(doc.actorId, stamp);
        doc.assertWritable(field, role);
        const shadow = doc.shadowFor(field, state) as CRText<any>;
        const { patches, result } = doc.capturePatches(
          (listener) => shadow.onChange(listener),
          () => shadow.insertAt(index, value)
        );
        if (patches.length === 0) return result;
        doc.queueLocalOp(
          {
            iss: doc.actorId,
            sub: doc.docId,
            iat: nowSeconds(),
            stamp,
            kind: "text.patch",
            schema: doc.schemaId,
            field,
            patch: { nodes: patches },
          },
          role
        );
        return result;
      },
      deleteAt(index: number) {
        const stamp = doc.clock.next();
        const role = doc.aclLog.roleAt(doc.actorId, stamp);
        doc.assertWritable(field, role);
        const shadow = doc.shadowFor(field, state) as CRText<any>;
        const { patches, result } = doc.capturePatches(
          (listener) => shadow.onChange(listener),
          () => shadow.deleteAt(index)
        );
        if (patches.length === 0) return result;
        doc.queueLocalOp(
          {
            iss: doc.actorId,
            sub: doc.docId,
            iat: nowSeconds(),
            stamp,
            kind: "text.patch",
            schema: doc.schemaId,
            field,
            patch: { nodes: patches },
          },
          role
        );
        return result;
      },
      onChange(listener: (value: string) => void) {
        return doc.onFieldChange(field as keyof S & string, listener as any);
      },
      [Symbol.iterator]() {
        return readCrdt().toString()[Symbol.iterator]();
      },
    };
  }

  private createArrayView(field: string, state: FieldState) {
    const doc = this;
    const readCrdt = () => doc.readCrdt(field, state) as CRArray<any>;
    return {
      get length() {
        return readCrdt().length;
      },
      at(index: number) {
        return readCrdt().at(index);
      },
      slice(start?: number, end?: number) {
        return readCrdt().slice(start, end);
      },
      push(...items: unknown[]) {
        doc.assertValueArray(field, items);
        return doc.commitArrayMutation(field, (shadow) => shadow.push(...items));
      },
      unshift(...items: unknown[]) {
        doc.assertValueArray(field, items);
        return doc.commitArrayMutation(field, (shadow) => shadow.unshift(...items));
      },
      pop() {
        return doc.commitArrayMutation(field, (shadow) => shadow.pop());
      },
      shift() {
        return doc.commitArrayMutation(field, (shadow) => shadow.shift());
      },
      setAt(index: number, value: unknown) {
        doc.assertValueType(field, value);
        return doc.commitArrayMutation(field, (shadow) => shadow.setAt(index, value));
      },
      map(callback: any, thisArg?: unknown) {
        return readCrdt().map(callback, thisArg);
      },
      filter(callback: any, thisArg?: unknown) {
        return readCrdt().filter(callback, thisArg);
      },
      reduce(callback: any, initialValue: any) {
        return readCrdt().reduce(callback, initialValue);
      },
      forEach(callback: any, thisArg?: unknown) {
        return readCrdt().forEach(callback, thisArg);
      },
      includes(value: unknown) {
        return readCrdt().includes(value as any);
      },
      indexOf(value: unknown) {
        return readCrdt().indexOf(value as any);
      },
      onChange(listener: (value: unknown[]) => void) {
        return doc.onFieldChange(field as keyof S & string, listener as any);
      },
      [Symbol.iterator]() {
        return readCrdt()[Symbol.iterator]();
      },
    };
  }

  private createSetView(field: string, state: FieldState) {
    const doc = this;
    const readCrdt = () => doc.readCrdt(field, state) as CRSet<any>;
    return {
      get size() {
        return readCrdt().size;
      },
      add(value: unknown) {
        doc.assertValueType(field, value);
        return doc.commitSetMutation(field, (shadow) => shadow.add(value));
      },
      delete(value: unknown) {
        return doc.commitSetMutation(field, (shadow) => shadow.delete(value));
      },
      clear() {
        return doc.commitSetMutation(field, (shadow) => shadow.clear());
      },
      has(value: unknown) {
        return readCrdt().has(value);
      },
      entries() {
        return readCrdt().entries();
      },
      keys() {
        return readCrdt().keys();
      },
      values() {
        return readCrdt().values();
      },
      forEach(callback: any, thisArg?: unknown) {
        return readCrdt().forEach(callback, thisArg);
      },
      onChange(listener: (value: unknown[]) => void) {
        return doc.onFieldChange(field as keyof S & string, listener as any);
      },
      [Symbol.iterator]() {
        return readCrdt()[Symbol.iterator]();
      },
      get [Symbol.toStringTag]() {
        return "CRSet";
      },
    };
  }

  private createMapView(field: string, state: FieldState) {
    const doc = this;
    const readCrdt = () => doc.readCrdt(field, state) as CRMap<any, any>;
    return {
      get size() {
        return readCrdt().size;
      },
      get(key: unknown) {
        return readCrdt().get(key as any);
      },
      set(key: unknown, value: unknown) {
        doc.assertMapKey(field, key);
        doc.assertValueType(field, value);
        return doc.commitMapMutation(field, (shadow) => shadow.set(key, value));
      },
      has(key: unknown) {
        return readCrdt().has(key as any);
      },
      delete(key: unknown) {
        doc.assertMapKey(field, key);
        return doc.commitMapMutation(field, (shadow) => shadow.delete(key));
      },
      clear() {
        return doc.commitMapMutation(field, (shadow) => shadow.clear());
      },
      entries() {
        return readCrdt().entries();
      },
      keys() {
        return readCrdt().keys();
      },
      values() {
        return readCrdt().values();
      },
      forEach(callback: any, thisArg?: unknown) {
        return readCrdt().forEach(callback, thisArg);
      },
      onChange(listener: (value: Array<[JsValue, unknown]>) => void) {
        return doc.onFieldChange(field as keyof S & string, listener as any);
      },
      [Symbol.iterator]() {
        return readCrdt()[Symbol.iterator]();
      },
      get [Symbol.toStringTag]() {
        return "CRMap";
      },
    };
  }

  private createRecordView(field: string, state: FieldState) {
    const doc = this;
    const readCrdt = () => doc.readCrdt(field, state) as CRRecord<any>;
    return new Proxy(
      {
        onChange(listener: (value: Record<string, unknown>) => void) {
          return doc.onFieldChange(field as keyof S & string, listener as any);
        },
        keys() {
          return Object.keys(readCrdt() as any);
        },
        toJSON() {
          return doc.recordValue(readCrdt());
        },
      },
      {
        get: (target, prop, receiver) => {
          if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
          if (prop in target) return Reflect.get(target, prop, receiver);
          return (readCrdt() as any)[prop];
        },
        set: (_target, prop, value) => {
          if (typeof prop !== "string") return false;
          doc.assertValueType(field, value);
          doc.commitRecordMutation(field, (shadow) => {
            (shadow as any)[prop] = value;
          });
          return true;
        },
        deleteProperty: (_target, prop) => {
          if (typeof prop !== "string") return false;
          doc.commitRecordMutation(field, (shadow) => {
            delete (shadow as any)[prop];
          });
          return true;
        },
        has: (_target, prop) => {
          if (typeof prop !== "string") return false;
          return prop in (readCrdt() as any);
        },
        ownKeys: () => Object.keys(readCrdt() as any),
        getOwnPropertyDescriptor: (_target, prop) => {
          if (typeof prop !== "string") return undefined;
          if (prop in (readCrdt() as any))
            return { enumerable: true, configurable: true };
          return undefined;
        },
      }
    );
  }

  private commitArrayMutation<TResult>(
    field: string,
    mutate: (crdt: CRArray<any>) => TResult
  ) {
    const state = this.fields.get(field) as FieldState;
    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    this.assertWritable(field, role);
    const shadow = this.shadowFor(field, state) as CRArray<any>;
    const { patches, result } = this.capturePatches(
      (listener) => shadow.onChange(listener),
      () => mutate(shadow)
    );
    if (patches.length === 0) return result;
    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "array.patch",
        schema: this.schemaId,
        field,
        patch: { nodes: patches },
      },
      role
    );
    return result;
  }

  private commitSetMutation<TResult>(
    field: string,
    mutate: (crdt: CRSet<any>) => TResult
  ) {
    const state = this.fields.get(field) as FieldState;
    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    this.assertWritable(field, role);
    const shadow = this.shadowFor(field, state) as CRSet<any>;
    const { patches, result } = this.capturePatches(
      (listener) => shadow.onChange(listener),
      () => mutate(shadow)
    );
    if (patches.length === 0) return result;
    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "set.patch",
        schema: this.schemaId,
        field,
        patch: { nodes: patches },
      },
      role
    );
    return result;
  }

  private commitMapMutation<TResult>(
    field: string,
    mutate: (crdt: CRMap<any, any>) => TResult
  ) {
    const state = this.fields.get(field) as FieldState;
    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    this.assertWritable(field, role);
    const shadow = this.shadowFor(field, state) as CRMap<any, any>;
    const { patches, result } = this.capturePatches(
      (listener) => shadow.onChange(listener),
      () => mutate(shadow)
    );
    if (patches.length === 0) return result;
    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "map.patch",
        schema: this.schemaId,
        field,
        patch: { nodes: patches },
      },
      role
    );
    return result;
  }

  private commitRecordMutation<TResult>(
    field: string,
    mutate: (crdt: CRRecord<any>) => TResult
  ) {
    const state = this.fields.get(field) as FieldState;
    const stamp = this.clock.next();
    const role = this.aclLog.roleAt(this.actorId, stamp);
    this.assertWritable(field, role);
    const shadow = this.shadowFor(field, state) as CRRecord<any>;
    const { patches, result } = this.capturePatches(
      (listener) => shadow.onChange(listener),
      () => mutate(shadow)
    );
    if (patches.length === 0) return;
    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "record.patch",
        schema: this.schemaId,
        field,
        patch: { nodes: patches },
      },
      role
    );
    return result;
  }

  private capturePatches<TNode, TResult>(
    subscribe: (listener: (nodes: readonly TNode[]) => void) => () => void,
    mutate: () => TResult
  ): { patches: TNode[]; result: TResult } {
    const patches: TNode[] = [];
    const stop = subscribe((nodes) => patches.push(...nodes));
    let result: TResult;
    try {
      result = mutate();
    } finally {
      stop();
    }
    return { patches, result };
  }

  private queueLocalOp(payload: OpPayload, role: Role): void {
    if (!roleNeedsKey(role))
      throw new Error(`Dacument: role '${role}' cannot sign ops`);
    if (!this.roleKey) throw new Error("Dacument: missing role private key");
    const header = { alg: "ES256", typ: TOKEN_TYP, kid: `${payload.iss}:${role}` } as const;

    const promise = signToken(this.roleKey, header, payload)
      .then((token) => {
        const op = { token };
        this.emitEvent("change", { type: "change", ops: [op] });
      })
      .catch((error) =>
        this.emitError(error instanceof Error ? error : new Error(String(error)))
      );

    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }

  private applyRemotePayload(payload: OpPayload, signerRole: Role): boolean {
    this.clock.observe(payload.stamp);

    if (payload.kind === "ack") {
      if (!isAckPatch(payload.patch)) return false;
      this.ackByActor.set(payload.iss, payload.patch.seen);
      return true;
    }

    if (payload.kind === "acl.set") {
      return this.applyAclPayload(payload, signerRole);
    }

    if (!payload.field) return false;
    const state = this.fields.get(payload.field);
    if (!state) return false;

    switch (payload.kind) {
      case "register.set":
        return this.applyRegisterPayload(payload, state);
      case "text.patch":
      case "array.patch":
      case "set.patch":
      case "map.patch":
      case "record.patch":
        return this.applyNodePayload(payload, state);
      default:
        return false;
    }
  }

  private applyAclPayload(payload: OpPayload, signerRole: Role): boolean {
    if (!isAclPatch(payload.patch)) return false;
    const patch = payload.patch;
    if (!this.canWriteAcl(signerRole, patch.role)) return false;

    const assignment: AclAssignment = {
      id: patch.id,
      actorId: patch.target,
      role: patch.role,
      stamp: payload.stamp,
      by: payload.iss,
    };

    const accepted = this.aclLog.merge(assignment);
    if (accepted.length) return true;
    return false;
  }

  private applyRegisterPayload(payload: OpPayload, state: FieldState): boolean {
    if (!isObject(payload.patch)) return false;
    if (!("value" in payload.patch)) return false;
    const value = (payload.patch as { value: unknown }).value;
    const schema = state.schema;
    if (schema.crdt !== "register") return false;
    if (!isValueOfType(value, schema.jsType)) return false;
    if (schema.regex && typeof value === "string" && !schema.regex.test(value))
      return false;

    const crdt = state.crdt as CRRegister<any>;
    const before = crdt.get();
    crdt.set(value as any, payload.stamp);
    const after = crdt.get();
    if (Object.is(before, after)) return true;
    this.emitMerge(payload.iss, payload.field as string, "set", { value: after });
    return true;
  }

  private applyNodePayload(payload: OpPayload, state: FieldState): boolean {
    if (!isPatchEnvelope(payload.patch)) return false;
    const nodes = payload.patch.nodes;

    switch (state.schema.crdt) {
      case "text":
      case "array": {
        const typedNodes = nodes.filter(isDagNode);
        if (typedNodes.length !== nodes.length) return false;
        if (!this.validateDagNodeValues(typedNodes, state.schema.jsType)) return false;
        const crdt = state.crdt as CRText<any> | CRArray<any>;
        const beforeNodes = crdt.snapshot() as Array<{
          id: string;
          value: unknown;
          deleted?: boolean;
        }>;
        const beforeIndex = indexMapForNodes(beforeNodes);
        const changed = crdt.merge(typedNodes as any) as Array<{
          id: string;
          value: unknown;
          deleted?: boolean;
        }>;
        if (changed.length === 0) return true;
        const afterNodes = crdt.snapshot() as Array<{
          id: string;
          value: unknown;
          deleted?: boolean;
        }>;
        const afterIndex = indexMapForNodes(afterNodes);
        const beforeLength = beforeNodes.filter((node) => !node.deleted).length;
        this.emitListOps(
          payload.iss,
          payload.field as string,
          state.schema.crdt,
          changed,
          beforeIndex,
          afterIndex,
          beforeLength
        );
        return true;
      }
      case "set":
        return this.applySetNodes(nodes, state, payload.field as string, payload.iss);
      case "map":
        return this.applyMapNodes(nodes, state, payload.field as string, payload.iss);
      case "record":
        return this.applyRecordNodes(nodes, state, payload.field as string, payload.iss);
      default:
        return false;
    }
  }

  private applySetNodes(
    nodes: unknown[],
    state: FieldState,
    field: string,
    actor: string
  ): boolean {
    const crdt = state.crdt as CRSet<any>;
    for (const node of nodes) {
      if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
        return false;
      if (node.op === "add") {
        if (!isValueOfType(node.value, state.schema.jsType)) return false;
        if (typeof node.key !== "string") return false;
      } else if (node.op === "rem") {
        if (typeof node.key !== "string" || !isStringArray(node.targets)) return false;
      } else {
        return false;
      }
    }
    const before = [...crdt.values()];
    const accepted = crdt.merge(nodes as any);
    if (accepted.length === 0) return true;
    const after = [...crdt.values()];
    const { added, removed } = this.diffSet(before, after);
    for (const value of added)
      this.emitMerge(actor, field, "add", { value });
    for (const value of removed)
      this.emitMerge(actor, field, "delete", { value });
    return true;
  }

  private applyMapNodes(
    nodes: unknown[],
    state: FieldState,
    field: string,
    actor: string
  ): boolean {
    const crdt = state.crdt as CRMap<any, any>;
    for (const node of nodes) {
      if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
        return false;
      if (node.op === "set") {
        if (!isValueOfType(node.value, state.schema.jsType)) return false;
        if (!isJsValue(node.key)) return false;
        if (typeof node.keyId !== "string") return false;
      } else if (node.op === "del") {
        if (typeof node.keyId !== "string" || !isStringArray(node.targets)) return false;
      } else {
        return false;
      }
    }
    const before = this.mapValue(crdt);
    const accepted = crdt.merge(nodes as any);
    if (accepted.length === 0) return true;
    const after = this.mapValue(crdt);
    const { set, removed } = this.diffMap(before, after);
    for (const entry of set)
      this.emitMerge(actor, field, "set", entry);
    for (const key of removed)
      this.emitMerge(actor, field, "delete", { key });
    return true;
  }

  private applyRecordNodes(
    nodes: unknown[],
    state: FieldState,
    field: string,
    actor: string
  ): boolean {
    const crdt = state.crdt as CRRecord<any>;
    for (const node of nodes) {
      if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
        return false;
      if (node.op === "set") {
        if (typeof node.prop !== "string") return false;
        if (!isValueOfType(node.value, state.schema.jsType)) return false;
      } else if (node.op === "del") {
        if (typeof node.prop !== "string" || !isStringArray(node.targets)) return false;
      } else {
        return false;
      }
    }
    const before = this.recordValue(crdt);
    const accepted = crdt.merge(nodes as any);
    if (accepted.length === 0) return true;
    const after = this.recordValue(crdt);
    const { set, removed } = this.diffRecord(before, after);
    for (const [key, value] of Object.entries(set))
      this.emitMerge(actor, field, "set", { key, value });
    for (const key of removed)
      this.emitMerge(actor, field, "delete", { key });
    return true;
  }

  private validateDagNodeValues(
    nodes: Array<{ value: unknown }>,
    jsType: JsTypeName
  ): boolean {
    for (const node of nodes) {
      if (!isValueOfType(node.value, jsType)) return false;
    }
    return true;
  }

  private emitListOps(
    actor: string,
    field: string,
    crdt: "text" | "array",
    changed: Array<{ id: string; value: unknown; deleted?: boolean }>,
    beforeIndex: Map<string, number>,
    afterIndex: Map<string, number>,
    beforeLength: number
  ): void {
    const deletes: Array<{ type: "delete"; index: number; count: number }> = [];

    if (crdt === "text") {
      const inserts: Array<{ type: "insert"; index: number; value: string }> = [];
      for (const node of changed) {
        if (node.deleted) {
          const index = beforeIndex.get(node.id);
          if (index === undefined) continue;
          deletes.push({ type: "delete", index, count: 1 });
        } else {
          const index = afterIndex.get(node.id);
          if (index === undefined) continue;
          inserts.push({ type: "insert", index, value: String(node.value) });
        }
      }

      deletes.sort((a, b) => b.index - a.index);
      inserts.sort((a, b) => a.index - b.index);
      for (const op of deletes)
        this.emitMerge(actor, field, "deleteAt", { index: op.index });
      for (const op of inserts)
        this.emitMerge(actor, field, "insertAt", { index: op.index, value: op.value });
      return;
    }

    const inserts: Array<{ type: "insert"; index: number; value: unknown }> = [];
    for (const node of changed) {
      if (node.deleted) {
        const index = beforeIndex.get(node.id);
        if (index === undefined) continue;
        deletes.push({ type: "delete", index, count: 1 });
      } else {
        const index = afterIndex.get(node.id);
        if (index === undefined) continue;
        inserts.push({ type: "insert", index, value: node.value });
      }
    }

    deletes.sort((a, b) => b.index - a.index);
    inserts.sort((a, b) => a.index - b.index);
    for (const op of deletes) {
      if (op.index === 0) {
        this.emitMerge(actor, field, "shift", null);
        continue;
      }
      if (op.index === beforeLength - 1) {
        this.emitMerge(actor, field, "pop", null);
        continue;
      }
      this.emitMerge(actor, field, "deleteAt", { index: op.index });
    }
    for (const op of inserts) {
      if (op.index === 0) {
        this.emitMerge(actor, field, "unshift", { value: op.value });
        continue;
      }
      if (op.index >= beforeLength) {
        this.emitMerge(actor, field, "push", { value: op.value });
        continue;
      }
      this.emitMerge(actor, field, "insertAt", { index: op.index, value: op.value });
    }
  }

  private diffSet(
    before: unknown[],
    after: unknown[]
  ): { added: unknown[]; removed: unknown[] } {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((value) => !beforeSet.has(value));
    const removed = before.filter((value) => !afterSet.has(value));
    return { added, removed };
  }

  private diffMap(
    before: Array<[JsValue, unknown]>,
    after: Array<[JsValue, unknown]>
  ): { set: Array<{ key: JsValue; value: unknown }>; removed: JsValue[] } {
    const beforeMap = new Map<string, { key: JsValue; value: unknown }>();
    for (const [key, value] of before)
      beforeMap.set(stableKey(key), { key, value });

    const afterMap = new Map<string, { key: JsValue; value: unknown }>();
    for (const [key, value] of after)
      afterMap.set(stableKey(key), { key, value });

    const set: Array<{ key: JsValue; value: unknown }> = [];
    const removed: JsValue[] = [];

    for (const [keyId, entry] of afterMap) {
      const prev = beforeMap.get(keyId);
      if (!prev || !Object.is(prev.value, entry.value)) set.push(entry);
    }

    for (const [keyId, entry] of beforeMap) {
      if (!afterMap.has(keyId)) removed.push(entry.key);
    }

    return { set, removed };
  }

  private diffRecord(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): { set: Record<string, unknown>; removed: string[] } {
    const set: Record<string, unknown> = {};
    const removed: string[] = [];

    for (const [key, value] of Object.entries(after)) {
      if (!(key in before) || !Object.is(before[key], value)) set[key] = value;
    }

    for (const key of Object.keys(before)) {
      if (!(key in after)) removed.push(key);
    }

    return { set, removed };
  }

  private setRole(actorId: string, role: Role): void {
    const stamp = this.clock.next();
    const signerRole = this.aclLog.roleAt(this.actorId, stamp);
    if (!this.canWriteAcl(signerRole, role))
      throw new Error(`Dacument: role '${signerRole}' cannot grant '${role}'`);
    const assignmentId = uuidv7();

    this.queueLocalOp(
      {
        iss: this.actorId,
        sub: this.docId,
        iat: nowSeconds(),
        stamp,
        kind: "acl.set",
        schema: this.schemaId,
        patch: {
          id: assignmentId,
          target: actorId,
          role,
        },
      },
      signerRole
    );
  }

  private recordValue(record: CRRecord<any>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record as any)) output[key] = (record as any)[key];
    return output;
  }

  private mapValue(map: CRMap<any, any>): Array<[JsValue, unknown]> {
    const output: Array<[JsValue, unknown]> = [];
    for (const [key, value] of map.entries()) {
      if (!isJsValue(key))
        throw new Error("Dacument: map key must be JSON-compatible");
      output.push([key, value]);
    }
    return output;
  }

  private fieldValue(field: string): unknown {
    const state = this.fields.get(field);
    if (!state) return undefined;
    const crdt = this.readCrdt(field, state) as any;
    switch (state.schema.crdt) {
      case "register":
        return (crdt as CRRegister<any>).get();
      case "text":
        return (crdt as CRText<any>).toString();
      case "array":
        return [...(crdt as CRArray<any>)];
      case "set":
        return [...(crdt as CRSet<any>).values()];
      case "map":
        return this.mapValue(crdt as CRMap<any, any>);
      case "record":
        return this.recordValue(crdt as CRRecord<any>);
    }
  }

  private emitEvent<K extends keyof DacumentEventMap>(
    type: K,
    event: DacumentEventMap[K]
  ): void {
    const listeners = this.eventListeners.get(type);
    if (!listeners) return;
    for (const listener of listeners)
      listener(event as DacumentEventMap[keyof DacumentEventMap]);
  }

  private emitMerge(
    actor: string,
    target: string,
    method: string,
    data: unknown
  ): void {
    if (this.isRevoked()) return;
    this.emitEvent("merge", { type: "merge", actor, target, method, data });
  }

  private emitRevoked(previous: Role, payload: OpPayload): void {
    this.emitEvent("revoked", {
      type: "revoked",
      actorId: this.actorId,
      previous,
      by: payload.iss,
      stamp: payload.stamp,
    });
  }

  private emitError(error: Error): void {
    this.emitEvent("error", { type: "error", error });
  }

  private canWriteField(role: Role): boolean {
    return role === "owner" || role === "manager" || role === "editor";
  }

  private canWriteAcl(role: Role, targetRole: Role): boolean {
    if (role === "owner") return true;
    if (role === "manager")
      return targetRole === "editor" || targetRole === "viewer" || targetRole === "revoked";
    return false;
  }

  private assertWritable(field: string, role: Role): void {
    if (!this.canWriteField(role))
      throw new Error(`Dacument: role '${role}' cannot write '${field}'`);
  }

  private assertValueType(field: string, value: unknown): void {
    const state = this.fields.get(field);
    if (!state) throw new Error(`Dacument: unknown field '${field}'`);
    if (!isValueOfType(value, state.schema.jsType))
      throw new Error(`Dacument: invalid value for '${field}'`);
    const regex =
      state.schema.crdt === "register" ? state.schema.regex : undefined;
    if (regex && typeof value === "string" && !regex.test(value))
      throw new Error(`Dacument: '${field}' failed regex`);
  }

  private assertValueArray(field: string, values: unknown[]): void {
    for (const value of values) this.assertValueType(field, value);
  }

  private assertMapKey(field: string, key: unknown): void {
    if (!isJsValue(key))
      throw new Error(`Dacument: map key for '${field}' must be JSON-compatible`);
  }

  private isValidPayload(payload: OpPayload): boolean {
    if (!isObject(payload)) return false;
    if (typeof payload.iss !== "string" || typeof payload.sub !== "string") return false;
    if (typeof payload.iat !== "number") return false;
    if (!payload.stamp) return false;
    const stamp = payload.stamp as any;
    if (
      typeof stamp.wallTimeMs !== "number" ||
      typeof stamp.logical !== "number" ||
      typeof stamp.clockId !== "string"
    )
      return false;
    if (typeof payload.kind !== "string") return false;
    if (typeof payload.schema !== "string") return false;
    return true;
  }

  private resolveSignerRole(payload: OpPayload): Role | null {
    const role = this.aclLog.roleAt(payload.iss, payload.stamp);
    if (roleNeedsKey(role)) return role;
    if (
      this.aclLog.isEmpty() &&
      payload.kind === "acl.set" &&
      isAclPatch(payload.patch) &&
      payload.patch.role === "owner" &&
      payload.patch.target === payload.iss
    ) {
      return "owner";
    }
    return null;
  }

  private assertSchemaKeys(): void {
    const reserved = new Set([
      ...Object.getOwnPropertyNames(this),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(this)),
      "acl",
    ]);
    for (const key of Object.keys(this.schema)) {
      if (reserved.has(key)) throw new Error(`Dacument: schema key '${key}' is reserved`);
    }
  }
}

export type DacumentDoc<S extends SchemaDefinition> = Dacument<S> &
  DocFieldAccess<S>;

