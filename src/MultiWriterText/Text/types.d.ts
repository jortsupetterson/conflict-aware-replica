import type { WriterIdentifier } from "../Writers/types.d.ts";

export type OperationIdentifier = Readonly<{
  writerIdentifier: WriterIdentifier;
  sequenceNumber: number;
}>;

export type OperationKey = `${string}:${number}`;

export type TextSnapshot = Readonly<{
  rootOperation: OperationIdentifier;
  headOperation: OperationIdentifier;

  entries: Readonly<
    Record<
      OperationKey,
      Readonly<{
        previousOperation: OperationKey;
        character: string;
      }>
    >
  >;

  order: Readonly<Record<OperationKey, ReadonlyArray<OperationKey>>>;

  tombstones: ReadonlyArray<OperationKey>;

  acks: Readonly<
    Record<
      WriterIdentifier,
      Readonly<{
        position: OperationIdentifier;
        operation: OperationIdentifier;
      }>
    >
  >;
}>;
