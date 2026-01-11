type SignedHeader = {
    alg: "ES256";
    typ: string;
    kid?: string;
};
type UnsignedHeader = {
    alg: "none";
    typ: string;
    kid?: string;
};
type Header = SignedHeader | UnsignedHeader;
type DecodedToken = {
    header: Header;
    payload: unknown;
    signature: Uint8Array;
    headerB64: string;
    payloadB64: string;
};
export declare function signToken(privateJwk: JsonWebKey, header: SignedHeader, payload: unknown): Promise<string>;
export declare function encodeToken(header: UnsignedHeader, payload: unknown): string;
export declare function decodeToken(token: string): DecodedToken | null;
export declare function verifyToken(publicJwk: JsonWebKey, token: string, expectedTyp: string): Promise<{
    header: SignedHeader;
    payload: unknown;
} | false>;
export declare function validateActorKeyPair(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Promise<void>;
export declare function signDetached(privateJwk: JsonWebKey, payload: string): Promise<string>;
export declare function verifyDetached(publicJwk: JsonWebKey, payload: string, signatureB64: string): Promise<boolean>;
export {};
