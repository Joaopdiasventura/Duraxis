export enum TransactionPropagation {
  REQUIRED = "REQUIRED",
  REQUIRES_NEW = "REQUIRES_NEW",
  SUPPORTS = "SUPPORTS",
  MANDATORY = "MANDATORY",
  NOT_SUPPORTED = "NOT_SUPPORTED",
  NEVER = "NEVER",
  NESTED = "NESTED",
}

export enum TransactionIsolation {
  DEFAULT = "DEFAULT",
  SNAPSHOT = "SNAPSHOT",
}

export type ErrorConstructor = new (...arguments_: never[]) => Error;

export interface TransactionalOptions {
  readonly propagation?: TransactionPropagation;
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
  readonly timeout?: number;
  readonly rollbackFor?: readonly ErrorConstructor[];
  readonly noRollbackFor?: readonly ErrorConstructor[];
  readonly connectionName?: string;
}

export interface TransactionStatus {
  readonly connectionName: string;
  readonly active: boolean;
  readonly newTransaction: boolean;
  readonly readOnly: boolean;
  readonly rollbackOnly: boolean;
}
