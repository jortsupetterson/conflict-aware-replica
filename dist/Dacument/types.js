export function isJsValue(value) {
    if (value === null)
        return true;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "boolean")
        return true;
    if (valueType === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsValue);
    if (valueType === "object") {
        for (const entry of Object.values(value)) {
            if (!isJsValue(entry))
                return false;
        }
        return true;
    }
    return false;
}
export function isValueOfType(value, jsType) {
    if (jsType === "any")
        return true;
    if (jsType === "json")
        return isJsValue(value);
    return typeof value === jsType;
}
export function schemaIdInput(schema) {
    const normalized = {};
    for (const [key, field] of Object.entries(schema)) {
        normalized[key] = {
            crdt: field.crdt,
            jsType: field.jsType,
            regex: field.crdt === "register" && field.regex
                ? field.regex.source + "/" + field.regex.flags
                : undefined,
        };
    }
    return normalized;
}
export function register(options = {}) {
    return {
        crdt: "register",
        jsType: options.jsType ?? "any",
        regex: options.regex,
        initial: options.initial,
    };
}
export function text(options = {}) {
    return { crdt: "text", jsType: "string", initial: options.initial ?? "" };
}
export function array(options) {
    return {
        crdt: "array",
        jsType: options.jsType,
        initial: options.initial ?? [],
        key: options.key,
    };
}
export function set(options) {
    return {
        crdt: "set",
        jsType: options.jsType,
        initial: options.initial ?? [],
        key: options.key,
    };
}
export function map(options) {
    return {
        crdt: "map",
        jsType: options.jsType,
        initial: options.initial ?? [],
        key: options.key,
    };
}
export function record(options) {
    return {
        crdt: "record",
        jsType: options.jsType,
        initial: options.initial ?? {},
    };
}
