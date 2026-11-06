import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "@duraxis/storage-memory";

import type { WriteOptions, WriteResult } from "@duraxis/storage";

import { DuraxisDatabase } from "../database/duraxis-database.js";

import { CommitOutcomeUnknownError } from "../errors/commit-outcome-unknown.error.js";

import { TransactionStateError } from "../errors/transaction-state.error.js";

import { decodeManifest, MANIFEST_KEY } from "../commit/manifest.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const decode = (value: Uint8Array | null) =>
  value == null ? null : new TextDecoder().decode(value);

describe("Core hardening", () => {
  it("isolates separate databases using the same driver", async () => {
    const storage = new MemoryStorageDriver();

    const first = new DuraxisDatabase({
      storage,
      namespace: "tenant/one",
    });

    const second = new DuraxisDatabase({
      storage,
      namespace: "tenant/two",
    });

    await first.transaction((tx) => {
      tx.put("key", encode("one"));
    });

    await second.transaction((tx) => {
      tx.put("key", encode("two"));
    });

    await first.transaction(async (tx) => {
      expect(decode(await tx.get("key"))).toBe("one");
    });

    await second.transaction(async (tx) => {
      expect(decode(await tx.get("key"))).toBe("two");
    });
  });

  it("rejects reserved logical keys", async () => {
    const db = new DuraxisDatabase({
      storage: new MemoryStorageDriver(),
    });

    await expect(
      db.transaction((tx) => {
        tx.put("__duraxis/v1/manifest", encode("x"));
      }),
    ).rejects.toThrow("Reserved Duraxis");
  });

  it("rejects foreign manifest object references", () => {
    const unsafe = encode(
      JSON.stringify({
        format: 1,
        transactionId: "",
        entries: {
          key: "another/tenant/object",
        },
      }),
    );

    expect(() => decodeManifest(unsafe)).toThrow("foreign");
  });

  it("detects modified committed object bytes", async () => {
    const storage = new MemoryStorageDriver();

    const db = new DuraxisDatabase({ storage });

    await db.transaction((tx) => {
      tx.put("key", encode("original"));
    });

    const manifest = await storage.get(MANIFEST_KEY);

    const entry = decodeManifest(manifest!.data).entries.get("key")!;

    const stored = await storage.get(entry);

    await storage.put(entry, encode("tampered"), {
      condition: {
        type: "if-version",
        version: stored!.version,
      },
    });

    await expect(db.transaction((tx) => tx.get("key"))).rejects.toThrow("integrity check failed");
  });

  it("prevents unawaited reads from overlapping commit", async () => {
    class DeferredStorage extends MemoryStorageDriver {
      resolveRead?: () => void;

      override async get(key: string) {
        if (key.includes("/objects/"))
          await new Promise<void>((resolve) => {
            this.resolveRead = resolve;
          });

        return super.get(key);
      }
    }

    const storage = new DeferredStorage();

    const db = new DuraxisDatabase({ storage });

    await db.transaction((tx) => {
      tx.put("key", encode("value"));
    });

    let dangling!: Promise<Uint8Array | null>;

    await expect(
      db.transaction((tx) => {
        dangling = tx.get("key");

        tx.put("other", encode("value"));
      }),
    ).rejects.toBeInstanceOf(TransactionStateError);

    storage.resolveRead?.();

    await expect(dangling).rejects.toBeInstanceOf(TransactionStateError);

    await db.transaction(async (tx) => {
      expect(await tx.get("other")).toBeNull();
    });
  });

  it("reports ambiguous manifest publication without claiming rollback", async () => {
    class AmbiguousStorage extends MemoryStorageDriver {
      override async put(
        key: string,
        bytes: Uint8Array,
        options: WriteOptions,
      ): Promise<WriteResult> {
        const result = await super.put(key, bytes, options);

        if (key == MANIFEST_KEY) throw new Error("response lost");

        return result;
      }
    }

    const storage = new AmbiguousStorage();

    const db = new DuraxisDatabase({ storage });

    await expect(
      db.transaction((tx) => {
        tx.put("key", encode("committed"));
      }),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);

    await db.transaction(async (tx) => {
      expect(decode(await tx.get("key"))).toBe("committed");
    });
  });
});
