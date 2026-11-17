import type { DuraxisDatabase, Transaction } from "@duraxis/core";
import type { MetadataRegistry } from "../metadata/metadata-registry.js";

export interface RepositoryRuntime {
  readonly database: DuraxisDatabase;
  readonly transaction?: Transaction;
  readonly assertUsable: () => void;
  readonly registry: MetadataRegistry;
}
