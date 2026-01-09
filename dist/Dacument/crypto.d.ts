type Header = {
    alg: "ES256";
    typ: string;
    kid?: string;
};
type DecodedToken = {
    header: Header;
    payload: unknown;
    signature: Uint8Array;
    headerB64: string;
    payloadB64: string;
};
export declare function signToken(privateJwk: JsonWebKey, header: Header, payload: unknown): Promise<string>;
export declare function decodeToken(token: string): DecodedToken | null;
export declare function verifyToken(publicJwk: JsonWebKey, token: string, expectedTyp: string): Promise<{
    header: Header;
    payload: unknown;
} | false>;
export {};
