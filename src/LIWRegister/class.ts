import { HLC } from "../HLC/class";

export type LIWPrimitive = string | number | boolean;

export type LIWSnapshot<T extends LIWPrimitive> =
  `{"value":${T},"online":${boolean},"timestamp":${number}}`;

export class LIWRegister<T extends LIWPrimitive> {
  public value: T;
  public online: boolean;
  public timestamp: number;

  public onconflict:
    | ((
        received: LIWRegister<T>,
        stored: LIWRegister<T>
      ) => Promise<LIWRegister<T>>)
    | undefined;

  public onresolved: ((resolved: LIWRegister<T>) => void) | undefined;

  constructor(
    value: T,
    online: boolean | undefined = undefined,
    timestamp: number | undefined = undefined
  ) {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.onLine !== "boolean"
    ) {
      throw new Error(
        "{LIWRegister} Requires a UI environment with navigator.onLine available"
      );
    }

    this.value = value;
    this.online = online ?? navigator.onLine;
    this.timestamp = timestamp ?? Date.now();
    this.onconflict = undefined;
    this.onresolved = undefined;
  }

  async resolveIntent(
    snapshot: ReturnType<LIWRegister<T>["snapshot"]>
  ): Promise<void> {
    const parsed = JSON.parse(snapshot) as {
      value: T;
      online: boolean;
      timestamp: number;
    };

    const received = new LIWRegister<T>(
      parsed.value,
      parsed.online,
      parsed.timestamp
    );

    const onresolved = this.onresolved;
    if (typeof onresolved !== "function") {
      throw new Error("{LIWRegister} Missing onresolved handler");
    }

    if (typeof received.value !== typeof this.value) {
      throw new Error("{LIWRegister} Incompatible values");
    }

    if (received.online && received.timestamp <= this.timestamp) {
      const onconflict = this.onconflict;
      if (typeof onconflict !== "function") {
        throw new Error("{LIWRegister} Missing onconflict handler");
      }

      const merged = await onconflict(received, this);
      if (!(merged instanceof LIWRegister)) {
        throw new Error("{LIWRegister} onconflict must return LIWRegister");
      }

      onresolved(merged);
      return;
    }

    if (!received.online && received.timestamp <= this.timestamp) {
      onresolved(this);
      return;
    }

    onresolved(received);
  }

  snapshot(): LIWSnapshot<T> {
    return JSON.stringify({
      value: this.value,
      online: this.online,
      timestamp: this.timestamp,
    }) as LIWSnapshot<T>;
  }
}
