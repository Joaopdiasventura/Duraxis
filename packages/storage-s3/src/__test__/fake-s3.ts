import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { vi } from "vitest";

export interface FakeEntry {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly metadata: Record<string, string>;
  readonly modified: Date;
}

export function serviceError(name: string, status: number): Error {
  return Object.assign(new Error("service error"), { name, $metadata: { httpStatusCode: status } });
}

export class FakeS3 {
  readonly entries = new Map<string, FakeEntry>();
  readonly calls: object[] = [];
  readonly bodies: Readable[] = [];
  before?: (command: object) => Promise<void> | void;
  after?: (command: object) => Promise<void> | void;

  public install(): void {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(
      async (command: unknown) => await this.send(command),
    );
  }

  public async send(command: unknown): Promise<never> {
    // The SDK send overloads cover unrelated commands. The fake only implements commands
    // exercised by this driver; the cast is confined to this test transport boundary.
    return (await this.dispatch(command)) as never;
  }

  private async dispatch(command: unknown): Promise<object> {
    if (!(
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand ||
      command instanceof PutObjectCommand ||
      command instanceof ListObjectsV2Command
    ))
      throw new Error("Unexpected fake S3 operation");
    this.calls.push(command);
    await this.before?.(command);
    const input = command.input;
    const id = `${input.Bucket}/${"Key" in input ? input.Key : ""}`;
    const current = this.entries.get(id);
    let response: object;
    if (command instanceof PutObjectCommand) {
      const { Body, Metadata, IfMatch, IfNoneMatch } = command.input;
      if (!(Body instanceof Uint8Array)) throw new Error("Expected binary S3 body");
      if (!IfMatch && IfNoneMatch != "*") throw new Error("Unconditional mutation is forbidden");
      if ((IfNoneMatch == "*" && current) || (IfMatch && current?.etag != IfMatch))
        throw serviceError("PreconditionFailed", 412);
      const body = new Uint8Array(Body);
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      this.entries.set(id, { body, etag, metadata: { ...Metadata }, modified: new Date() });
      response = {
        ETag: etag,
        VersionId: "deliberately-not-an-etag",
        $metadata: { httpStatusCode: 200 },
      };
    } else if (command instanceof ListObjectsV2Command) {
      const { Bucket, Prefix = "", ContinuationToken, MaxKeys = 1000 } = command.input;
      const keys = [...this.entries.keys()]
        .filter((key) => key.startsWith(`${Bucket}/${Prefix}`))
        .sort();
      const offset = ContinuationToken ? Number(ContinuationToken) : 0;
      const selected = keys.slice(offset, offset + MaxKeys);
      const next = offset + selected.length;
      response = {
        Contents: selected.map((key) => ({
          Key: key.slice(`${Bucket}/`.length),
          ETag: this.entries.get(key)!.etag,
          LastModified: this.entries.get(key)!.modified,
        })),
        IsTruncated: next < keys.length,
        ...(next < keys.length ? { NextContinuationToken: String(next) } : {}),
      };
    } else {
      if (!current)
        throw serviceError(command instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey", 404);
      const body =
        command instanceof GetObjectCommand
          ? Object.assign(Readable.from([current.body]), {
              transformToByteArray: async () => new Uint8Array(current.body),
            })
          : undefined;
      if (body) this.bodies.push(body);
      response = {
        ETag: current.etag,
        Metadata: { ...current.metadata },
        LastModified: current.modified,
        ContentLength: current.body.byteLength,
        VersionId: "deliberately-not-an-etag",
        ...(body ? { Body: body } : {}),
      };
    }
    await this.after?.(command);
    return response;
  }
}

export const testOptions = {
  bucket: "duraxis-tests",
  prefix: "isolated",
  client: {
    region: "us-east-1",
    maxAttempts: 1,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  },
} as const;
