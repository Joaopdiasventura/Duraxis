export class CommitOutcomeUnknownError extends Error {
  public readonly transactionId: string;

  public constructor(transactionId: string, cause: unknown) {
    super(
      `Commit outcome is unknown for transaction ${transactionId}` +
        (cause instanceof Error ? `: ${cause.message}` : ""),
      { cause },
    );

    this.name = "CommitOutcomeUnknownError";
    this.transactionId = transactionId;
  }
}
