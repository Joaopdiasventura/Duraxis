export class DuraxisOrmError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class EntityNotRegisteredError extends DuraxisOrmError {
  public constructor(entity: Function) {
    super(`Entity is not registered: ${entity.name || "<anonymous>"}`);
  }
}

export class InvalidMetadataError extends DuraxisOrmError {}
export class MissingPrimaryKeyError extends InvalidMetadataError {}
export class DuplicateRecordError extends DuraxisOrmError {}
export class RecordNotFoundError extends DuraxisOrmError {}
export class InvalidColumnError extends DuraxisOrmError {}
export class SchemaViolationError extends DuraxisOrmError {}
export class InvalidQueryError extends DuraxisOrmError {}

export class UniqueIndexViolationOrmError extends DuraxisOrmError {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export class OrmNotInitializedError extends DuraxisOrmError {
  public constructor() {
    super("DuraxisORM is not initialized");
  }
}

export class OrmClosedError extends DuraxisOrmError {
  public constructor() {
    super("DuraxisORM is closed");
  }
}

export class TransactionManagerClosedError extends DuraxisOrmError {
  public constructor() {
    super("ORM transaction manager is no longer active");
  }
}
