import { decodeQueryCursor } from "../query/model/cursor.js";
import { describe, it, expect, vi } from "vitest";
import {
  createDatabase,
  defineDuraxisConfig,
  normalizeDuraxisConnection,
  selectDuraxisConnection,
} from "../config.js";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

describe("shared configuration lifecycle", () => {
  it("owns factory-created storage, preserves externally owned drivers and supports explicit ownership", async () => {
    for (const factory of [true, false]) {
      const storage = Object.assign(new MemoryStorageDriver(), { close: vi.fn(async () => {}) });
      const close = vi.spyOn(storage, "close");
      const database = await createDatabase({ driver: factory ? () => storage : storage });
      await database.close();
      expect(close).toHaveBeenCalledTimes(factory ? 1 : 0);
      if (!factory) await storage.close();
    }
  });
  it("cleans up when database validation fails and preserves both failures", async () => {
    const storage = Object.assign(new MemoryStorageDriver(), { close: vi.fn(async () => {}) });
    const close = vi.spyOn(storage, "close");
    await expect(
      createDatabase({ driver: () => storage, database: { namespace: "../unsafe" } }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    const broken = Object.assign(new MemoryStorageDriver(), { close: vi.fn(async () => {}) });
    vi.spyOn(broken, "close").mockRejectedValue(new Error("close failed"));
    await expect(
      createDatabase({ driver: () => broken, database: { namespace: "../unsafe" } }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
  it("selects deterministic named connections and scopes environment overrides", async () => {
    const config = defineDuraxisConfig({
      connections: {
        secondary: { driver: () => new MemoryStorageDriver() },
        primary: { driver: () => new MemoryStorageDriver() },
      },
    });
    expect(selectDuraxisConnection(config).name).toBe("primary");
    expect(() => selectDuraxisConnection(config, "unknown")).toThrow("Unknown");
    vi.stubEnv("DURAXIS_PRIMARY_NAMESPACE", "primary-data");
    vi.stubEnv("DURAXIS_NAMESPACE", "default-data");
    try {
      const primary = await createDatabase(config);
      expect(primary.namespace).toBe("primary-data");
      await primary.close();
      const secondary = await createDatabase(config, "secondary");
      expect(secondary.namespace).not.toBe("primary-data");
      expect(secondary.namespace).not.toBe("default-data");
      await secondary.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("normalizes migration defaults without creating schemas or files", () => {
    const config = { driver: () => new MemoryStorageDriver(), migrations: true };
    expect(normalizeDuraxisConnection(config).schema.mode).toBe("validate-managed");
    expect(normalizeDuraxisConnection(config).migrations?.directory).toMatch(
      /duraxis\/migrations$/,
    );
    expect(() => normalizeDuraxisConnection({ ...config, schema: { mode: "create" } })).toThrow(
      "validation",
    );
  });
});

it("rejects ambiguous entity scopes, colliding environments and malformed migration options", () => {
  const driver = () => new MemoryStorageDriver();
  expect(() =>
    defineDuraxisConfig({
      connections: { default: { driver, autoLoadEntities: true }, analytics: { driver } },
    }),
  ).toThrow("explicit discovery directories");
  expect(() =>
    defineDuraxisConfig({
      connections: {
        default: { driver, autoLoadEntities: { allowEmpty: true } },
        analytics: { driver },
      },
    }),
  ).toThrow("explicit discovery directories");
  expect(() =>
    defineDuraxisConfig({ connections: { "a-b": { driver }, a_b: { driver } } }),
  ).toThrow("environment variable normalization");
  expect(() => normalizeDuraxisConnection({ driver, migrations: "enabled" as never })).toThrow(
    "migrations configuration",
  );
  expect(() => normalizeDuraxisConnection({ driver, migrations: { directory: "" } })).toThrow(
    "migration directory",
  );
});

it("rejects unsupported cursor envelope versions", () => {
  const cursor = Buffer.from(JSON.stringify({ version: 0, payload: {} })).toString("base64url");
  expect(() =>
    decodeQueryCursor(
      cursor,
      "generation",
      { name: "records", indexes: [] },
      { collection: "records" },
      Buffer.alloc(32, 1),
    ),
  ).toThrow("Unsupported cursor format");
});
