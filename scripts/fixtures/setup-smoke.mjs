import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@duraxis/cli";
// These generated consumers must never inherit a developer's production storage path.
for (const key of Object.keys(process.env))
  if (
    /^DURAXIS_(?:[A-Z0-9_]+_)?(?:STORAGE_DIRECTORY|NAMESPACE|S3_BUCKET|S3_PREFIX|S3_ENDPOINT)$/.test(
      key,
    )
  )
    delete process.env[key];
const root = process.cwd();
const bin = resolve("node_modules/@duraxis/cli/dist/bin.js");
const cli = (directory, ...args) =>
  execFileSync(process.execPath, [bin, ...args], { cwd: directory, encoding: "utf8" });
for (const format of ["esm", "cjs"]) {
  const directory = join(root, `setup-${format}`);
  await mkdir(directory);
  cli(
    directory,
    "init",
    "--directory",
    ".",
    "--framework",
    "nestjs",
    "--driver",
    "disk",
    "--orm",
    "--migrations",
    "--example",
    "--language",
    "javascript",
    "--module-format",
    format,
    "--no-install",
    "--yes",
  );
  const config = await loadConfig(directory);
  assert.match(cli(directory, "migration:generate", "initial"), /Created/);
  assert.match(cli(directory, "migrate:up"), /Applied 1/);
  assert.match(cli(directory, "migrate:check"), /valid/);
  // Runtime packages consume the same configuration without a CLI dependency.
  const require = createRequire(join(directory, "package.json"));
  const factory = format === "esm" ? await import("@duraxis/core") : require("@duraxis/core");
  const ormAPI = format === "esm" ? await import("@duraxis/orm") : require("@duraxis/orm");
  const appConfig = (await import(pathToFileURL(join(directory, "src/duraxis.config.js")).href))
    .default;
  const orm = await ormAPI.createORM(appConfig);
  const entities = await config.config.entities();
  await orm.getRepository(entities[0]).insert({ id: "one", name: "packed-consumer" });
  assert.equal((await orm.getRepository(entities[0]).find()).length, 1);
  await orm.close();
  const integration = await import(pathToFileURL(join(directory, "src/app.module.js")).href);
  const { NestFactory } = format === "esm" ? await import("@nestjs/core") : require("@nestjs/core");
  const app = await NestFactory.createApplicationContext(integration.AppModule, { logger: false });
  await app.close();
  const installedCLI = join(root, "node_modules/@duraxis/cli");
  const developmentOnlyCLI = join(root, "node_modules/@duraxis/cli-development-only");
  await writeFile(
    join(directory, "production-smoke.mjs"),
    `import config from "./src/duraxis.config.js"; import {createRequire} from "node:module"; const runtime = ${format === "esm" ? 'await import("@duraxis/orm")' : 'createRequire(import.meta.url)("@duraxis/orm")'}; const entities = await runtime.discoverEntities(config); const orm = await runtime.createORM(config); try { if ((await orm.getRepository(entities[0]).find()).length !== 1) throw new Error("Persistent row missing without CLI"); } finally { await orm.close(); }`,
  );
  await rename(installedCLI, developmentOnlyCLI);
  try {
    execFileSync(process.execPath, ["production-smoke.mjs"], { cwd: directory, stdio: "pipe" });
  } finally {
    await rename(developmentOnlyCLI, installedCLI);
  }

  assert.throws(() => cli(directory, "migrate:down", "--yes"), /populated collection/);
  const reopened = await factory.createDatabase(appConfig);
  await reopened.transaction((tx) => tx.deleteDocument("examples", "one"));
  await reopened.close({ closeStorage: true });
  cli(directory, "migrate:down", "--yes");
  assert.ok(
    !(await readFile(join(directory, "src/duraxis.config.js"), "utf8")).includes("@duraxis/cli"),
  );
}
console.log(
  "Packed setup: ESM/CommonJS shared configuration, ORM persistence, NestJS ownership/shutdown and migration lifecycle passed",
);
// Core-only manual migrations have no entity source, but still validate checksums,
// history and the persisted expected catalog.
{
  const { createSnapshot } = await import("@duraxis/migrations");
  const directory = join(root, "setup-core");
  await mkdir(directory);
  cli(
    directory,
    "init",
    "--directory",
    ".",
    "--driver",
    "disk",
    "--framework",
    "standalone",
    "--no-orm",
    "--migrations",
    "--language",
    "javascript",
    "--module-format",
    "esm",
    "--no-install",
    "--yes",
  );
  const id = "20261127110000000_initial_core";
  const collection = { name: "records", indexes: [] };
  await writeFile(
    join(directory, "duraxis/migrations", `${id}.js`),
    `import {defineMigration} from "@duraxis/migrations";export default defineMigration({id:${JSON.stringify(id)},up(context){context.schema.createCollection(${JSON.stringify(collection)});},down(context){context.schema.dropCollection("records");}});`,
  );
  await writeFile(
    join(directory, "duraxis/snapshots", `${id}.json`),
    JSON.stringify(createSnapshot(id, null, [collection])),
  );
  assert.match(cli(directory, "migrate:up"), /Applied 1/);
  assert.match(cli(directory, "migrate:check"), /No entity schema source configured/);
  assert.match(cli(directory, "migrate:diff", "--persisted"), /No schema differences/);
  cli(directory, "migrate:down", "--yes");
}
console.log("Packed setup: Core-only manual migration history/checksums/catalog validation passed");
