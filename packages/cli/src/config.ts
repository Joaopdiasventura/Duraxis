import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DuraxisDatabase } from "@duraxis/core";
import type { EntityClass } from "@duraxis/orm";

export interface DuraxisConnectionConfig {
  readonly entities:
    readonly EntityClass[] | (() => readonly EntityClass[] | Promise<readonly EntityClass[]>);
  readonly migrations: {
    readonly directory: string;
    readonly snapshots: string;
    readonly format?: "ts" | "js";
  };
  readonly createDatabase: () => DuraxisDatabase | Promise<DuraxisDatabase>;
}

export interface DuraxisConfig extends DuraxisConnectionConfig {
  readonly databases?: Readonly<Record<string, DuraxisConnectionConfig>>;
}

export function defineDuraxisConfig<const T extends DuraxisConfig>(config: T): T {
  return config;
}

export async function importFile(path: string): Promise<unknown> {
  return import(pathToFileURL(path).href);
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
      for (const name of ["duraxis.config.ts", "duraxis.config.js", "duraxis.config.mjs"]) {
        const candidate = resolve(directory, name);

        try {
          await access(candidate);

          path = candidate;

          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
        }
      }

      if (path || dirname(directory) == directory) break;

      directory = dirname(directory);
    }
  }

  if (!path) throw new Error("No duraxis.config.ts or JavaScript configuration found");

  const module = (await importFile(path)) as { default?: DuraxisConfig };

  const base = module.default;

  const config = database ? base?.databases?.[database] : base;

  if (
    !config ||
    typeof config.createDatabase != "function" ||
    (!Array.isArray(config.entities) && typeof config.entities != "function") ||
    typeof config.migrations?.directory != "string" ||
    typeof config.migrations.snapshots != "string" ||
    (config.migrations.format !== undefined && !["ts", "js"].includes(config.migrations.format))
  )
    throw new Error("Invalid Duraxis configuration or unknown named database");

  return { config, root: dirname(path), path };
}

export async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
