import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve, relative, sep, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeDuraxisConnection, type DuraxisConnectionOptions } from "@duraxis/core";
import type { EntityClass } from "./metadata/entity-metadata.js";
import { ownDraft } from "./metadata/decorator-metadata.js";
import { MetadataRegistry } from "./metadata/metadata-registry.js";

export function isDuraxisEntity(value: unknown): value is EntityClass {
  return typeof value === "function" && (ownDraft(value)?.entityApplications ?? 0) > 0;
}

const excluded = new Set([
  "node_modules",
  ".git",
  "test",
  "tests",
  "__test__",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "migrations",
  "snapshots",
  "dist",
  "build",
  "coverage",
]);

const entityFile = /\.entity\.(?:[cm]?[jt]s)$/;

async function noSymlinks(path: string): Promise<void> {
  let cursor = resolve(path);

  while (true) {
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error(`Entity discovery does not follow symlinks: ${cursor}`);

    if (dirname(cursor) === cursor) return;

    cursor = dirname(cursor);
  }
}

export async function discoverEntities(
  config: DuraxisConnectionOptions,
  importer: (url: URL) => Promise<unknown> = (url) => import(url.href),
): Promise<readonly EntityClass[]> {
  const options = normalizeDuraxisConnection(config);

  if (options.entities !== undefined) {
    const entities =
      typeof options.entities === "function" ? await options.entities() : options.entities;

    if (!Array.isArray(entities) || entities.some((entity) => !isDuraxisEntity(entity)))
      throw new Error("Explicit entities must be Duraxis-decorated classes");

    const unique = [...new Set(entities)];
    new MetadataRegistry(unique).finalize();
    return unique;
  }

  if (!options.autoLoadEntities) return [];

  const discovery = typeof options.autoLoadEntities === "object" ? options.autoLoadEntities : {};

  if (options.name && options.name !== "default" && !discovery.directories?.length)
    throw new Error(
      `Named connection ${options.name} requires explicit entity directories or entities to prevent cross-connection discovery`,
    );

  const files = new Set<string>();

  let inspected = 0;

  const boundary = await realpath(options.context.root);

  for (const directory of discovery.directories ?? ["."]) {
    const path = resolve(options.context.directory, directory);
    const within = relative(options.context.root, path);

    if (within === ".." || within.startsWith(`..${sep}`) || resolve(path) === resolve(sep))
      throw new Error("Entity directory escapes project boundary");

    await noSymlinks(path);

    const root = await realpath(path);
    const actual = relative(boundary, root);

    if (actual === ".." || actual.startsWith(`..${sep}`))
      throw new Error("Entity directory escapes project boundary");

    const walk = async (current: string, depth: number): Promise<void> => {
      if ((await lstat(current)).isSymbolicLink() || (await realpath(current)) !== current)
        throw new Error("Entity discovery directory changed or became a symlink");

      if (depth > 64) throw new Error("Entity discovery depth limit exceeded");

      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      )) {
        if (++inspected > 10000) throw new Error("Entity discovery file limit exceeded");
        if (entry.isSymbolicLink()) continue;

        const child = resolve(current, entry.name);

        if (entry.isDirectory() && !excluded.has(entry.name) && !entry.name.startsWith("."))
          await walk(child, depth + 1);

        if (
          entry.isFile() &&
          entityFile.test(entry.name) &&
          !/\.(?:test|spec|d)\./.test(entry.name)
        )
          files.add(child);
      }
    };

    await walk(root, 0);
  }

  const entities = new Set<EntityClass>();

  const identities = new Set<string>();

  for (const file of [...files].sort()) {
    const identity = file.replace(/\.[cm]?[jt]s$/, "");

    if (identities.has(identity))
      throw new Error(`Duplicate source/compiled entity representation: ${identity}`);

    identities.add(identity);

    await noSymlinks(file);

    if ((await realpath(file)) !== file) throw new Error("Entity file changed or became a symlink");

    let module: unknown;

    try {
      module = await importer(pathToFileURL(file));
    } catch (cause) {
      throw new Error(`Cannot load entity file ${file}`, { cause });
    }

    if (module && typeof module === "object")
      for (const value of Object.values(module)) {
        if (isDuraxisEntity(value)) entities.add(value);
        else if (value && typeof value === "object")
          for (const item of Object.values(value)) if (isDuraxisEntity(item)) entities.add(item);
      }
  }

  if (!entities.size && !discovery.allowEmpty)
    throw new Error(
      "No Duraxis entities discovered. Check directories and decorators; use allowEmpty:true only for an intentionally empty schema",
    );

  const result = [...entities];

  new MetadataRegistry(result).finalize();

  return result;
}
