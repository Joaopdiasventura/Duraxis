export class ForeignKeyViolationError extends Error {
  public constructor(
    message: string,
    public readonly collection: string,
    public readonly constraint: string,
    public readonly reference: string,
  ) {
    super(message);
    this.name = "ForeignKeyViolationError";
  }
}

export class ReferencedRecordNotFoundError extends ForeignKeyViolationError {
  public constructor(collection: string, constraint: string, reference: string) {
    super(
      `Referenced record not found for ${collection}/${constraint}: ${reference}`,
      collection,
      constraint,
      reference,
    );
    this.name = "ReferencedRecordNotFoundError";
  }
}

export class ReferencedRecordRestrictedError extends ForeignKeyViolationError {
  public constructor(collection: string, constraint: string, reference: string) {
    super(
      `Referenced record is still used by ${collection}/${constraint}: ${reference}`,
      collection,
      constraint,
      reference,
    );
    this.name = "ReferencedRecordRestrictedError";
  }
}

export class InvalidForeignKeyDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidForeignKeyDefinitionError";
  }
}
