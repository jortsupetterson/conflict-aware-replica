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
import { array, map, record, register, set, text, isJsValue, isValueOfType, schemaIdInput, } from "./types.js";
const TOKEN_TYP = "DACOP";
function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function stableKey(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return `[${value.map((entry) => stableKey(entry)).join(",")}]`;
    if (typeof value === "object") {
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const body = entries
            .map(([key, val]) => `${JSON.stringify(key)}:${stableKey(val)}`)
            .join(",");
        return `{${body}}`;
    }
    return JSON.stringify(value);
}
function isDagNode(node) {
    if (!isObject(node))
        return false;
    if (typeof node.id !== "string")
        return false;
    if (!Array.isArray(node.after) || !node.after.every((id) => typeof id === "string"))
        return false;
    if (node.deleted !== undefined && typeof node.deleted !== "boolean")
        return false;
    return true;
}
function isAclPatch(value) {
    if (!isObject(value))
        return false;
    if (typeof value.id !== "string")
        return false;
    if (typeof value.target !== "string")
        return false;
    if (typeof value.role !== "string")
        return false;
    return true;
}
function isAckPatch(value) {
    if (!isObject(value))
        return false;
    if (!isObject(value.seen))
        return false;
    const seen = value.seen;
    return (typeof seen.wallTimeMs === "number" &&
        typeof seen.logical === "number" &&
        typeof seen.clockId === "string");
}
function isPatchEnvelope(value) {
    return isObject(value) && Array.isArray(value.nodes);
}
function indexMapForNodes(nodes) {
    const map = new Map();
    let aliveIndex = 0;
    for (const node of nodes) {
        map.set(node.id, aliveIndex);
        if (!node.deleted)
            aliveIndex += 1;
    }
    return map;
}
function createEmptyField(crdt) {
    switch (crdt.crdt) {
        case "register":
            return new CRRegister();
        case "text":
            return new CRText();
        case "array":
            return new CRArray();
        case "map":
            return new CRMap({ key: crdt.key });
        case "set":
            return new CRSet({ key: crdt.key });
        case "record":
            return new CRRecord();
    }
}
function roleNeedsKey(role) {
    return role === "owner" || role === "manager" || role === "editor";
}
async function generateRoleKeys() {
    const ownerPair = await generateSignPair();
    const managerPair = await generateSignPair();
    const editorPair = await generateSignPair();
    return {
        owner: { privateKey: ownerPair.signingJwk, publicKey: ownerPair.verificationJwk },
        manager: { privateKey: managerPair.signingJwk, publicKey: managerPair.verificationJwk },
        editor: { privateKey: editorPair.signingJwk, publicKey: editorPair.verificationJwk },
    };
}
function toPublicRoleKeys(roleKeys) {
    return {
        owner: roleKeys.owner.publicKey,
        manager: roleKeys.manager.publicKey,
        editor: roleKeys.editor.publicKey,
    };
}
export class Dacument {
    static schema = (schema) => schema;
    static register = register;
    static text = text;
    static array = array;
    static set = set;
    static map = map;
    static record = record;
    static generateId() {
        return generateNonce();
    }
    static async computeSchemaId(schema) {
        const normalized = schemaIdInput(schema);
        const sortedKeys = Object.keys(normalized).sort();
        const ordered = {};
        for (const key of sortedKeys)
            ordered[key] = normalized[key];
        const json = JSON.stringify(ordered);
        const data = new Uint8Array(Bytes.fromString(json));
        const digest = await crypto.subtle.digest("SHA-256", data);
        return Bytes.toBase64UrlString(new Uint8Array(digest));
    }
    static async create(params) {
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
        };
        const ops = [];
        const capturePatches = (subscribe, mutate) => {
            const patches = [];
            const stop = subscribe((nodes) => patches.push(...nodes));
            try {
                mutate();
            }
            finally {
                stop();
            }
            return patches;
        };
        const sign = async (payload) => {
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
                if (schema.initial === undefined)
                    continue;
                if (!isValueOfType(schema.initial, schema.jsType))
                    throw new Error(`Dacument.create: invalid initial value for '${field}'`);
                if (schema.regex &&
                    typeof schema.initial === "string" &&
                    !schema.regex.test(schema.initial))
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
                if (!initial)
                    continue;
                const crdt = new CRText();
                const nodes = capturePatches((listener) => crdt.onChange(listener), () => {
                    for (const char of initial)
                        crdt.insertAt(crdt.length, char);
                });
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
                if (initial.length === 0)
                    continue;
                for (const value of initial) {
                    if (!isValueOfType(value, schema.jsType))
                        throw new Error(`Dacument.create: invalid initial value for '${field}'`);
                }
                const crdt = new CRArray();
                const nodes = capturePatches((listener) => crdt.onChange(listener), () => {
                    crdt.push(...initial);
                });
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
                if (initial.length === 0)
                    continue;
                for (const value of initial) {
                    if (!isValueOfType(value, schema.jsType))
                        throw new Error(`Dacument.create: invalid initial value for '${field}'`);
                }
                const crdt = new CRSet({
                    key: schema.key,
                });
                const nodes = capturePatches((listener) => crdt.onChange(listener), () => {
                    for (const value of initial)
                        crdt.add(value);
                });
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
                if (initial.length === 0)
                    continue;
                for (const entry of initial) {
                    if (!Array.isArray(entry) || entry.length !== 2)
                        throw new Error(`Dacument.create: invalid initial entry for '${field}'`);
                    const [key, value] = entry;
                    if (!isJsValue(key))
                        throw new Error(`Dacument.create: map key for '${field}' must be JSON-compatible`);
                    if (!isValueOfType(value, schema.jsType))
                        throw new Error(`Dacument.create: invalid initial value for '${field}'`);
                }
                const crdt = new CRMap({
                    key: schema.key,
                });
                const nodes = capturePatches((listener) => crdt.onChange(listener), () => {
                    for (const [key, value] of initial)
                        crdt.set(key, value);
                });
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
                if (props.length === 0)
                    continue;
                for (const prop of props) {
                    const value = initial[prop];
                    if (!isValueOfType(value, schema.jsType))
                        throw new Error(`Dacument.create: invalid initial value for '${field}'`);
                }
                const crdt = new CRRecord();
                const nodes = capturePatches((listener) => crdt.onChange(listener), () => {
                    for (const prop of props)
                        crdt[prop] = initial[prop];
                });
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
        const snapshot = {
            docId,
            roleKeys: publicKeys,
            ops,
        };
        return { docId, schemaId, roleKeys, snapshot };
    }
    static async load(params) {
        const schemaId = await Dacument.computeSchemaId(params.schema);
        const doc = new Dacument({
            schema: params.schema,
            schemaId,
            docId: params.snapshot.docId,
            actorId: params.actorId,
            roleKey: params.roleKey,
            roleKeys: params.snapshot.roleKeys,
        });
        const result = await doc.merge(params.snapshot.ops);
        if (result.rejected)
            throw new Error("Dacument.load: snapshot contains invalid ops");
        return doc;
    }
    docId;
    actorId;
    schema;
    schemaId;
    fields = new Map();
    aclLog = new AclLog();
    clock;
    roleKey;
    roleKeys;
    opLog = [];
    opTokens = new Set();
    currentRole;
    revokedCrdtByField = new Map();
    eventListeners = new Map();
    pending = new Set();
    ackByActor = new Map();
    acl;
    constructor(params) {
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
                if (property in target)
                    return Reflect.get(target, property, receiver);
                if (!target.fields.has(property))
                    return undefined;
                const field = target.fields.get(property);
                if (field.schema.crdt === "register") {
                    const crdt = target.readCrdt(property, field);
                    return crdt.get();
                }
                if (!field.view)
                    field.view = target.createFieldView(property, field);
                return field.view;
            },
            set: (target, property, value, receiver) => {
                if (typeof property !== "string")
                    return Reflect.set(target, property, value, receiver);
                if (property in target)
                    return Reflect.set(target, property, value, receiver);
                const field = target.fields.get(property);
                if (!field)
                    throw new Error(`Dacument: unknown field '${property}'`);
                if (field.schema.crdt !== "register")
                    throw new Error(`Dacument: field '${property}' is read-only`);
                target.setRegisterValue(property, value);
                return true;
            },
            has: (target, property) => {
                if (typeof property !== "string")
                    return Reflect.has(target, property);
                if (property in target)
                    return true;
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
        });
    }
    addEventListener(type, listener) {
        const listeners = this.eventListeners.get(type) ??
            new Set();
        listeners.add(listener);
        this.eventListeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
        const listeners = this.eventListeners.get(type);
        if (!listeners)
            return;
        listeners.delete(listener);
        if (listeners.size === 0)
            this.eventListeners.delete(type);
    }
    onChange(listener) {
        const handler = (event) => listener(event.ops);
        this.addEventListener("change", handler);
        return () => this.removeEventListener("change", handler);
    }
    onFieldChange(field, listener) {
        const handler = (event) => {
            if (event.target === field)
                listener(this.fieldValue(field));
        };
        this.addEventListener("merge", handler);
        return () => this.removeEventListener("merge", handler);
    }
    onAnyFieldChange(listener) {
        const handler = (event) => listener(event.target, this.fieldValue(event.target));
        this.addEventListener("merge", handler);
        return () => this.removeEventListener("merge", handler);
    }
    onError(listener) {
        const handler = (event) => listener(event.error);
        this.addEventListener("error", handler);
        return () => this.removeEventListener("error", handler);
    }
    onRevoked(listener) {
        const handler = (event) => listener(event);
        this.addEventListener("revoked", handler);
        return () => this.removeEventListener("revoked", handler);
    }
    async flush() {
        await Promise.all([...this.pending]);
    }
    snapshot() {
        if (this.isRevoked())
            throw new Error("Dacument: revoked actors cannot snapshot");
        return {
            docId: this.docId,
            roleKeys: this.roleKeys,
            ops: this.opLog.slice(),
        };
    }
    async merge(input) {
        const tokens = Array.isArray(input) ? input : [input];
        const decodedOps = [];
        const accepted = [];
        let rejected = 0;
        for (const item of tokens) {
            const token = typeof item === "string" ? item : item.token;
            const decoded = decodeToken(token);
            if (!decoded) {
                rejected++;
                continue;
            }
            const payload = decoded.payload;
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
            if (cmp !== 0)
                return cmp;
            if (left.token === right.token)
                return 0;
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
    ack() {
        const stamp = this.clock.next();
        const role = this.aclLog.roleAt(this.actorId, stamp);
        const seen = this.clock.current;
        this.ackByActor.set(this.actorId, seen);
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "ack",
            schema: this.schemaId,
            patch: { seen },
        }, role);
    }
    setRegisterValue(field, value) {
        const state = this.fields.get(field);
        if (!state)
            throw new Error(`Dacument: unknown field '${field}'`);
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
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "register.set",
            schema: this.schemaId,
            field,
            patch: { value },
        }, role);
    }
    createFieldView(field, state) {
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
    shadowFor(field, state) {
        const snapshot = state.crdt.snapshot?.();
        const cloned = snapshot ? structuredClone(snapshot) : undefined;
        switch (state.schema.crdt) {
            case "text":
                return new CRText(cloned);
            case "array":
                return new CRArray(cloned);
            case "set":
                return new CRSet({
                    snapshot: cloned,
                    key: state.schema.key,
                });
            case "map":
                return new CRMap({
                    snapshot: cloned,
                    key: state.schema.key,
                });
            case "record":
                return new CRRecord(cloned);
            case "register": {
                const reg = new CRRegister();
                if (cloned && Array.isArray(cloned))
                    reg.merge(cloned);
                return reg;
            }
            default:
                throw new Error(`Dacument: unknown field '${field}'`);
        }
    }
    isRevoked() {
        return this.currentRole === "revoked";
    }
    readCrdt(field, state) {
        if (!this.isRevoked())
            return state.crdt;
        return this.revokedCrdt(field, state);
    }
    revokedCrdt(field, state) {
        const existing = this.revokedCrdtByField.get(field);
        if (existing)
            return existing;
        const schema = state.schema;
        let crdt;
        switch (schema.crdt) {
            case "register": {
                const reg = new CRRegister();
                if (schema.initial !== undefined)
                    reg.set(schema.initial);
                crdt = reg;
                break;
            }
            case "text": {
                const text = new CRText();
                const initial = typeof schema.initial === "string" ? schema.initial : "";
                for (const char of initial)
                    text.insertAt(text.length, char);
                crdt = text;
                break;
            }
            case "array": {
                const arr = new CRArray();
                const initial = Array.isArray(schema.initial) ? schema.initial : [];
                if (initial.length)
                    arr.push(...initial);
                crdt = arr;
                break;
            }
            case "set": {
                const setCrdt = new CRSet({
                    key: schema.key,
                });
                const initial = Array.isArray(schema.initial) ? schema.initial : [];
                for (const value of initial)
                    setCrdt.add(value);
                crdt = setCrdt;
                break;
            }
            case "map": {
                const mapCrdt = new CRMap({
                    key: schema.key,
                });
                const initial = Array.isArray(schema.initial) ? schema.initial : [];
                for (const entry of initial) {
                    if (!Array.isArray(entry) || entry.length !== 2)
                        continue;
                    const [key, value] = entry;
                    mapCrdt.set(key, value);
                }
                crdt = mapCrdt;
                break;
            }
            case "record": {
                const recordCrdt = new CRRecord();
                const initial = schema.initial && isObject(schema.initial) && !Array.isArray(schema.initial)
                    ? schema.initial
                    : {};
                for (const [prop, value] of Object.entries(initial))
                    recordCrdt[prop] = value;
                crdt = recordCrdt;
                break;
            }
            default:
                throw new Error(`Dacument: unknown field '${field}'`);
        }
        this.revokedCrdtByField.set(field, crdt);
        return crdt;
    }
    createTextView(field, state) {
        const doc = this;
        const readCrdt = () => doc.readCrdt(field, state);
        return {
            get length() {
                return readCrdt().length;
            },
            toString() {
                return readCrdt().toString();
            },
            at(index) {
                return readCrdt().at(index);
            },
            insertAt(index, value) {
                doc.assertValueType(field, value);
                const stamp = doc.clock.next();
                const role = doc.aclLog.roleAt(doc.actorId, stamp);
                doc.assertWritable(field, role);
                const shadow = doc.shadowFor(field, state);
                const { patches, result } = doc.capturePatches((listener) => shadow.onChange(listener), () => shadow.insertAt(index, value));
                if (patches.length === 0)
                    return result;
                doc.queueLocalOp({
                    iss: doc.actorId,
                    sub: doc.docId,
                    iat: nowSeconds(),
                    stamp,
                    kind: "text.patch",
                    schema: doc.schemaId,
                    field,
                    patch: { nodes: patches },
                }, role);
                return result;
            },
            deleteAt(index) {
                const stamp = doc.clock.next();
                const role = doc.aclLog.roleAt(doc.actorId, stamp);
                doc.assertWritable(field, role);
                const shadow = doc.shadowFor(field, state);
                const { patches, result } = doc.capturePatches((listener) => shadow.onChange(listener), () => shadow.deleteAt(index));
                if (patches.length === 0)
                    return result;
                doc.queueLocalOp({
                    iss: doc.actorId,
                    sub: doc.docId,
                    iat: nowSeconds(),
                    stamp,
                    kind: "text.patch",
                    schema: doc.schemaId,
                    field,
                    patch: { nodes: patches },
                }, role);
                return result;
            },
            onChange(listener) {
                return doc.onFieldChange(field, listener);
            },
            [Symbol.iterator]() {
                return readCrdt().toString()[Symbol.iterator]();
            },
        };
    }
    createArrayView(field, state) {
        const doc = this;
        const readCrdt = () => doc.readCrdt(field, state);
        return {
            get length() {
                return readCrdt().length;
            },
            at(index) {
                return readCrdt().at(index);
            },
            slice(start, end) {
                return readCrdt().slice(start, end);
            },
            push(...items) {
                doc.assertValueArray(field, items);
                return doc.commitArrayMutation(field, (shadow) => shadow.push(...items));
            },
            unshift(...items) {
                doc.assertValueArray(field, items);
                return doc.commitArrayMutation(field, (shadow) => shadow.unshift(...items));
            },
            pop() {
                return doc.commitArrayMutation(field, (shadow) => shadow.pop());
            },
            shift() {
                return doc.commitArrayMutation(field, (shadow) => shadow.shift());
            },
            setAt(index, value) {
                doc.assertValueType(field, value);
                return doc.commitArrayMutation(field, (shadow) => shadow.setAt(index, value));
            },
            map(callback, thisArg) {
                return readCrdt().map(callback, thisArg);
            },
            filter(callback, thisArg) {
                return readCrdt().filter(callback, thisArg);
            },
            reduce(callback, initialValue) {
                return readCrdt().reduce(callback, initialValue);
            },
            forEach(callback, thisArg) {
                return readCrdt().forEach(callback, thisArg);
            },
            includes(value) {
                return readCrdt().includes(value);
            },
            indexOf(value) {
                return readCrdt().indexOf(value);
            },
            onChange(listener) {
                return doc.onFieldChange(field, listener);
            },
            [Symbol.iterator]() {
                return readCrdt()[Symbol.iterator]();
            },
        };
    }
    createSetView(field, state) {
        const doc = this;
        const readCrdt = () => doc.readCrdt(field, state);
        return {
            get size() {
                return readCrdt().size;
            },
            add(value) {
                doc.assertValueType(field, value);
                return doc.commitSetMutation(field, (shadow) => shadow.add(value));
            },
            delete(value) {
                return doc.commitSetMutation(field, (shadow) => shadow.delete(value));
            },
            clear() {
                return doc.commitSetMutation(field, (shadow) => shadow.clear());
            },
            has(value) {
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
            forEach(callback, thisArg) {
                return readCrdt().forEach(callback, thisArg);
            },
            onChange(listener) {
                return doc.onFieldChange(field, listener);
            },
            [Symbol.iterator]() {
                return readCrdt()[Symbol.iterator]();
            },
            get [Symbol.toStringTag]() {
                return "CRSet";
            },
        };
    }
    createMapView(field, state) {
        const doc = this;
        const readCrdt = () => doc.readCrdt(field, state);
        return {
            get size() {
                return readCrdt().size;
            },
            get(key) {
                return readCrdt().get(key);
            },
            set(key, value) {
                doc.assertMapKey(field, key);
                doc.assertValueType(field, value);
                return doc.commitMapMutation(field, (shadow) => shadow.set(key, value));
            },
            has(key) {
                return readCrdt().has(key);
            },
            delete(key) {
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
            forEach(callback, thisArg) {
                return readCrdt().forEach(callback, thisArg);
            },
            onChange(listener) {
                return doc.onFieldChange(field, listener);
            },
            [Symbol.iterator]() {
                return readCrdt()[Symbol.iterator]();
            },
            get [Symbol.toStringTag]() {
                return "CRMap";
            },
        };
    }
    createRecordView(field, state) {
        const doc = this;
        const readCrdt = () => doc.readCrdt(field, state);
        return new Proxy({
            onChange(listener) {
                return doc.onFieldChange(field, listener);
            },
            keys() {
                return Object.keys(readCrdt());
            },
            toJSON() {
                return doc.recordValue(readCrdt());
            },
        }, {
            get: (target, prop, receiver) => {
                if (typeof prop !== "string")
                    return Reflect.get(target, prop, receiver);
                if (prop in target)
                    return Reflect.get(target, prop, receiver);
                return readCrdt()[prop];
            },
            set: (_target, prop, value) => {
                if (typeof prop !== "string")
                    return false;
                doc.assertValueType(field, value);
                doc.commitRecordMutation(field, (shadow) => {
                    shadow[prop] = value;
                });
                return true;
            },
            deleteProperty: (_target, prop) => {
                if (typeof prop !== "string")
                    return false;
                doc.commitRecordMutation(field, (shadow) => {
                    delete shadow[prop];
                });
                return true;
            },
            has: (_target, prop) => {
                if (typeof prop !== "string")
                    return false;
                return prop in readCrdt();
            },
            ownKeys: () => Object.keys(readCrdt()),
            getOwnPropertyDescriptor: (_target, prop) => {
                if (typeof prop !== "string")
                    return undefined;
                if (prop in readCrdt())
                    return { enumerable: true, configurable: true };
                return undefined;
            },
        });
    }
    commitArrayMutation(field, mutate) {
        const state = this.fields.get(field);
        const stamp = this.clock.next();
        const role = this.aclLog.roleAt(this.actorId, stamp);
        this.assertWritable(field, role);
        const shadow = this.shadowFor(field, state);
        const { patches, result } = this.capturePatches((listener) => shadow.onChange(listener), () => mutate(shadow));
        if (patches.length === 0)
            return result;
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "array.patch",
            schema: this.schemaId,
            field,
            patch: { nodes: patches },
        }, role);
        return result;
    }
    commitSetMutation(field, mutate) {
        const state = this.fields.get(field);
        const stamp = this.clock.next();
        const role = this.aclLog.roleAt(this.actorId, stamp);
        this.assertWritable(field, role);
        const shadow = this.shadowFor(field, state);
        const { patches, result } = this.capturePatches((listener) => shadow.onChange(listener), () => mutate(shadow));
        if (patches.length === 0)
            return result;
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "set.patch",
            schema: this.schemaId,
            field,
            patch: { nodes: patches },
        }, role);
        return result;
    }
    commitMapMutation(field, mutate) {
        const state = this.fields.get(field);
        const stamp = this.clock.next();
        const role = this.aclLog.roleAt(this.actorId, stamp);
        this.assertWritable(field, role);
        const shadow = this.shadowFor(field, state);
        const { patches, result } = this.capturePatches((listener) => shadow.onChange(listener), () => mutate(shadow));
        if (patches.length === 0)
            return result;
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "map.patch",
            schema: this.schemaId,
            field,
            patch: { nodes: patches },
        }, role);
        return result;
    }
    commitRecordMutation(field, mutate) {
        const state = this.fields.get(field);
        const stamp = this.clock.next();
        const role = this.aclLog.roleAt(this.actorId, stamp);
        this.assertWritable(field, role);
        const shadow = this.shadowFor(field, state);
        const { patches, result } = this.capturePatches((listener) => shadow.onChange(listener), () => mutate(shadow));
        if (patches.length === 0)
            return;
        this.queueLocalOp({
            iss: this.actorId,
            sub: this.docId,
            iat: nowSeconds(),
            stamp,
            kind: "record.patch",
            schema: this.schemaId,
            field,
            patch: { nodes: patches },
        }, role);
        return result;
    }
    capturePatches(subscribe, mutate) {
        const patches = [];
        const stop = subscribe((nodes) => patches.push(...nodes));
        let result;
        try {
            result = mutate();
        }
        finally {
            stop();
        }
        return { patches, result };
    }
    queueLocalOp(payload, role) {
        if (!roleNeedsKey(role))
            throw new Error(`Dacument: role '${role}' cannot sign ops`);
        if (!this.roleKey)
            throw new Error("Dacument: missing role private key");
        const header = { alg: "ES256", typ: TOKEN_TYP, kid: `${payload.iss}:${role}` };
        const promise = signToken(this.roleKey, header, payload)
            .then((token) => {
            const op = { token };
            this.emitEvent("change", { type: "change", ops: [op] });
        })
            .catch((error) => this.emitError(error instanceof Error ? error : new Error(String(error))));
        this.pending.add(promise);
        promise.finally(() => this.pending.delete(promise));
    }
    applyRemotePayload(payload, signerRole) {
        this.clock.observe(payload.stamp);
        if (payload.kind === "ack") {
            if (!isAckPatch(payload.patch))
                return false;
            this.ackByActor.set(payload.iss, payload.patch.seen);
            return true;
        }
        if (payload.kind === "acl.set") {
            return this.applyAclPayload(payload, signerRole);
        }
        if (!payload.field)
            return false;
        const state = this.fields.get(payload.field);
        if (!state)
            return false;
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
    applyAclPayload(payload, signerRole) {
        if (!isAclPatch(payload.patch))
            return false;
        const patch = payload.patch;
        if (!this.canWriteAcl(signerRole, patch.role))
            return false;
        const assignment = {
            id: patch.id,
            actorId: patch.target,
            role: patch.role,
            stamp: payload.stamp,
            by: payload.iss,
        };
        const accepted = this.aclLog.merge(assignment);
        if (accepted.length)
            return true;
        return false;
    }
    applyRegisterPayload(payload, state) {
        if (!isObject(payload.patch))
            return false;
        if (!("value" in payload.patch))
            return false;
        const value = payload.patch.value;
        const schema = state.schema;
        if (schema.crdt !== "register")
            return false;
        if (!isValueOfType(value, schema.jsType))
            return false;
        if (schema.regex && typeof value === "string" && !schema.regex.test(value))
            return false;
        const crdt = state.crdt;
        const before = crdt.get();
        crdt.set(value, payload.stamp);
        const after = crdt.get();
        if (Object.is(before, after))
            return true;
        this.emitMerge(payload.iss, payload.field, "set", { value: after });
        return true;
    }
    applyNodePayload(payload, state) {
        if (!isPatchEnvelope(payload.patch))
            return false;
        const nodes = payload.patch.nodes;
        switch (state.schema.crdt) {
            case "text":
            case "array": {
                const typedNodes = nodes.filter(isDagNode);
                if (typedNodes.length !== nodes.length)
                    return false;
                if (!this.validateDagNodeValues(typedNodes, state.schema.jsType))
                    return false;
                const crdt = state.crdt;
                const beforeNodes = crdt.snapshot();
                const beforeIndex = indexMapForNodes(beforeNodes);
                const changed = crdt.merge(typedNodes);
                if (changed.length === 0)
                    return true;
                const afterNodes = crdt.snapshot();
                const afterIndex = indexMapForNodes(afterNodes);
                const beforeLength = beforeNodes.filter((node) => !node.deleted).length;
                this.emitListOps(payload.iss, payload.field, state.schema.crdt, changed, beforeIndex, afterIndex, beforeLength);
                return true;
            }
            case "set":
                return this.applySetNodes(nodes, state, payload.field, payload.iss);
            case "map":
                return this.applyMapNodes(nodes, state, payload.field, payload.iss);
            case "record":
                return this.applyRecordNodes(nodes, state, payload.field, payload.iss);
            default:
                return false;
        }
    }
    applySetNodes(nodes, state, field, actor) {
        const crdt = state.crdt;
        for (const node of nodes) {
            if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
                return false;
            if (node.op === "add") {
                if (!isValueOfType(node.value, state.schema.jsType))
                    return false;
                if (typeof node.key !== "string")
                    return false;
            }
            else if (node.op === "rem") {
                if (typeof node.key !== "string" || !isStringArray(node.targets))
                    return false;
            }
            else {
                return false;
            }
        }
        const before = [...crdt.values()];
        const accepted = crdt.merge(nodes);
        if (accepted.length === 0)
            return true;
        const after = [...crdt.values()];
        const { added, removed } = this.diffSet(before, after);
        for (const value of added)
            this.emitMerge(actor, field, "add", { value });
        for (const value of removed)
            this.emitMerge(actor, field, "delete", { value });
        return true;
    }
    applyMapNodes(nodes, state, field, actor) {
        const crdt = state.crdt;
        for (const node of nodes) {
            if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
                return false;
            if (node.op === "set") {
                if (!isValueOfType(node.value, state.schema.jsType))
                    return false;
                if (!isJsValue(node.key))
                    return false;
                if (typeof node.keyId !== "string")
                    return false;
            }
            else if (node.op === "del") {
                if (typeof node.keyId !== "string" || !isStringArray(node.targets))
                    return false;
            }
            else {
                return false;
            }
        }
        const before = this.mapValue(crdt);
        const accepted = crdt.merge(nodes);
        if (accepted.length === 0)
            return true;
        const after = this.mapValue(crdt);
        const { set, removed } = this.diffMap(before, after);
        for (const entry of set)
            this.emitMerge(actor, field, "set", entry);
        for (const key of removed)
            this.emitMerge(actor, field, "delete", { key });
        return true;
    }
    applyRecordNodes(nodes, state, field, actor) {
        const crdt = state.crdt;
        for (const node of nodes) {
            if (!isObject(node) || typeof node.op !== "string" || typeof node.id !== "string")
                return false;
            if (node.op === "set") {
                if (typeof node.prop !== "string")
                    return false;
                if (!isValueOfType(node.value, state.schema.jsType))
                    return false;
            }
            else if (node.op === "del") {
                if (typeof node.prop !== "string" || !isStringArray(node.targets))
                    return false;
            }
            else {
                return false;
            }
        }
        const before = this.recordValue(crdt);
        const accepted = crdt.merge(nodes);
        if (accepted.length === 0)
            return true;
        const after = this.recordValue(crdt);
        const { set, removed } = this.diffRecord(before, after);
        for (const [key, value] of Object.entries(set))
            this.emitMerge(actor, field, "set", { key, value });
        for (const key of removed)
            this.emitMerge(actor, field, "delete", { key });
        return true;
    }
    validateDagNodeValues(nodes, jsType) {
        for (const node of nodes) {
            if (!isValueOfType(node.value, jsType))
                return false;
        }
        return true;
    }
    emitListOps(actor, field, crdt, changed, beforeIndex, afterIndex, beforeLength) {
        const deletes = [];
        if (crdt === "text") {
            const inserts = [];
            for (const node of changed) {
                if (node.deleted) {
                    const index = beforeIndex.get(node.id);
                    if (index === undefined)
                        continue;
                    deletes.push({ type: "delete", index, count: 1 });
                }
                else {
                    const index = afterIndex.get(node.id);
                    if (index === undefined)
                        continue;
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
        const inserts = [];
        for (const node of changed) {
            if (node.deleted) {
                const index = beforeIndex.get(node.id);
                if (index === undefined)
                    continue;
                deletes.push({ type: "delete", index, count: 1 });
            }
            else {
                const index = afterIndex.get(node.id);
                if (index === undefined)
                    continue;
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
    diffSet(before, after) {
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        const added = after.filter((value) => !beforeSet.has(value));
        const removed = before.filter((value) => !afterSet.has(value));
        return { added, removed };
    }
    diffMap(before, after) {
        const beforeMap = new Map();
        for (const [key, value] of before)
            beforeMap.set(stableKey(key), { key, value });
        const afterMap = new Map();
        for (const [key, value] of after)
            afterMap.set(stableKey(key), { key, value });
        const set = [];
        const removed = [];
        for (const [keyId, entry] of afterMap) {
            const prev = beforeMap.get(keyId);
            if (!prev || !Object.is(prev.value, entry.value))
                set.push(entry);
        }
        for (const [keyId, entry] of beforeMap) {
            if (!afterMap.has(keyId))
                removed.push(entry.key);
        }
        return { set, removed };
    }
    diffRecord(before, after) {
        const set = {};
        const removed = [];
        for (const [key, value] of Object.entries(after)) {
            if (!(key in before) || !Object.is(before[key], value))
                set[key] = value;
        }
        for (const key of Object.keys(before)) {
            if (!(key in after))
                removed.push(key);
        }
        return { set, removed };
    }
    setRole(actorId, role) {
        const stamp = this.clock.next();
        const signerRole = this.aclLog.roleAt(this.actorId, stamp);
        if (!this.canWriteAcl(signerRole, role))
            throw new Error(`Dacument: role '${signerRole}' cannot grant '${role}'`);
        const assignmentId = uuidv7();
        this.queueLocalOp({
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
        }, signerRole);
    }
    recordValue(record) {
        const output = {};
        for (const key of Object.keys(record))
            output[key] = record[key];
        return output;
    }
    mapValue(map) {
        const output = [];
        for (const [key, value] of map.entries()) {
            if (!isJsValue(key))
                throw new Error("Dacument: map key must be JSON-compatible");
            output.push([key, value]);
        }
        return output;
    }
    fieldValue(field) {
        const state = this.fields.get(field);
        if (!state)
            return undefined;
        const crdt = this.readCrdt(field, state);
        switch (state.schema.crdt) {
            case "register":
                return crdt.get();
            case "text":
                return crdt.toString();
            case "array":
                return [...crdt];
            case "set":
                return [...crdt.values()];
            case "map":
                return this.mapValue(crdt);
            case "record":
                return this.recordValue(crdt);
        }
    }
    emitEvent(type, event) {
        const listeners = this.eventListeners.get(type);
        if (!listeners)
            return;
        for (const listener of listeners)
            listener(event);
    }
    emitMerge(actor, target, method, data) {
        if (this.isRevoked())
            return;
        this.emitEvent("merge", { type: "merge", actor, target, method, data });
    }
    emitRevoked(previous, payload) {
        this.emitEvent("revoked", {
            type: "revoked",
            actorId: this.actorId,
            previous,
            by: payload.iss,
            stamp: payload.stamp,
        });
    }
    emitError(error) {
        this.emitEvent("error", { type: "error", error });
    }
    canWriteField(role) {
        return role === "owner" || role === "manager" || role === "editor";
    }
    canWriteAcl(role, targetRole) {
        if (role === "owner")
            return true;
        if (role === "manager")
            return targetRole === "editor" || targetRole === "viewer" || targetRole === "revoked";
        return false;
    }
    assertWritable(field, role) {
        if (!this.canWriteField(role))
            throw new Error(`Dacument: role '${role}' cannot write '${field}'`);
    }
    assertValueType(field, value) {
        const state = this.fields.get(field);
        if (!state)
            throw new Error(`Dacument: unknown field '${field}'`);
        if (!isValueOfType(value, state.schema.jsType))
            throw new Error(`Dacument: invalid value for '${field}'`);
        const regex = state.schema.crdt === "register" ? state.schema.regex : undefined;
        if (regex && typeof value === "string" && !regex.test(value))
            throw new Error(`Dacument: '${field}' failed regex`);
    }
    assertValueArray(field, values) {
        for (const value of values)
            this.assertValueType(field, value);
    }
    assertMapKey(field, key) {
        if (!isJsValue(key))
            throw new Error(`Dacument: map key for '${field}' must be JSON-compatible`);
    }
    isValidPayload(payload) {
        if (!isObject(payload))
            return false;
        if (typeof payload.iss !== "string" || typeof payload.sub !== "string")
            return false;
        if (typeof payload.iat !== "number")
            return false;
        if (!payload.stamp)
            return false;
        const stamp = payload.stamp;
        if (typeof stamp.wallTimeMs !== "number" ||
            typeof stamp.logical !== "number" ||
            typeof stamp.clockId !== "string")
            return false;
        if (typeof payload.kind !== "string")
            return false;
        if (typeof payload.schema !== "string")
            return false;
        return true;
    }
    resolveSignerRole(payload) {
        const role = this.aclLog.roleAt(payload.iss, payload.stamp);
        if (roleNeedsKey(role))
            return role;
        if (this.aclLog.isEmpty() &&
            payload.kind === "acl.set" &&
            isAclPatch(payload.patch) &&
            payload.patch.role === "owner" &&
            payload.patch.target === payload.iss) {
            return "owner";
        }
        return null;
    }
    assertSchemaKeys() {
        const reserved = new Set([
            ...Object.getOwnPropertyNames(this),
            ...Object.getOwnPropertyNames(Object.getPrototypeOf(this)),
            "acl",
        ]);
        for (const key of Object.keys(this.schema)) {
            if (reserved.has(key))
                throw new Error(`Dacument: schema key '${key}' is reserved`);
        }
    }
}
