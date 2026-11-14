export interface S3StorageDriverOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly client?: {
    readonly region?: string;
    readonly endpoint?: string;
    readonly forcePathStyle?: boolean;
    readonly credentials?: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    };
    readonly maxAttempts?: number;
  };
}

export function validateOptions(options: S3StorageDriverOptions): string {
  const bucket = options?.bucket;

  if (
    typeof bucket != "string" ||
    bucket.length < 3 ||
    bucket.length > 63 ||
    !bucket.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket) ||
    /^(xn--|sthree-|amzn-s3-demo-)/.test(bucket) ||
    /(\.mrap|--x-s3|--ol-s3|--table-s3)$/.test(bucket)
  )
    throw new TypeError("Invalid S3 general-purpose bucket name");

  const prefix = options.prefix ?? "";
  if (
    typeof prefix != "string" ||
    prefix.includes("\0") ||
    (prefix.length > 0 && prefix.trim().length == 0) ||
    Buffer.from(prefix).toString("utf8") != prefix
  )
    throw new TypeError("Invalid S3 namespace prefix");

  const normalized = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;

  if (Buffer.byteLength(normalized) > 1023) throw new RangeError("S3 namespace prefix is too long");

  const client = options.client;

  if (client != null && typeof client != "object") throw new TypeError("Invalid S3 client options");

  if (
    client?.region != null &&
    (typeof client.region != "string" || !/^[a-z0-9-]+$/.test(client.region))
  )
    throw new TypeError("Invalid S3 region");

  if (client?.endpoint != null) {
    let endpoint: URL;

    try {
      endpoint = new URL(client.endpoint);
    } catch {
      throw new TypeError("Invalid S3 endpoint");
    }

    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new TypeError("Invalid S3 endpoint");
  }

  if (client?.forcePathStyle != null && typeof client.forcePathStyle != "boolean")
    throw new TypeError("Invalid S3 path style option");

  if (
    client?.maxAttempts != null &&
    (!Number.isSafeInteger(client.maxAttempts) || client.maxAttempts < 1 || client.maxAttempts > 10)
  )
    throw new RangeError("S3 read attempts must be between 1 and 10");

  if (client?.credentials != null) {
    for (const value of [client.credentials.accessKeyId, client.credentials.secretAccessKey])
      if (typeof value != "string" || value.trim().length == 0)
        throw new TypeError("Invalid explicit S3 credentials");

    if (
      client.credentials.sessionToken != null &&
      (typeof client.credentials.sessionToken != "string" ||
        !client.credentials.sessionToken.trim())
    )
      throw new TypeError("Invalid explicit S3 session token");
  }

  return normalized;
}
