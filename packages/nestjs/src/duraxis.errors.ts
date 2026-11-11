export class DuraxisNestError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DuplicateDuraxisConnectionError extends DuraxisNestError {
  public constructor(connectionName: string) {
    super(`Duraxis connection is configured more than once: ${connectionName}`);
  }
}
