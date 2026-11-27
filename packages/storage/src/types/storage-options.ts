import { StorageError } from "../errors/storage.error.js";

export type WriteCondition =
  | {
      readonly type: "if-absent";
    }
  | {
      readonly type: "if-version";
      readonly version: string;
    };

export interface WriteOptions {
  readonly condition: WriteCondition;
}

export interface DeleteOptions {
  readonly condition: WriteCondition;
}

export function assertWriteCondition(value: unknown): asserts value is WriteCondition {
  if (
    !value ||
    typeof value != "object" ||
    !("type" in value) ||
    (value.type != "if-absent" && value.type != "if-version") ||
    (value.type == "if-version" &&
      (!("version" in value) || typeof value.version != "string" || !value.version.length))
  )
    throw new StorageError("A valid conditional mutation is required", "INVALID_KEY");
}
