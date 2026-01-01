import { JWT } from "quick-jwt";
import type { JWK } from "quick-jwt";

import { LIWRegister } from "../LIWRegister/class";

export type Identifier = string;

export type ReadRoles = "viewer" | "revoked";
export type WriteRoles = "owner" | "manager" | "editor";
export type Role = WriteRoles | ReadRoles;

export type GrantBody = {
  by: Identifier;
  from: Identifier;
  role: Role;
};

/** Brändätty JSON-string, joka *tarkoittaa* GrantBody:tä (runtime: string) */
export type JSONString<T> = string & { readonly __json?: T };

export type Grant = ReturnType<JWT["sign"]>;

export type ACLSnapshot = string;

export type ACLData = {
  grants: Record<Identifier, Grant>;
  publicKeys: Record<WriteRoles, JsonWebKey>;
};

export class ACLRegister {
  constructor(
    user: Identifier,
    rolePrivateKey: JWK,
    aclSnapshot: undefined | string = undefined
  ) {
    this.user = user;
    this.signingJwk = rolePrivateKey;
    this.list = aclSnapshot
      ? JSON.parse(aclSnapshot)
      : JWT.sign(rolePrivateKey, new JWT("immutable", user, user, Infinity));
  }
}
