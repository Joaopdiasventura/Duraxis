export class TransactionStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TransactionStateError";
  }
}
