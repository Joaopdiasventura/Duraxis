import { DuraxisNestError } from "../duraxis.errors.js";

export class TransactionRequiredError extends DuraxisNestError {
  public constructor(connectionName: string) {
    super(`An active Duraxis transaction is required for connection ${connectionName}`);
  }
}

export class ExistingTransactionError extends DuraxisNestError {
  public constructor(connectionName: string) {
    super(`An active Duraxis transaction is forbidden for connection ${connectionName}`);
  }
}

export class NestedTransactionNotSupportedError extends DuraxisNestError {
  public constructor() {
    super("NESTED propagation is unavailable because Duraxis does not support savepoints");
  }
}

export class UnsupportedTransactionIsolationError extends DuraxisNestError {
  public constructor(isolation: string) {
    super(`Unsupported Duraxis transaction isolation: ${isolation}`);
  }
}

export class UnsupportedTransactionTimeoutError extends DuraxisNestError {
  public constructor() {
    super("Transactional timeout is unavailable because Duraxis cannot safely cancel all writes");
  }
}

export class ReadOnlyTransactionError extends DuraxisNestError {
  public constructor(operation: string) {
    super(`Operation ${operation} is not allowed in a read-only Duraxis transaction`);
  }
}

export class UnexpectedTransactionRollbackError extends DuraxisNestError {
  public constructor() {
    super("Duraxis transaction rolled back because a participating scope marked it rollback-only");
  }
}

export class TransactionContextClosedError extends DuraxisNestError {
  public constructor() {
    super("Duraxis transaction context is no longer active");
  }
}

export class TransactionalMethodReturnTypeError extends DuraxisNestError {
  public constructor(methodName: string) {
    super(`Transactional method ${methodName} must return a Promise`);
  }
}

export class UnsupportedMixedTransactionError extends DuraxisNestError {
  public constructor() {
    super("Imperative orm.transaction() cannot be started inside a declarative transaction");
  }
}

export class UnawaitedTransactionOperationError extends DuraxisNestError {
  public constructor(options?: ErrorOptions) {
    super(
      "A repository operation was still pending when the transactional method completed",
      options,
    );
  }
}

export class TransactionManagerShuttingDownError extends DuraxisNestError {
  public constructor() {
    super("Duraxis transaction manager is shutting down");
  }
}

export class TransactionManagerNotFoundError extends DuraxisNestError {
  public constructor(connectionName: string) {
    super(`No Duraxis transaction manager is registered for connection ${connectionName}`);
  }
}
