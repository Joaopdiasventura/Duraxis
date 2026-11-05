export class TransactionConflictError extends Error {
  public constructor(public message = "Transaction conflict: snapshot is stale") {
    super(message);
    this.name = "TransactionConflictError";
  }
}
