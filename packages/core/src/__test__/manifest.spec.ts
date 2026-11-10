import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

import { emptyManifest, encodeManifest, decodeManifest, MANIFEST_KEY } from "../commit/manifest.js";

import { DuraxisDatabase } from "../database/duraxis-database.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Manifest v1 - indexed layout", () => {
  it("round-trips an empty indexed manifest", () => {
    const original = emptyManifest();

    const decoded = decodeManifest(encodeManifest(original));

    expect(decoded).toEqual(original);
    expect(decoded.primaryRoot).toBeNull();
    expect(decoded.indexRoots.size).toBe(0);
    expect(decoded.catalog.size).toBe(0);
  });

  it("rejects manifests without required index metadata", () => {
    const invalid = {
      format: 1,
      transactionId: "",
      commitHead: null,
      entries: {},
    };

    expect(() => decodeManifest(encoder.encode(JSON.stringify(invalid)))).toThrow(
      "Invalid Duraxis manifest layout",
    );
  });

  it("rejects manifest fields from other layouts", () => {
    const valid = JSON.parse(decoder.decode(encodeManifest(emptyManifest())));

    valid.entries = {};

    expect(() => decodeManifest(encoder.encode(JSON.stringify(valid)))).toThrow(
      "Invalid Duraxis manifest layout",
    );
  });

  it("rejects a modified checksum", () => {
    const valid = JSON.parse(decoder.decode(encodeManifest(emptyManifest())));

    valid.checksum = "0".repeat(64);

    expect(() => decodeManifest(encoder.encode(JSON.stringify(valid)))).toThrow(
      "integrity check failed",
    );
  });

  it("persists only index roots and catalog metadata", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });

    await db.defineCollection({
      name: "users",
      indexes: [
        {
          name: "email",
          field: "email",
          unique: true,
        },
      ],
    });

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
      });
    });

    const stored = await storage.get(MANIFEST_KEY);
    expect(stored).not.toBeNull();

    const raw = JSON.parse(decoder.decode(stored!.data));

    expect(Object.keys(raw).sort()).toEqual([
      "catalog",
      "checksum",
      "commitHead",
      "format",
      "indexRoots",
      "primaryRoot",
      "transactionId",
    ]);

    expect(raw).not.toHaveProperty("entries");
    expect(raw.primaryRoot).toBeTypeOf("string");
    expect(raw.indexRoots["users/email"]).toBeTypeOf("string");

    const decoded = decodeManifest(stored!.data);

    expect(decoded.format).toBe(1);
    expect(decoded.catalog.has("users")).toBe(true);
  });
});
