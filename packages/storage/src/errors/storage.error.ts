export type StorageErrorCode =
  | "INVALID_KEY"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "ACCESS_DENIED"
  | "CORRUPTION"
  | "CLOSED"
  | "OWNERSHIP_CONFLICT"
  | "RESOURCE_LIMIT"
  | "OUTCOME_UNKNOWN"
  | "UNKNOWN";

export class StorageError extends Error {
  public constructor(
    public readonly message: string,
    public readonly code: StorageErrorCode,
    public readonly options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}
