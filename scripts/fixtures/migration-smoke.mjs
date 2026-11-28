import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyTypeScriptLoader } from "./typescript-loader-smoke.mjs";
import { createRequire } from "node:module";
import { DuraxisDatabase } from "@duraxis/core";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";

const bin = resolve("node_modules/@duraxis/cli/dist/bin.js");
const cli = (...args) => execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" });
await verifyTypeScriptLoader(import.meta.resolve("@duraxis/cli"), process.cwd());
assert.match(cli("--help"), /migration:generate/);
cli("init", "--framework", "standalone", "--orm", "--migrations", "--no-install", "--yes");
const entity = `import { Entity, Column, PrimaryKey } from "@duraxis/orm";
@Entity("users")
export class User {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) name!: string;
  STATUS
}
`;
await writeFile("entities.ts", entity.replace("STATUS", ""));
await writeFile(
  "duraxis.config.ts",
  `import { defineDuraxisConfig } from "@duraxis/core";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { User } from "./entities.js";
export default defineDuraxisConfig({ entities: [User], migrations: { directory: "./duraxis/migrations", snapshots: "./duraxis/snapshots", format: "ts" }, driver: () => AsyncDiskStorageDriver.open({ directory: ${JSON.stringify(resolve("migration-data"))} }) });
`,
);
cli("migration:generate", "initial-schema");
assert.match(cli("migrate:up", "--dry-run"), /database was not opened/);
cli("migrate:up");
let database = new DuraxisDatabase({
  storage: await AsyncDiskStorageDriver.open({ directory: resolve("migration-data") }),
});
await database.transaction((tx) => tx.putDocument("users", "one", { name: "Alice" }));
await database.close({ closeStorage: true });
await writeFile(
  "entities.ts",
  entity.replace("STATUS", '@Column({ type: "string", required: false }) status?: string;'),
);
cli("migration:generate", "add-user-status");
assert.match(cli("migrate:diff"), /No schema differences/);
cli("migrate:up");
assert.equal(JSON.parse(cli("migrate:status", "--json")).applied.length, 2);
cli("migrate:check");
cli("migrate:check", "--offline");
const programmatic = createRequire(import.meta.resolve("@duraxis/cli"))("@duraxis/cli");
assert.equal(await programmatic.runCLI(["migrate:check"], { cwd: process.cwd(), out() {} }), 0);
// Switch migration artifacts, config, and decorated entities to compiled ESM.
const requireCLI = createRequire(import.meta.resolve("@duraxis/cli"));
const ts = requireCLI("typescript");
for (const path of [
  "entities.ts",
  "duraxis.config.ts",
  ...(await readdir("duraxis/migrations"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `duraxis/migrations/${file}`),
]) {
  const source = await readFile(path, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
    },
  }).outputText;
  await writeFile(path.replace(/\.ts$/, ".js"), output);
  await rename(path, path + ".original");
}
cli("migrate:check", "--config", "duraxis.config.js");
cli("migrate:down", "--yes", "--config", "duraxis.config.js");
database = new DuraxisDatabase({
  storage: await AsyncDiskStorageDriver.open({ directory: resolve("migration-data") }),
});
assert.deepEqual(await database.getDocument("users", "one"), { name: "Alice" });
assert.ok(!(await database.getCollectionDefinitions())[0].fields.status);
await database.close({ closeStorage: true });
console.log(
  "Packed CLI: decorated TS, generation, disk persistence, compiled JS checksums, checks, and rollback passed",
);
