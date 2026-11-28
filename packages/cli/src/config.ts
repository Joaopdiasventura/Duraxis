import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { initializeTypeScriptLoader } from "./typescript-loader.js";
import { pathToFileURL } from "node:url";
import {
  createDatabase,
  normalizeDuraxisConnection,
  selectDuraxisConnection,
  type DuraxisConfiguration,
  type DuraxisDatabase,
} from "@duraxis/core";
import { discoverEntities } from "@duraxis/orm";
import type { EntityClass } from "@duraxis/orm";

export interface DuraxisConnectionConfig {
  readonly settings?: unknown;
  readonly moduleFormat?: "esm" | "cjs";
  readonly entities?:
    readonly EntityClass[] | (() => readonly EntityClass[] | Promise<readonly EntityClass[]>);
  readonly migrations?: {
    readonly directory: string;
    readonly snapshots: string;
    readonly format?: "ts" | "js" | "mts" | "mjs";
  };
  readonly createDatabase: () => DuraxisDatabase | Promise<DuraxisDatabase>;
}

export type DuraxisConfig = DuraxisConfiguration;

export async function importFile(path: string | URL): Promise<unknown> {
  const url = path instanceof URL ? path : pathToFileURL(path);
  initializeTypeScriptLoader(url);
  return import(url.href);
}

export async function loadConfig(
  cwd: string,
  explicit?: string,
  database?: string,
): Promise<{ config: DuraxisConnectionConfig; root: string; path: string }> {
  let path: string | undefined;

  if (explicit) path = resolve(cwd, explicit);
  else {
    let directory = resolve(cwd);

    while (true) {
      for (const name of [
        "duraxis.config.ts",
        "duraxis.config.mts",
        "duraxis.config.js",
        "duraxis.config.mjs",
        "duraxis.config.cts",
        "duraxis.config.cjs",
      ]) {
        const candidate = resolve(directory, name);

        try {
          await access(candidate);

          path = candidate;

          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
        }
      }

      if (!path) {
        const project = await (
          await import("./init/project-detector.js")
        ).detectProject(directory, true);
        if (project.configFiles.length > 1)
          throw new Error("Multiple Duraxis configurations found; select one with --config");
        if (project.configFiles.length === 1) path = resolve(directory, project.configFiles[0]!);
      }
      if (path || dirname(directory) == directory) break;

      directory = dirname(directory);
    }
  }

  if (!path) throw new Error("No duraxis.config.ts or JavaScript configuration found");

  const module = (await importFile(path)) as { default?: DuraxisConfig };

  let base = module.default;
  // TypeScript CommonJS default exports may be wrapped by Node's ESM namespace.
  if (base && "default" in base) base = (base as unknown as { default: DuraxisConfig }).default;
  if (!base || typeof base !== "object" || (!("driver" in base) && !("connections" in base)))
    throw new Error("Invalid Duraxis configuration; configure a driver or named connections");
  const selected = selectDuraxisConnection(base as unknown as DuraxisConfiguration, database);
  const options = normalizeDuraxisConnection({
    ...selected,
    location: selected.location ?? path,
  });
  const context = options.context;
  const moduleFormat = /\.[cm][jt]s$/.test(path)
    ? /\.c[jt]s$/.test(path)
      ? "cjs"
      : "esm"
    : (await (await import("./init/project-detector.js")).detectProject(context.root, true))
        .moduleFormat;
  let discover = discoverEntities;
  if (moduleFormat === "cjs" && (options.entities !== undefined || options.autoLoadEntities)) {
    const require = (await import("node:module")).createRequire(path);
    discover = (require("@duraxis/orm") as typeof import("@duraxis/orm")).discoverEntities;
  }
  const config: DuraxisConnectionConfig = {
    settings: {
      ...selected,
      database: options.database,
      schema: options.schema,
      migrations: options.migrations,
    },
    createDatabase: () => createDatabase(options),
    ...(options.entities !== undefined || options.autoLoadEntities
      ? { entities: () => discover(options, (url) => importFile(url)) }
      : {}),
    ...(options.migrations ? { migrations: options.migrations } : {}),
    moduleFormat,
  };
  return { config, root: context.root, path };
}

export async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function requireMigrationConfig(
  config: DuraxisConnectionConfig,
): asserts config is DuraxisConnectionConfig & {
  migrations: NonNullable<DuraxisConnectionConfig["migrations"]>;
} {
  if (!config.migrations)
    throw new Error(
      "Migrations are disabled for this connection. Enable them before running migration commands.",
    );
}
