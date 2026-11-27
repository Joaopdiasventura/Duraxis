import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import ts from "typescript";
import {
  checksum,
  canonicalJSON,
  createSnapshot,
  validateSnapshot,
  validateMigrationId,
  validateArtifacts,
  type DuraxisMigration,
  type MigrationArtifact,
  type SchemaSnapshot,
  type SchemaPlan,
  diffSchemas,
} from "@duraxis/migrations";
import type { CollectionDefinition } from "@duraxis/core";
import { importFile, readJSON, type DuraxisConnectionConfig } from "./config.js";

export function artifactChecksum(source: string): string {
  const options: ts.TranspileOptions = {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
    },
  };

  const first = ts.transpileModule(source, options).outputText;

  return checksum(ts.transpileModule(first, options).outputText);
}

export interface LocalArtifacts {
  readonly artifacts: readonly MigrationArtifact[];
  readonly files: readonly string[];
  readonly snapshots: string;
  readonly directory: string;
}

export async function loadArtifacts(
  config: DuraxisConnectionConfig,
  root: string,
  ownsLock = false,
  omitLatest = false,
): Promise<LocalArtifacts> {
  const directory = resolve(root, config.migrations.directory);
  const snapshots = resolve(root, config.migrations.snapshots);

  if (!ownsLock)
    try {
      await access(join(directory, ".duraxis-artifacts.lock"));
      throw new Error(
        "Artifact update in progress or stale guard; inspect artifacts before removing the guard",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
    }

  const files = (await readdir(directory))
    .filter((file) => /\.(ts|js|mjs)$/.test(file) && !file.endsWith(".d.ts"))
    .sort();

  const artifacts: MigrationArtifact[] = [];

  const ids = new Set<string>();

  for (const file of files) {
    const id = file.replace(/\.(ts|js|mjs)$/, "");

    validateMigrationId(id);

    if (ids.has(id)) throw new Error(`Duplicate migration filename: ${id}`);

    ids.add(id);

    if (omitLatest && file == files.at(-1)) continue;

    const source = await readFile(join(directory, file), "utf8");
    const module = (await importFile(join(directory, file))) as { default: DuraxisMigration };

    if (module.default?.id != id) throw new Error(`Migration ID does not match filename: ${file}`);

    const snapshot = await readJSON<SchemaSnapshot>(join(snapshots, `${id}.json`));

    validateSnapshot(snapshot);

    artifacts.push({ migration: module.default, checksum: artifactChecksum(source), snapshot });
  }

  const expected = new Set([...ids].map((id) => `${id}.json`));

  for (const file of await readdir(snapshots))
    if (file.endsWith(".json") && file != "baseline.json" && !expected.has(file))
      throw new Error(`Orphaned snapshot: ${file}`);

  const initial = await readJSON<SchemaSnapshot>(join(snapshots, "baseline.json"));

  validateSnapshot(initial);

  if (
    initial.migrationId !== null ||
    initial.parentMigrationId !== null ||
    initial.collections.length
  )
    throw new Error("Invalid empty baseline snapshot");

  validateArtifacts(artifacts);

  return { artifacts, files, snapshots, directory };
}
export function migrationId(name: string, previous?: string): string {
  if (name.includes("..") || /[\\/]/.test(name))
    throw new Error("Migration names cannot contain paths");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!slug || slug.length > 64) throw new Error("Invalid migration name");

  const stamp = new Date().toISOString().replace(/\D/g, "");

  const previousStamp = previous?.slice(0, 17);

  const prefix =
    previousStamp && previousStamp >= stamp
      ? (BigInt(previousStamp) + 1n).toString().padStart(17, "0")
      : stamp;

  return `${prefix}_${slug}`;
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderMigration(id: string, plan?: SchemaPlan): string {
  if (!plan)
    return `import { defineMigration } from "@duraxis/migrations";\n\nexport default defineMigration({\n  id: ${JSON.stringify(id)},\n  async up(context) {\n    throw new Error("Unfinished migration: implement up and provide its expected snapshot");\n  },\n});\n`;

  const inverse = diffSchemas(plan.after, plan.before);

  const reversible =
    !plan.operations.some(
      (operation) => operation.kind == "collection" && operation.after == null,
    ) && inverse.operations.every((operation) => operation.risk != "requires-data-transformation");

  return `import { defineMigration, applySchemaPlan } from "@duraxis/migrations";\n\nexport default defineMigration({\n  id: ${JSON.stringify(id)},\n  async up(context) {\n    await applySchemaPlan(context, ${literal(plan)});\n  },\n${
    reversible
      ? `  async down(context) {\n${inverse.operations
          .filter((operation) => operation.kind == "collection" && operation.after == null)
          .map(
            (operation) =>
              `    for await (const row of context.scan(${JSON.stringify(operation.collection)})) throw new Error("Cannot drop a populated collection during generated rollback");\n`,
          )
          .join("")}    await applySchemaPlan(context, ${literal(inverse)});\n  },\n`
      : "  // Irreversible automatically: write an explicit data-safe down() if needed.\n"
  } });\n`;
}

export async function withArtifactLock<T>(
  directory: string,
  callback: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });

  const lock = join(directory, ".duraxis-artifacts.lock");

  await writeFile(
    lock,
    canonicalJSON({
      pid: process.pid,
      purpose: "artifact update; inspect files before removing a stale guard",
    }),
    { flag: "wx" },
  );

  try {
    return await callback();
  } finally {
    await unlink(lock);
  }
}

export async function writePair(
  migrationPath: string,
  source: string,
  snapshotPath: string,
  snapshot: SchemaSnapshot,
): Promise<void> {
  await mkdir(resolve(snapshotPath, ".."), { recursive: true });
  await writeFile(migrationPath, source, { flag: "wx" });

  try {
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    await unlink(migrationPath);
    throw error;
  }
}

export async function removePair(migrationPath: string, snapshotPath: string): Promise<void> {
  const suffix = `.removing-${randomBytes(6).toString("hex")}`;
  await rename(migrationPath, migrationPath + suffix);

  try {
    await rename(snapshotPath, snapshotPath + suffix);
  } catch (error) {
    await rename(migrationPath + suffix, migrationPath);
    throw error;
  }

  await unlink(migrationPath + suffix);
  await unlink(snapshotPath + suffix);
}

export function snapshotFor(
  id: string,
  parent: string | null,
  schema: readonly CollectionDefinition[],
): SchemaSnapshot {
  return createSnapshot(id, parent, schema);
}
