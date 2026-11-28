import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { discoverEntities } from "../discovery.js";
import { createORM } from "../database/create-orm.js";
import { Entity } from "../decorators/entity.decorator.js";
import { PrimaryKey } from "../decorators/primary-key.decorator.js";
import { exportSchema } from "../schema/schema-exporter.js";
@Entity("alpha")
class Alpha {
  @PrimaryKey() id!: string;
}
@Entity("beta")
class Beta {
  @PrimaryKey() id!: string;
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "duraxis-discovery-"));
  roots.push(root);
  for (const directory of [
    "alpha/nested",
    "beta",
    "alpha/node_modules",
    "alpha/tests",
    "alpha/migrations",
    "alpha/dist",
  ])
    await mkdir(join(root, directory), { recursive: true });
  const modules = new Map<string, unknown>();
  for (const [path, exports] of [
    ["alpha/a.entity.ts", { Alpha, NotAnEntity: class DTO {} }],
    ["alpha/nested/b.entity.mts", { default: Alpha }],
    ["beta/b.entity.cjs", { Beta }],
    ["alpha/interfaces.entity.ts", {}],
    ["alpha/node_modules/no.entity.ts", { Beta }],
    ["alpha/tests/no.entity.ts", { Beta }],
    ["alpha/migrations/no.entity.ts", { Beta }],
    ["alpha/dist/no.entity.js", { Beta }],
  ] as const) {
    await writeFile(join(root, path), "");
    modules.set(join(root, path), exports);
  }
  await writeFile(join(root, "alpha/a.entity.d.ts"), "");
  await writeFile(join(root, "alpha/main.ts"), "throw new Error('bootstrap must never run')");
  const imported: string[] = [];
  const importer = async (url: URL) => {
    const path = fileURLToPath(url);
    imported.push(path);
    return modules.get(path);
  };
  return { root, imported, importer };
}
describe("bounded entity discovery", () => {
  it("discovers only decorated exports deterministically and isolates named connections", async () => {
    const { root, imported, importer } = await fixture();
    const driver = () => new MemoryStorageDriver();
    const alpha = await discoverEntities(
      { driver, baseDirectory: root, name: "alpha", autoLoadEntities: { directories: ["alpha"] } },
      importer,
    );
    const beta = await discoverEntities(
      { driver, baseDirectory: root, name: "beta", autoLoadEntities: { directories: ["beta"] } },
      importer,
    );
    expect(alpha).toEqual([Alpha]);
    expect(beta).toEqual([Beta]);
    expect(imported).toHaveLength(4);
    expect(
      imported.some(
        (path) =>
          path.includes("node_modules") || path.includes("/tests/") || path.includes("/dist/"),
      ),
    ).toBe(false);
    expect(exportSchema(alpha)).toEqual(exportSchema([Alpha]));
    await expect(
      discoverEntities(
        { driver, baseDirectory: root, name: "alpha", autoLoadEntities: true },
        importer,
      ),
    ).rejects.toThrow("prevent cross-connection");
  });
  it("rejects missing roots, empty discovery, import failures, duplicate representations and escaping symlinks", async () => {
    const { root, importer } = await fixture();
    const config = {
      driver: () => new MemoryStorageDriver(),
      baseDirectory: root,
      autoLoadEntities: { directories: ["missing"] },
    };
    await expect(discoverEntities(config, importer)).rejects.toThrow();
    await mkdir(join(root, "empty"));
    await expect(
      discoverEntities({ ...config, autoLoadEntities: { directories: ["empty"] } }, importer),
    ).rejects.toThrow("No Duraxis entities");
    expect(
      await discoverEntities(
        { ...config, autoLoadEntities: { directories: ["empty"], allowEmpty: true } },
        importer,
      ),
    ).toEqual([]);
    await expect(
      discoverEntities({ ...config, autoLoadEntities: { directories: ["../"] } }, importer),
    ).rejects.toThrow("boundary");
    await symlink(join(root, "beta"), join(root, "linked"));
    await expect(
      discoverEntities({ ...config, autoLoadEntities: { directories: ["linked"] } }, importer),
    ).rejects.toThrow("symlinks");
    await expect(
      discoverEntities({ ...config, autoLoadEntities: { directories: ["alpha"] } }, async () => {
        throw new Error("broken dependency");
      }),
    ).rejects.toThrow("Cannot load entity");
    await writeFile(join(root, "alpha/a.entity.js"), "");
    await expect(
      discoverEntities({ ...config, autoLoadEntities: { directories: ["alpha"] } }, importer),
    ).rejects.toThrow("Duplicate source/compiled");
  });
  it("honors explicit arrays and factories and rejects non-Duraxis classes", async () => {
    const driver = () => new MemoryStorageDriver();
    expect(await discoverEntities({ driver, entities: async () => [Alpha, Alpha] })).toEqual([
      Alpha,
    ]);
    await expect(discoverEntities({ driver, entities: [class DTO {}] })).rejects.toThrow(
      "Duraxis-decorated",
    );
  });
  it("closes owned storage if schema validation fails and shares the runtime schema with migration export", async () => {
    const storage = Object.assign(new MemoryStorageDriver(), { close: vi.fn(async () => {}) });
    const close = vi.spyOn(storage, "close");
    await expect(
      createORM({ driver: () => storage, entities: [Alpha], migrations: true }),
    ).rejects.toThrow("Missing collection");
    expect(close).toHaveBeenCalledOnce();
    const orm = await createORM({
      driver: () => new MemoryStorageDriver(),
      entities: [Alpha],
      schema: { mode: "create" },
    });
    expect(orm.metadata.all().map((metadata) => metadata.collection)).toEqual(
      exportSchema([Alpha]).map((schema) => schema.name),
    );
    await orm.close();
  });
});
