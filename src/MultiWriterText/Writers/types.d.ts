export type WriterIdentifier = string;

export type WriterOperationIdentifier = Readonly<{
  writerIdentifier: WriterIdentifier;
  sequenceNumber: number;
}>;

export type WriterOperationKey = `${string}:${number}`;

export type WritersSnapshot = Readonly<{
  entries: Readonly<
    Record<
      WriterIdentifier,
      Readonly<{
        addOperation: WriterOperationIdentifier;
        removeOperation: WriterOperationIdentifier | null;
      }>
    >
  >;

  order: ReadonlyArray<WriterIdentifier>;
}>;
