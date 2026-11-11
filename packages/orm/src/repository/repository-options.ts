import type { DuraxisDatabase, Transaction } from "@duraxis/core";

export interface RepositoryRuntime {
  readonly database: DuraxisDatabase;
  readonly transaction?: Transaction;
  readonly assertUsable: () => void;
}
