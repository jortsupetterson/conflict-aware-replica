import { LIWRegister } from "../LIWRegister/class";

export type CARField =
  | { type: "ORG"; snapshot: unknown }
  | { type: "LIW"; snapshot: ReturnType<LIWRegister["snapshot"]> }
  | { type: "MWS"; snapshot: unknown };

export type CARSnapshot = Record<string, CARField>;

type LIWData = {
  value: string | number | boolean;
  online: boolean;
  timestamp: number;
};

type ORGData = {
  grants: Record<string, Record<string, { read?: boolean; write?: boolean }>>;
};

export class CARHandler {
  #acl: ORGData["grants"] = {};

  [fieldName: string]: LIWRegister | unknown;

  constructor(user: string, snapshot: CARSnapshot) {
    for (const fieldName of Object.keys(snapshot)) {
      const field = snapshot[fieldName];

      switch (field.type) {
        case "ORG": {
          const parsed = field.snapshot as ORGData;
          this.#acl = parsed.grants ?? {};
          break;
        }

        case "LIW": {
          const parsed = JSON.parse(field.snapshot) as LIWData;
          const target = new LIWRegister(
            parsed.value,
            parsed.online,
            parsed.timestamp
          );

          const handler: ProxyHandler<LIWRegister> = {
            get: (currentTarget, propertyKey, receiver) => {
              if (String(propertyKey) === "value") {
                const allowRead = this.#acl[user]?.[fieldName]?.read === true;

                if (!allowRead) return false;
              }
              return Reflect.get(currentTarget, propertyKey, receiver);
            },
            set: (currentTarget, propertyKey, valueToSet, receiver) => {
              if (String(propertyKey) === "value") {
                const allowWrite = this.#acl[user]?.[fieldName]?.write === true;

                if (!allowWrite) return false;
              }

              return Reflect.set(
                currentTarget,
                propertyKey,
                valueToSet,
                receiver
              );
            },
            deleteProperty: () => false,
            defineProperty: () => false,
          };

          this[fieldName] = new Proxy(target, handler);
          break;
        }
      }
    }
  }
}
