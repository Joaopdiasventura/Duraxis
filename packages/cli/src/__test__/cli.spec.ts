import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { artifactChecksum, migrationId, writePair } from "../artifacts.js";
import { createSnapshot } from "@duraxis/migrations";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bin = resolve(import.meta.dirname, "../../dist/bin.js");
async function cli(root: string, ...args: string[]) {
  return exec(process.execPath, [bin, ...args], { cwd: root });
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "duraxis-cli-test-"));
  roots.push(root);
  await mkdir(join(root, "node_modules/@duraxis"), { recursive: true });
  for (const name of ["cli", "core", "orm", "migrations", "storage-disk"])
    await symlink(
      resolve(import.meta.dirname, "../../../", name),
      join(root, "node_modules/@duraxis", name),
      process.platform == "win32" ? "junction" : "dir",
    );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await cli(root, "init");
  await writeFile(
    join(root, "entities.ts"),
    `import { Entity, PrimaryKey, Column } from "@duraxis/orm";
@Entity("users")
export class User {
  @PrimaryKey() id!: string;
  @Column({ type: "string" }) name!: string;
}
`,
  );
  await writeFile(
    join(root, "duraxis.config.ts"),
    `import { defineDuraxisConfig } from "@duraxis/cli";
import { DuraxisDatabase } from "@duraxis/core";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { User } from "./entities.js";
export default defineDuraxisConfig({ entities: [User], migrations: { directory: "./duraxis/migrations", snapshots: "./duraxis/snapshots" }, async createDatabase() { return new DuraxisDatabase({ storage: await AsyncDiskStorageDriver.open({ directory: ${JSON.stringify(join(root, "data"))} }) }); } });
`,
  );
  return root;
}
describe("CLI", () => {
  it("loads decorated TypeScript, generates, previews, applies, checks and rolls back persistent disk data", async () => {
    const root = await setup();
    expect((await cli(root, "migration:generate", "initial")).stdout).toContain("Created");
    expect((await cli(root, "migrate:up", "--dry-run")).stdout).toContain("Static preview");
    expect(await readdir(root)).not.toContain("data");
  });
  it("runs the persistent command lifecycle and resource cleanup across processes", async () => {
    const root = await setup();
    await cli(root, "migration:generate", "initial");
    expect((await cli(root, "migrate:up")).stdout).toContain("Applied 1");
    expect((await cli(root, "migrate:up")).stdout).toContain("Applied 0");
    expect((await cli(root, "migrate:status", "--json")).stdout).toContain('"pending": []');
    expect((await cli(root, "migrate:check")).stdout).toContain("valid");
    expect((await cli(root, "migrate:diff")).stdout).toContain("No schema");
    await expect(cli(root, "migration:remove", "--yes")).rejects.toThrow();
    await cli(root, "migrate:down", "--yes");
    await cli(root, "migration:remove", "--yes");
    expect((await cli(root, "migrate:status")).stdout).toContain("0 applied, 0 pending");
  });
  it("rejects unfinished migrations, path traversal, invalid options and overwrites", async () => {
    const root = await setup();
    await expect(cli(root, "init")).rejects.toThrow();
    await expect(cli(root, "migration:create", "../escape")).rejects.toThrow();
    await expect(cli(root, "migrate:down", "--dry-run")).rejects.toThrow();
    await cli(root, "migration:create", "manual");
    await expect(cli(root, "migrate:up")).rejects.toThrow();
    await writeFile(join(root, "schema.json"), "[]");
    await cli(root, "migration:snapshot", "--schema", "schema.json");
    await expect(cli(root, "migrate:up")).rejects.toThrow();
  });
  it("adopts an existing disk catalog as a baseline without recreating populated collections", async () => {
    const root = await setup();
    const path = join(root, "duraxis.config.ts");
    let source = await readFile(path, "utf8");
    source = 'import { exportSchema } from "@duraxis/orm";\n' + source;
    source = source.replace(
      "return new DuraxisDatabase({ storage: await AsyncDiskStorageDriver.open({ directory:",
      "const database = new DuraxisDatabase({ storage: await AsyncDiskStorageDriver.open({ directory:",
    );
    source = source.replace(
      "}) }); } });",
      '}) }); if (!(await database.getCollectionDefinitions()).length) { await database.defineCollections(exportSchema([User])); await database.transaction(tx => tx.putDocument("users", "one", { name: "Alice" })); } return database; } });',
    );
    await writeFile(path, source);
    expect((await cli(root, "migration:baseline", "adopt", "--yes")).stdout).toContain("Created");
    expect((await cli(root, "migrate:status")).stdout).toContain("1 applied");
    // Creation was not rerun, and generated rollback protects existing records.
    await expect(cli(root, "migrate:down", "--yes")).rejects.toThrow();
    expect((await cli(root, "migrate:status")).stdout).toContain("1 applied");
  });
  it("discovers configuration from subdirectories and selects named connections", async () => {
    const root = await setup();
    const path = join(root, "duraxis.config.ts");
    const source = (await readFile(path, "utf8")).replace(
      "export default defineDuraxisConfig",
      "const config = defineDuraxisConfig",
    );
    await writeFile(
      path,
      source + "\nexport default { ...config, databases: { named: config } };\n",
    );
    await mkdir(join(root, "nested"));
    expect(
      (await cli(join(root, "nested"), "migration:generate", "initial", "--database", "named"))
        .stdout,
    ).toContain("Created");
    expect((await cli(root, "migrate:check", "--offline", "--config", path)).stdout).toContain(
      "valid",
    );
    await expect(cli(root, "migrate:status", "--database", "missing", "--json")).rejects.toThrow();
  });
  it("discovers and executes ESM .mts migrations", async () => {
    const root = await setup();
    await cli(root, "migration:generate", "initial");
    const directory = join(root, "duraxis/migrations");
    const file = (await readdir(directory)).find((file) => file.endsWith(".ts"))!;
    await rename(join(directory, file), join(directory, file.replace(/\.ts$/, ".mts")));
    expect((await cli(root, "migrate:up")).stdout).toContain("Applied 1");
    expect((await cli(root, "migrate:status")).stdout).toContain("1 applied");
  });
  it("uses the same normalized identity for TypeScript and emitted ESM JavaScript", () => {
    const source =
      'import { defineMigration } from "@duraxis/migrations";\nexport default defineMigration({ id: "20261127110000000_initial", async up(context: unknown) { throw new Error("manual"); } });';
    const emitted = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    expect(artifactChecksum(source)).toBe(
      "sha256:a2887847a8027aa97d226b8c622592ef88aa41e683d8f3729760db36fc858cb5",
    );
    expect(artifactChecksum(source)).toBe(artifactChecksum(emitted));
    expect(artifactChecksum(source.replace('"manual"', '"changed"'))).not.toBe(
      artifactChecksum(source),
    );
    expect(migrationId("hello-world")).toMatch(/^\d{17}_hello_world$/);
  });
  it("cleans a migration if snapshot creation fails and preserves an existing snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "duraxis-pair-test-"));
    roots.push(root);
    const snapshot = join(root, "existing.json");
    await writeFile(snapshot, "keep");
    await expect(
      writePair(join(root, "new.ts"), "source", snapshot, createSnapshot(null, null, [])),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual(["existing.json"]);
    expect(await readFile(snapshot, "utf8")).toBe("keep");
  });
});
