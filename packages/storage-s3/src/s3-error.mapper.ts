import { StorageError, type StorageErrorCode } from "@duraxis/storage";

function field(error: unknown, property: string): unknown {
  return typeof error == "object" && error != null ? Reflect.get(error, property) : undefined;
}

export function errorName(error: unknown): unknown {
  return field(error, "name");
}

export function statusCode(error: unknown): unknown {
  return field(field(error, "$metadata"), "httpStatusCode");
}

export function isMissingKey(error: unknown): boolean {
  return errorName(error) == "NoSuchKey" && statusCode(error) == 404;
}

export function isConditionalConflict(error: unknown): boolean {
  return (
    statusCode(error) == 412 ||
    (statusCode(error) == 409 && errorName(error) == "ConditionalRequestConflict") ||
    isMissingKey(error)
  );
}

export function isRetryableRead(error: unknown): boolean {
  if (error instanceof StorageError) return false;
  const status = statusCode(error);
  return (
    (typeof status == "number" && [408, 429, 500, 502, 503, 504].includes(status)) ||
    ["TimeoutError", "RequestTimeout", "RequestTimeoutException", "SlowDown"].includes(
      String(errorName(error)),
    ) ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
      "ERR_STREAM_PREMATURE_CLOSE",
      "UND_ERR_SOCKET",
    ].includes(String(field(error, "code")))
  );
}

export function mapS3Error(error: unknown, mutation = false): StorageError {
  if (error instanceof StorageError) return error;
  const status = statusCode(error);
  const name = errorName(error);
  let code: StorageErrorCode;
  if (
    status == 401 ||
    status == 403 ||
    name == "CredentialsProviderError" ||
    name == "AccessDenied"
  )
    code = "ACCESS_DENIED";
  else if (status == 429 || name == "SlowDown" || name == "EntityTooLarge") code = "RESOURCE_LIMIT";
  else if (name == "NoSuchBucket") code = "UNAVAILABLE";
  else if (
    mutation &&
    (status == null ||
      status == 408 ||
      (typeof status == "number" && status >= 500) ||
      ["TimeoutError", "RequestTimeout", "RequestTimeoutException", "AbortError"].includes(
        String(name),
      ))
  )
    code = "OUTCOME_UNKNOWN";
  else if (
    status == 408 ||
    ["TimeoutError", "RequestTimeout", "RequestTimeoutException", "AbortError"].includes(
      String(name),
    ) ||
    field(error, "code") == "ETIMEDOUT"
  )
    code = "TIMEOUT";
  else if (isRetryableRead(error)) code = "UNAVAILABLE";
  else code = "UNKNOWN";
  // Never include SDK messages, signed URLs, keys or configuration in the public message.
  return new StorageError(`S3 storage operation failed (${code})`, code, { cause: error });
}
