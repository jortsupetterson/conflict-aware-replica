import { Bytes } from "bytecodec";
import { SigningAgent, VerificationAgent } from "zeyra";
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
        .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
        .join(",");
    return `{${body}}`;
}
function decodePart(part) {
    const bytes = Bytes.fromBase64UrlString(part);
    const json = Bytes.toString(bytes);
    return JSON.parse(json);
}
export async function signToken(privateJwk, header, payload) {
    const headerJson = stableStringify(header);
    const payloadJson = stableStringify(payload);
    const headerB64 = Bytes.toBase64UrlString(Bytes.fromString(headerJson));
    const payloadB64 = Bytes.toBase64UrlString(Bytes.fromString(payloadJson));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signer = new SigningAgent(privateJwk);
    const signature = await signer.sign(Bytes.fromString(signingInput));
    const signatureB64 = Bytes.toBase64UrlString(signature);
    return `${signingInput}.${signatureB64}`;
}
export function encodeToken(header, payload) {
    const headerJson = stableStringify(header);
    const payloadJson = stableStringify(payload);
    const headerB64 = Bytes.toBase64UrlString(Bytes.fromString(headerJson));
    const payloadB64 = Bytes.toBase64UrlString(Bytes.fromString(payloadJson));
    return `${headerB64}.${payloadB64}.`;
}
export function decodeToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    try {
        const header = decodePart(headerB64);
        const payload = decodePart(payloadB64);
        const signature = Bytes.fromBase64UrlString(signatureB64);
        return { header, payload, signature, headerB64, payloadB64 };
    }
    catch {
        return null;
    }
}
export async function verifyToken(publicJwk, token, expectedTyp) {
    const decoded = decodeToken(token);
    if (!decoded)
        return false;
    const { header, payload, signature, headerB64, payloadB64 } = decoded;
    if (header.alg !== "ES256" || header.typ !== expectedTyp)
        return false;
    const verifier = new VerificationAgent(publicJwk);
    const signingInput = Bytes.fromString(`${headerB64}.${payloadB64}`);
    const signatureBytes = new Uint8Array(signature);
    const ok = await verifier.verify(signingInput, signatureBytes.buffer);
    return ok ? { header, payload } : false;
}
