import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { defineStorageConformanceSuite } from "@duraxis/storage-testkit";
import { StorageError } from "@duraxis/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3StorageDriver } from "../index.js";
import { FakeS3, serviceError, testOptions } from "./fake-s3.js";

let service: FakeS3;
const drivers: S3StorageDriver[] = [];
const create = () => {
  const driver = new S3StorageDriver(testOptions);
  drivers.push(driver);
  return driver;
};
const bytes = (value: string) => new TextEncoder().encode(value);
const absent = { condition: { type: "if-absent" } } as const;

beforeEach(() => {
  service = new FakeS3();
  service.install();
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map(async (driver) => await driver.close()));
  vi.restoreAllMocks();
});

defineStorageConformanceSuite({
  name: "S3StorageDriver (fake SDK transport)",
  createDriver: create,
});

describe("S3-specific behavior", () => {
  it("creates an internal client without making requests and closes it once", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const driver = new S3StorageDriver({ bucket: "duraxis-tests", client: { maxAttempts: 9 } });
    expect(service.calls).toHaveLength(0);
    await driver.close();
    await driver.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { bucket: "UPPER" },
    { bucket: "a" },
    { bucket: "127.0.0.1" },
    { bucket: "bucket--x-s3" },
    { bucket: "duraxis-tests", prefix: "bad\0prefix" },
    { bucket: "duraxis-tests", client: { endpoint: "https://secret:password@example.test" } },
    { bucket: "duraxis-tests", client: { maxAttempts: 0 } },
    {
      bucket: "duraxis-tests",
      client: { credentials: { accessKeyId: "", secretAccessKey: "secret" } },
    },
  ])("validates configuration without including secrets", (options) => {
    expect(() => new S3StorageDriver(options)).toThrow();
    try {
      new S3StorageDriver(options);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    expect(service.calls).toHaveLength(0);
  });

  it("does not reuse versions for identical payloads or same-value ABA", async () => {
    const driver = create();
    const first = await driver.put("aba", bytes("same"), absent);
    if (!first.success) throw new Error("Expected write");
    const second = await driver.put("aba", bytes("same"), {
      condition: { type: "if-version", version: first.version },
    });
    expect(second.success && second.version).not.toBe(first.version);
    if (!second.success) throw new Error("Expected replacement");
    await driver.delete("aba", { condition: { type: "if-version", version: second.version } });
    const third = await driver.put("aba", bytes("same"), absent);
    expect(third.success && third.version).not.toBe(first.version);
    expect(
      await driver.put("aba", bytes("stale"), {
        condition: { type: "if-version", version: first.version },
      }),
    ).toEqual({ success: false, reason: "conflict" });
    expect((await driver.get("aba"))?.data).toEqual(bytes("same"));
    expect(first.version).not.toBe("deliberately-not-an-etag");
  });

  it("makes one tombstone CAS for concurrent deletes and hides logical deletion", async () => {
    const driver = create();
    const result = await driver.put("delete", bytes("value"), absent);
    if (!result.success) throw new Error("Expected write");
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          await driver.delete("delete", {
            condition: { type: "if-version", version: result.version },
          }),
      ),
    );
    expect(results.filter((value) => value.success)).toHaveLength(1);
    expect(await driver.get("delete")).toBeNull();
    expect(await driver.list("")).toEqual([]);
    expect(service.entries.get("duraxis-tests/isolated/delete")?.metadata["duraxis-state"]).toBe(
      "deleted",
    );
  });

  it("lists multiple pages, uses metadata without downloading bodies and strips namespaces", async () => {
    const driver = create();
    await Promise.all(
      Array.from(
        { length: 1005 },
        async (_, i) =>
          await driver.put(`entry/${String(i).padStart(4, "0")}`, bytes("value"), absent),
      ),
    );
    const other = new S3StorageDriver({ ...testOptions, prefix: "other" });
    drivers.push(other);
    await other.put("entry/unrelated", bytes("value"), absent);
    service.calls.length = 0;
    const listed = await driver.list("entry/");
    expect(listed).toHaveLength(1005);
    expect(listed[0]?.key).toBe("entry/0000");
    expect(listed.at(-1)?.key).toBe("entry/1004");
    expect(service.calls.filter((call) => call instanceof ListObjectsV2Command)).toHaveLength(2);
    expect(service.calls.filter((call) => call instanceof HeadObjectCommand)).toHaveLength(1005);
    expect(service.calls.filter((call) => call instanceof GetObjectCommand)).toHaveLength(0);
    const selected = listed[0]!;
    expect(
      await driver.delete(selected.key, {
        condition: { type: "if-version", version: selected.version },
      }),
    ).toEqual({ success: true });
  });

  it.each([
    ["AccessDenied", 403, "ACCESS_DENIED"],
    ["NoSuchBucket", 404, "UNAVAILABLE"],
    ["InternalError", 500, "UNAVAILABLE"],
    ["NotFound", 404, "UNKNOWN"],
  ])("never treats %s as object absence", async (name, status, code) => {
    service.before = () => {
      throw serviceError(name, Number(status));
    };
    await expect(create().get("missing")).rejects.toMatchObject({ code });
  });

  it.each([
    ["PreconditionFailed", 412],
    ["ConditionalRequestConflict", 409],
  ])("returns confirmed %s conflicts", async (name, status) => {
    const driver = create();
    const initial = await driver.put("key", bytes("initial"), absent);
    if (!initial.success) throw new Error("Expected write");
    service.before = (command) => {
      if (command instanceof PutObjectCommand) throw serviceError(String(name), Number(status));
    };
    expect(
      await driver.put("key", bytes("data"), {
        condition: { type: "if-version", version: initial.version },
      }),
    ).toEqual({ success: false, reason: "conflict" });
  });

  it("does not misclassify unrelated 409 responses as conflicts", async () => {
    service.before = () => {
      throw serviceError("OperationAborted", 409);
    };
    await expect(create().put("key", bytes("data"), absent)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("retains ambiguous write errors as causes without retrying them", async () => {
    const error = Object.assign(new Error("private service message"), { code: "ECONNRESET" });
    service.after = (command) => {
      if (command instanceof PutObjectCommand) throw error;
    };
    const driver = create();
    await expect(driver.put("key", bytes("data"), absent)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      cause: error,
    });
    expect(service.calls.filter((call) => call instanceof PutObjectCommand)).toHaveLength(1);
    service.after = undefined;
    expect((await driver.get("key"))?.data).toEqual(bytes("data"));
  });

  it("rejects corruption and releases the GET body", async () => {
    const driver = create();
    await driver.put("corrupt", bytes("data"), absent);
    service.entries.get("duraxis-tests/isolated/corrupt")!.body[72] ^= 1;
    await expect(driver.get("corrupt")).rejects.toMatchObject({ code: "CORRUPTION" });
    expect(service.bodies.at(-1)?.destroyed).toBe(true);
  });

  it("copies CAS input before an asynchronous metadata check", async () => {
    const driver = create();
    const first = await driver.put("key", bytes("old"), absent);
    if (!first.success) throw new Error("Expected write");
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.before = async (command) => {
      if (command instanceof HeadObjectCommand) await wait;
    };
    const input = bytes("new");
    const pending = driver.put("key", input, {
      condition: { type: "if-version", version: first.version },
    });
    input.fill(0);
    release();
    await pending;
    expect((await driver.get("key"))?.data).toEqual(bytes("new"));
  });

  it.each([
    ["RequestTimeout", 408, "TIMEOUT"],
    ["NotImplemented", 501, "UNKNOWN"],
    ["AccessDenied", 403, "ACCESS_DENIED"],
  ])("maps read %s without retrying a nonretryable error", async (name, status, code) => {
    const driver = new S3StorageDriver({
      ...testOptions,
      client: { ...testOptions.client, maxAttempts: 3 },
    });
    drivers.push(driver);
    service.before = () => {
      throw serviceError(String(name), Number(status));
    };
    await expect(driver.get("key")).rejects.toMatchObject({ code });
    expect(service.calls).toHaveLength(status == 408 ? 3 : 1);
  });

  it("rejects invalid UTF-8 keys, oversized physical keys and wildcard version expressions", async () => {
    const driver = create();
    await expect(driver.get("\ud800")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(driver.get("x".repeat(1024))).rejects.toMatchObject({ code: "INVALID_KEY" });
    await driver.put("key", bytes("original"), absent);
    expect(
      await driver.put("key", bytes("bad"), { condition: { type: "if-version", version: "*" } }),
    ).toEqual({ success: false, reason: "conflict" });
    expect((await driver.get("key"))?.data).toEqual(bytes("original"));
  });

  it("keeps listing HEAD requests alive through an error until every request settles", async () => {
    const driver = create();
    await driver.put("a", bytes("a"), absent);
    await driver.put("b", bytes("b"), absent);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.before = async (command) => {
      if (!(command instanceof HeadObjectCommand)) return;
      if (command.input.Key?.endsWith("/a")) throw serviceError("AccessDenied", 403);
      entered();
      await wait;
    };
    const listing = driver.list("");
    const rejection = expect(listing).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await started;
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const closing = driver.close();
    expect(destroy).not.toHaveBeenCalled();
    release();
    await rejection;
    await closing;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("tracks logical metrics and returns independent snapshots", async () => {
    const driver = create();
    await driver.put("key", bytes("data"), absent);
    await driver.get("key");
    await driver.list("");
    const metrics = driver.getMetrics();
    expect(metrics).toEqual({
      reads: 1,
      writes: 1,
      deletes: 0,
      lists: 1,
      bytesRead: 4,
      bytesWritten: 4,
      synchronizationWaitMs: 0,
    });
    expect(driver.getMetrics()).not.toBe(metrics);
  });

  it("drains active operations before idempotent shutdown and rejects new calls", async () => {
    const driver = create();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.before = async () => {
      await wait;
    };
    const active = driver.put("key", bytes("data"), absent);
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const closing = driver.close();
    expect(driver.close()).toBe(closing);
    expect(destroy).not.toHaveBeenCalled();
    await expect(driver.get("key")).rejects.toBeInstanceOf(StorageError);
    await expect(driver.list("")).rejects.toMatchObject({ code: "CLOSED" });
    release();
    await active;
    await closing;
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
