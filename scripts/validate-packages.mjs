import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "pack";
const packageOrder = [
  "storage",
  "storage-memory",
  "storage-disk",
  "storage-s3",
  "core",
  "orm",
  "nestjs",
];
const privatePackage = "storage-testkit";
const expectedAuthor = "João Paulo Dias <joaopdias.dev@gmail.com>";
const expectedRepository = "https://github.com/Joaopdiasventura/Duraxis.git";
const npmRegistry = "https://registry.npmjs.org/";
const executable = (name) =>
  process.platform == "win32" && (name == "npm" || name == "pnpm") ? `${name}.cmd` : name;

if (!["manifests", "artifacts", "pack"].includes(mode)) {
  throw new Error(`Unknown validation mode: ${mode}`);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packagePath(directory, ...parts) {
  return join(root, "packages", directory, ...parts);
}

const packages = new Map(
  packageOrder.map((directory) => [directory, loadJson(packagePath(directory, "package.json"))]),
);
const publicNames = new Set([...packages.values()].map((manifest) => manifest.name));

function runtimeDependencies(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
}

function exportTargets(manifest) {
  const rootExport = manifest.exports?.["."];
  return [
    manifest.main,
    manifest.module,
    manifest.types,
    rootExport?.import,
    rootExport?.require,
    rootExport?.types,
  ];
}

function validateManifests() {
  const rootManifest = loadJson(join(root, "package.json"));
  const testkit = loadJson(packagePath(privatePackage, "package.json"));
  assert.equal(rootManifest.private, true, "the workspace root must be private");
  assert.equal(testkit.private, true, "@duraxis/storage-testkit must remain private");

  for (const [directory, manifest] of packages) {
    assert.equal(manifest.name, `@duraxis/${directory}`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.ok(manifest.description, `${manifest.name}: description is required`);
    assert.equal(manifest.license, "ISC");
    assert.equal(manifest.author, expectedAuthor);
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 4);
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: expectedRepository,
      directory: `packages/${directory}`,
    });
    assert.match(manifest.homepage, /^https:\/\/github\.com\/Joaopdiasventura\/Duraxis\//);
    assert.equal(manifest.bugs?.url, "https://github.com/Joaopdiasventura/Duraxis/issues");
    assert.equal(manifest.engines?.node, ">=22.12.0");
    assert.deepEqual(manifest.publishConfig, { access: "public", registry: npmRegistry });
    assert.deepEqual(manifest.exports?.["."], {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
    assert.equal(manifest.main, "./dist/index.cjs");
    assert.equal(manifest.module, "./dist/index.js");
    assert.equal(manifest.types, "./dist/index.d.ts");

    for (const essential of ["dist", "README.md", "LICENSE", "CHANGELOG.md"]) {
      assert.ok(manifest.files.includes(essential), `${manifest.name}: files omits ${essential}`);
      assert.ok(
        existsSync(packagePath(directory, essential)),
        `${manifest.name}: missing ${essential}`,
      );
    }

    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@duraxis/")) {
        assert.ok(publicNames.has(dependency), `${manifest.name} depends on private ${dependency}`);
        assert.equal(
          range,
          "workspace:*",
          `${manifest.name}: preserve workspace:* for ${dependency}`,
        );
      }
    }

    assert.ok(
      !Object.hasOwn(runtimeDependencies(manifest), "@duraxis/storage-testkit"),
      `${manifest.name} has a runtime dependency on the private testkit`,
    );
  }

  assert.equal(packages.get("storage").sideEffects, false);
  assert.equal(packages.get("storage-memory").sideEffects, false);
  assert.equal(packages.get("storage-disk").sideEffects, false);
  assert.equal(packages.get("storage-s3").sideEffects, false);
  assert.ok(packages.get("storage-s3").dependencies["@aws-sdk/client-s3"]);
  assert.equal(packages.get("core").sideEffects, false);
  assert.equal(packages.get("orm").sideEffects, undefined);
  assert.equal(packages.get("nestjs").sideEffects, undefined);
  console.log(
    `✓ validated ${packages.size} public source manifests and private-package boundaries`,
  );
}

function validateArtifacts() {
  for (const [directory, manifest] of packages) {
    for (const target of new Set(exportTargets(manifest))) {
      assert.ok(target, `${manifest.name}: incomplete root export`);
      assert.ok(
        existsSync(packagePath(directory, target)),
        `${manifest.name}: export target does not exist: ${target}`,
      );
    }
  }
  console.log("✓ all ESM, CommonJS, and TypeScript export targets exist");
}

function run(command, arguments_, options = {}) {
  console.log(`> ${command} ${arguments_.join(" ")}`);
  const commandPath = executable(command);
  return execFileSync(commandPath, arguments_, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: commandPath.endsWith(".cmd"),
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, ...options.env },
  });
}

async function findNewTarball(directory, previous) {
  const files = await readdir(directory);
  const created = files.filter((file) => file.endsWith(".tgz") && !previous.has(file));
  assert.equal(created.length, 1, `expected one new tarball, found: ${created.join(", ")}`);
  return join(directory, created[0]);
}

async function inspectTarball(directory, tarball, extractionRoot) {
  const extraction = join(extractionRoot, directory);
  await mkdir(extraction, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extraction]);

  const packageRoot = join(extraction, "package");
  const packedManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const sourceManifest = packages.get(directory);
  assert.equal(packedManifest.name, sourceManifest.name);
  assert.equal(packedManifest.version, sourceManifest.version);
  assert.ok(
    !JSON.stringify(packedManifest).includes("workspace:"),
    `${packedManifest.name}: workspace protocol leaked`,
  );

  for (const essential of [
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
  ]) {
    assert.ok(
      existsSync(join(packageRoot, essential)),
      `${packedManifest.name}: tarball missing ${essential}`,
    );
  }

  for (const target of new Set(exportTargets(packedManifest))) {
    assert.ok(
      target && existsSync(join(packageRoot, target)),
      `${packedManifest.name}: packed export missing ${target}`,
    );
  }

  for (const [dependency, range] of Object.entries(packedManifest.dependencies ?? {})) {
    if (!dependency.startsWith("@duraxis/")) continue;
    assert.ok(
      publicNames.has(dependency),
      `${packedManifest.name}: packed private dependency ${dependency}`,
    );
    const dependencyManifest = [...packages.values()].find(
      (candidate) => candidate.name == dependency,
    );
    assert.equal(
      range,
      dependencyManifest.version,
      `${packedManifest.name}: invalid packed range for ${dependency}`,
    );
  }

  const packedFiles = await readdir(packageRoot, { recursive: true });
  for (const file of packedFiles) {
    const normalized = String(file).replaceAll("\\", "/");
    assert.ok(
      !normalized.startsWith("src/"),
      `${packedManifest.name}: source directory leaked: ${normalized}`,
    );
    assert.ok(
      !/(^|\/)(__test__|__tests__)(\/|$)|\.(spec|test)\.[cm]?[jt]s$/.test(normalized),
      `${packedManifest.name}: test leaked: ${normalized}`,
    );
    assert.ok(
      !/^(tsconfig(?:\..+)?\.json|vite\.config\.|vitest\.config\.)/.test(normalized),
      `${packedManifest.name}: build config leaked: ${normalized}`,
    );
    assert.ok(
      !normalized.endsWith(".ts") || normalized.endsWith(".d.ts"),
      `${packedManifest.name}: TypeScript source leaked: ${normalized}`,
    );
  }

  console.log(`✓ ${packedManifest.name}@${packedManifest.version}: ${basename(tarball)}`);
  return { manifest: packedManifest, tarball };
}

function installedVersion(packageName) {
  const segments = packageName.split("/");
  const path = packagePath("nestjs", "node_modules", ...segments, "package.json");
  return loadJson(path).version;
}

async function smokeTest(tarballs, temporaryRoot) {
  const consumer = join(temporaryRoot, "external-consumer");
  await mkdir(consumer, { recursive: true });
  const dependencies = Object.fromEntries(
    [...tarballs.values()].map(({ manifest, tarball }) => [
      manifest.name,
      `file:../tarballs/${basename(tarball)}`,
    ]),
  );

  for (const dependency of ["@nestjs/common", "@nestjs/core", "reflect-metadata", "rxjs"]) {
    dependencies[dependency] = installedVersion(dependency);
  }

  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "duraxis-external-smoke", private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `--registry=${npmRegistry}`,
    ],
    { cwd: consumer },
  );

  await writeFile(
    join(consumer, "esm-smoke.mjs"),
    `import assert from "node:assert/strict";
import { DuraxisDatabase } from "@duraxis/core";
import { DuraxisModule } from "@duraxis/nestjs";
import { DuraxisORM } from "@duraxis/orm";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { S3StorageDriver } from "@duraxis/storage-s3";
import { StorageError } from "@duraxis/storage";

const storage = new MemoryStorageDriver();
const written = await storage.put("smoke", new Uint8Array([1, 2, 3]), { condition: { type: "if-absent" } });
assert.equal(written.success, true);
assert.deepEqual((await storage.get("smoke"))?.data, new Uint8Array([1, 2, 3]));
const database = new DuraxisDatabase({ storage });
assert.equal(database.getMetrics().transactionsStarted, 0);
assert.equal(typeof DuraxisORM, "function");
assert.equal(typeof AsyncDiskStorageDriver.open, "function");
assert.equal(typeof DuraxisModule.forRoot, "function");
assert.equal(typeof StorageError, "function");
const s3 = new S3StorageDriver({ bucket: "duraxis-smoke", client: { region: "us-east-1" } });
await s3.close();
await database.close();
console.log("ESM smoke test passed");
`,
  );
  run("node", ["esm-smoke.mjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "cjs-smoke.cjs"),
    `"use strict";
const assert = require("node:assert/strict");
const { DuraxisDatabase } = require("@duraxis/core");
const { DuraxisModule } = require("@duraxis/nestjs");
const { DuraxisORM } = require("@duraxis/orm");
const { AsyncDiskStorageDriver } = require("@duraxis/storage-disk");
const { MemoryStorageDriver } = require("@duraxis/storage-memory");
const { S3StorageDriver } = require("@duraxis/storage-s3");
const { StorageError } = require("@duraxis/storage");
for (const value of [DuraxisDatabase, DuraxisModule, DuraxisORM, AsyncDiskStorageDriver, MemoryStorageDriver, S3StorageDriver, StorageError]) {
  assert.equal(typeof value, "function");
}
console.log("CommonJS smoke test passed");
`,
  );
  run("node", ["cjs-smoke.cjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "typescript-smoke.ts"),
    `import { DuraxisDatabase } from "@duraxis/core";
import { DuraxisModule } from "@duraxis/nestjs";
import type { DuraxisORM } from "@duraxis/orm";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { S3StorageDriver, type S3StorageDriverOptions } from "@duraxis/storage-s3";
import type { StorageDriver } from "@duraxis/storage";

const storage: StorageDriver = new MemoryStorageDriver();
const s3Options: S3StorageDriverOptions = { bucket: "duraxis-smoke", client: { region: "us-east-1" } };
const s3: StorageDriver = new S3StorageDriver(s3Options);
void s3;
const database = new DuraxisDatabase({ storage });
const ormTypeCheck: DuraxisORM | undefined = undefined;
void database;
void ormTypeCheck;
void AsyncDiskStorageDriver;
void DuraxisModule;
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true }, include: ["typescript-smoke.ts"] }, null, 2)}\n`,
  );
  run("node", [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: consumer,
  });
  console.log("✓ external ESM, CommonJS, and TypeScript consumption passed");
}

async function validatePack() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "duraxis-pack-check-"));
  const tarballDirectory = join(temporaryRoot, "tarballs");
  const extractionRoot = join(temporaryRoot, "extracted");
  await mkdir(tarballDirectory);
  await mkdir(extractionRoot);
  const tarballs = new Map();

  try {
    for (const directory of packageOrder) {
      const previous = new Set(await readdir(tarballDirectory));
      run("pnpm", [
        "--dir",
        packagePath(directory),
        "--ignore-scripts",
        "pack",
        "--json",
        "--pack-destination",
        tarballDirectory,
      ]);
      const tarball = await findNewTarball(tarballDirectory, previous);
      tarballs.set(directory, await inspectTarball(directory, tarball, extractionRoot));
    }

    await smokeTest(tarballs, temporaryRoot);
    console.log(`✓ inspected ${tarballs.size} tarballs without publishing`);
  } finally {
    if (process.env.PACK_CHECK_KEEP_TEMP == "1")
      console.log(`Kept pack output at ${temporaryRoot}`);
    else await rm(temporaryRoot, { recursive: true, force: true });
  }
}

validateManifests();
if (mode == "artifacts" || mode == "pack") validateArtifacts();
if (mode == "pack") await validatePack();
