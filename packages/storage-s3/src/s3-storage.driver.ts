import { setTimeout as delay } from "node:timers/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import {
  assertStorageKey,
  StorageError,
  type StorageDriver,
  type StorageDriverMetrics,
  type StorageObject,
  type StorageObjectInfo,
  type WriteOptions,
  type WriteResult,
  type DeleteOptions,
  type DeleteResult,
} from "@duraxis/storage";

import { validateOptions, type S3StorageDriverOptions } from "./s3-storage.options.js";

import {
  decodeObject,
  encodeObject,
  isVersion,
  objectState,
  requireVersion,
} from "./s3-object.codec.js";

import {
  errorName,
  isConditionalConflict,
  isMissingKey,
  isRetryableRead,
  mapS3Error,
  statusCode,
} from "./s3-error.mapper.js";

type MutableMetrics = { -readonly [Key in keyof StorageDriverMetrics]: StorageDriverMetrics[Key] };

const CONFLICT = { success: false, reason: "conflict" } as const;

const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_OPERATIONS = 4096;

export class S3StorageDriver implements StorageDriver {
  public readonly capabilities = Object.freeze({ boundedReads: true });
  readonly #maxObjectBytes: number;
  readonly #maxPendingOperations: number;
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #readAttempts: number;
  readonly #metrics: MutableMetrics = {
    reads: 0,
    writes: 0,
    deletes: 0,
    lists: 0,
    bytesRead: 0,
    bytesWritten: 0,
    synchronizationWaitMs: 0,
  };

  #bufferBytes = 0;
  #closing = false;
  #active = 0;
  #drain?: () => void;
  #closePromise?: Promise<void>;

  public constructor(options: S3StorageDriverOptions) {
    this.#prefix = validateOptions(options);

    this.#maxObjectBytes = options.maxObjectBytes ?? MAX_OBJECT_BYTES;
    this.#maxPendingOperations = options.maxPendingOperations ?? MAX_PENDING_OPERATIONS;

    this.#bucket = options.bucket;

    this.#readAttempts = options.client?.maxAttempts ?? 3;

    this.#client = new S3Client({
      ...options.client,
      ...(options.client?.credentials ? { credentials: { ...options.client.credentials } } : {}),
      maxAttempts: 1,
    });
  }

  public getMetrics(): Readonly<StorageDriverMetrics> {
    return { ...this.#metrics };
  }

  public get(
    key: string,
    options: { readonly signal?: AbortSignal; readonly maxBytes?: number } = {},
  ): Promise<StorageObject | null> {
    return this.operate(async () => {
      const physicalKey = this.key(key);

      options.signal?.throwIfAborted();

      this.#metrics.reads++;

      const result = await this.read(async () => {
        let response;

        try {
          response = await this.#client.send(
            new GetObjectCommand({ Bucket: this.#bucket, Key: physicalKey }),
            { abortSignal: options.signal },
          );
        } catch (error) {
          if (isMissingKey(error)) return null;
          throw error;
        }

        let releaseBuffer = () => {};
        try {
          const state = objectState(response.Metadata);

          const version = requireVersion(response.ETag);

          if (!response.Body) throw new StorageError("Missing S3 response body", "CORRUPTION");

          const maximum =
            Math.min(options.maxBytes ?? this.#maxObjectBytes, this.#maxObjectBytes) + 72;

          if (response.ContentLength != null && response.ContentLength > maximum)
            throw new StorageError("S3 object exceeds single-object limit", "RESOURCE_LIMIT");

          if (!(Symbol.asyncIterator in response.Body))
            throw new StorageError("S3 body does not support incremental reads", "CORRUPTION");

          releaseBuffer = this.reserveBuffer(
            Math.min(response.ContentLength ?? maximum, maximum) * 3,
          );

          const chunks: Uint8Array[] = [];

          let total = 0;

          for await (const chunk of response.Body as AsyncIterable<unknown>) {
            options.signal?.throwIfAborted();

            if (!(chunk instanceof Uint8Array))
              throw new StorageError("Invalid S3 body chunk", "CORRUPTION");

            if (chunks.length >= 4096 || total + chunk.byteLength > maximum)
              throw new StorageError("S3 body exceeds byte limit", "RESOURCE_LIMIT");

            total += chunk.byteLength;

            chunks.push(chunk);
          }

          const bytes = Buffer.concat(chunks, total);
          const data = decodeObject(bytes);

          return state == "deleted" ? null : { data, version };
        } finally {
          releaseBuffer();

          if (
            response.Body &&
            "destroy" in response.Body &&
            typeof response.Body.destroy == "function"
          )
            response.Body.destroy();
        }
      });

      if (result) this.#metrics.bytesRead += result.data.byteLength;

      return result;
    });
  }

  public put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult> {
    return this.operate(async () => {
      const physicalKey = this.key(key);

      if (data.byteLength > this.#maxObjectBytes)
        throw new StorageError("S3 object exceeds byte limit", "RESOURCE_LIMIT");

      if (!(data instanceof Uint8Array)) throw new TypeError("Storage data must be a Uint8Array");

      if (data.byteLength > 5 * 1024 ** 3 - 72)
        throw new StorageError("S3 object is too large", "RESOURCE_LIMIT");

      this.validateCondition(options?.condition);

      this.#metrics.writes++;

      if (options.condition.type == "if-version" && !isVersion(options.condition.version))
        return CONFLICT;

      const logicalBytes = data.byteLength;

      const release = this.reserveBuffer((data.byteLength + 72) * 2);
      try {
        const body = encodeObject(data);

        if (
          options.condition.type == "if-version" &&
          !(await this.matchesLiveVersion(physicalKey, options.condition.version))
        )
          return CONFLICT;

        const initial = await this.write(
          physicalKey,
          body,
          "live",
          options.condition.type == "if-absent" ? undefined : options.condition.version,
        );

        let result = initial;

        if (!initial.success && options.condition.type == "if-absent") {
          const current = await this.head(physicalKey);

          if (current && objectState(current.Metadata) == "deleted")
            result = await this.write(physicalKey, body, "live", requireVersion(current.ETag));
        }

        if (result.success) this.#metrics.bytesWritten += logicalBytes;

        return result;
      } finally {
        release();
      }
    });
  }

  public delete(key: string, options: DeleteOptions): Promise<DeleteResult> {
    return this.operate(async () => {
      const physicalKey = this.key(key);

      this.validateCondition(options?.condition);
      this.#metrics.deletes++;

      if (options.condition.type == "if-absent") {
        const current = await this.head(physicalKey);

        return !current || objectState(current.Metadata) == "deleted"
          ? { success: true }
          : CONFLICT;
      }

      if (!isVersion(options.condition.version)) return CONFLICT;

      if (!(await this.matchesLiveVersion(physicalKey, options.condition.version))) return CONFLICT;

      const result = await this.write(
        physicalKey,
        encodeObject(new Uint8Array()),
        "deleted",
        options.condition.version,
      );

      return result.success ? { success: true } : result;
    });
  }

  public async *iterate(
    prefix: string,
    options: { readonly pageSize?: number; readonly signal?: AbortSignal } = {},
  ): AsyncIterable<StorageObjectInfo> {
    if (
      typeof prefix != "string" ||
      prefix.includes("\0") ||
      Buffer.from(prefix).toString() != prefix
    )
      throw new StorageError("Invalid storage prefix", "INVALID_KEY");

    const size = options.pageSize ?? 256;

    if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
      throw new RangeError("Invalid listing page size");

    const physicalPrefix = this.#prefix + prefix;

    if (Buffer.byteLength(physicalPrefix) > 1024)
      throw new StorageError("Storage prefix is too long", "INVALID_KEY");

    this.#metrics.lists++;

    let token: string | undefined;
    let pages = 0;

    do {
      options.signal?.throwIfAborted();

      if (++pages > 100_000)
        throw new StorageError("S3 listing page limit exceeded", "RESOURCE_LIMIT");

      const page = await this.operate(() =>
        this.read(() =>
          this.#client.send(
            new ListObjectsV2Command({
              Bucket: this.#bucket,
              Prefix: physicalPrefix,
              ContinuationToken: token,
              MaxKeys: size,
            }),
            { abortSignal: options.signal },
          ),
        ),
      );

      const contents = page.Contents ?? [];

      for (let offset = 0; offset < contents.length; offset += 16) {
        options.signal?.throwIfAborted();

        const batch = await this.operate(async () => {
          const results = await Promise.allSettled(
            contents.slice(offset, offset + 16).map(async (item) => {
              if (!item.Key?.startsWith(physicalPrefix))
                throw new StorageError("Invalid S3 listing key", "CORRUPTION");

              const key = item.Key.slice(this.#prefix.length);

              this.key(key);

              const head = await this.head(item.Key);

              if (!head || objectState(head.Metadata) == "deleted") return null;

              const createdAt = head.LastModified?.getTime();

              if (createdAt == null || !Number.isSafeInteger(createdAt) || createdAt < 0)
                throw new StorageError("Missing or invalid S3 object timestamp", "CORRUPTION");

              return { key, version: requireVersion(head.ETag), createdAt };
            }),
          );

          for (const result of results) if (result.status == "rejected") throw result.reason;

          return results.flatMap((result) =>
            result.status == "fulfilled" && result.value ? [result.value] : [],
          );
        });

        for (const entry of batch) {
          options.signal?.throwIfAborted();
          yield entry;
        }
      }

      const next = page.IsTruncated ? page.NextContinuationToken : undefined;

      if (page.IsTruncated && (!next || next == token))
        throw new StorageError("Invalid S3 pagination token", "CORRUPTION");

      token = next;
    } while (token);
  }

  public async list(prefix: string): Promise<readonly StorageObjectInfo[]> {
    const result = new Map<string, StorageObjectInfo>();

    for await (const entry of this.iterate(prefix, { pageSize: 1000 })) {
      if (result.size >= 100_000)
        throw new StorageError("Listing limit exceeded; use iterate()", "RESOURCE_LIMIT");

      result.set(entry.key, entry);
    }

    return [...result.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  public close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;

      this.#closePromise = (async () => {
        if (this.#active > 0)
          await new Promise<void>((resolve) => {
            this.#drain = resolve;
          });

        this.#client.destroy();
      })();
    }

    return this.#closePromise;
  }

  private reserveBuffer(bytes: number): () => void {
    if (this.#bufferBytes + bytes > 64 * 1024 * 1024)
      throw new StorageError("S3 buffered-byte limit exceeded", "RESOURCE_LIMIT");

    this.#bufferBytes += bytes;

    let released = false;

    return () => {
      if (!released) {
        released = true;
        this.#bufferBytes -= bytes;
      }
    };
  }

  private async operate<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
    if (this.#active >= this.#maxPendingOperations)
      throw new StorageError("S3 operation admission limit exceeded", "RESOURCE_LIMIT");

    if (this.#closing) throw new StorageError("S3 storage driver is closed", "CLOSED");

    this.#active++;

    try {
      return await callback();
    } finally {
      if (--this.#active == 0) this.#drain?.();
    }
  }

  private key(key: string): string {
    assertStorageKey(key);

    const physical = this.#prefix + key;

    if (Buffer.from(key).toString() != key || Buffer.byteLength(physical) > 1024)
      throw new StorageError("S3 storage key is invalid or too long", "INVALID_KEY");

    return physical;
  }

  private validateCondition(condition: WriteOptions["condition"] | undefined): void {
    if (!condition || !["if-absent", "if-version"].includes(condition.type))
      throw new TypeError("A supported storage condition is required");
  }

  private async read<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callback();
      } catch (error) {
        if (attempt >= this.#readAttempts || !isRetryableRead(error)) throw mapS3Error(error);

        await delay(Math.floor(Math.random() * Math.min(1000, 50 * 2 ** (attempt - 1))));
      }
    }
  }

  private async head(key: string): Promise<HeadObjectCommandOutput | null> {
    return await this.read(async () => {
      try {
        return await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      } catch (error) {
        if (isMissingKey(error)) return null;

        if (statusCode(error) != 404 || errorName(error) != "NotFound") throw error;

        const listed = await this.#client.send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: key, MaxKeys: 1 }),
        );

        if (!listed.Contents?.some((item) => item.Key == key)) return null;

        throw new StorageError("S3 object changed during metadata lookup", "UNAVAILABLE", {
          cause: error,
        });
      }
    });
  }

  private async matchesLiveVersion(key: string, version: string): Promise<boolean> {
    const current = await this.head(key);

    return (
      current != null &&
      objectState(current.Metadata) == "live" &&
      requireVersion(current.ETag) == version
    );
  }

  private async write(
    key: string,
    body: Uint8Array,
    state: "live" | "deleted",
    version?: string,
  ): Promise<WriteResult> {
    try {
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: "application/octet-stream",
          Metadata: { "duraxis-format": "1", "duraxis-state": state },
          ...(version == null ? { IfNoneMatch: "*" } : { IfMatch: version }),
        }),
      );

      if (!isVersion(result.ETag))
        throw new StorageError("S3 write outcome lacks a usable ETag", "OUTCOME_UNKNOWN");

      return { success: true, version: result.ETag };
    } catch (error) {
      if (isConditionalConflict(error) && (!isMissingKey(error) || version != null))
        return CONFLICT;

      throw mapS3Error(error, true);
    }
  }
}
