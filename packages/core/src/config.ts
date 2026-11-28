import { existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageDriver } from "@duraxis/storage";
import { DuraxisDatabase, type DuraxisDatabaseOptions } from "./database/duraxis-database.js";

export type ConfigEntity = new (...args: never[]) => object;

export interface EntityDiscoveryOptions {
  readonly directories?: readonly string[];
  readonly allowEmpty?: boolean;
}

export interface DuraxisDriverContext {
  readonly root: string;
  readonly directory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly resolvePath: (path: string) => string;
}

export interface DuraxisConnectionOptions {
  readonly name?: string;
  readonly driver:
    StorageDriver | ((context: DuraxisDriverContext) => StorageDriver | Promise<StorageDriver>);

  readonly location?: string | URL;
  readonly baseDirectory?: string;
  readonly database?: Omit<DuraxisDatabaseOptions, "storage">;
  readonly cursorKeyEnv?: string;
  readonly closeStorage?: boolean;

  readonly entities?:
    readonly ConfigEntity[] | (() => readonly ConfigEntity[] | Promise<readonly ConfigEntity[]>);

  readonly autoLoadEntities?: boolean | EntityDiscoveryOptions;
  readonly schema?: { readonly mode: "create" | "validate" | "validate-managed" };

  readonly migrations?:
    | boolean
    | {
        readonly directory?: string;
        readonly snapshots?: string;
        readonly format?: "ts" | "js" | "mts" | "mjs";
      };
}

export interface DuraxisConnectionsOptions {
  readonly defaultConnection?: string;
  readonly connections: Readonly<Record<string, DuraxisConnectionOptions>>;
}

export type DuraxisConfiguration = DuraxisConnectionOptions | DuraxisConnectionsOptions;

const CONFIGURATION = Symbol.for("@duraxis/core/configuration");

export function isDuraxisConfiguration(value: unknown): value is DuraxisConfiguration {
  return typeof value === "object" && value !== null && Reflect.get(value, CONFIGURATION) === true;
}

function validateConnections(config: DuraxisConnectionsOptions): void {
  if (
    !config.connections ||
    typeof config.connections !== "object" ||
    Array.isArray(config.connections)
  )
    throw new TypeError("Invalid Duraxis connections map");

  const prefixes = new Set<string>();

  for (const name of Object.keys(config.connections)) {
    validateConnectionName(name);

    const prefix = name.toUpperCase().replace(/-/g, "_");

    if (prefixes.has(prefix))
      throw new Error("Connection names collide after environment variable normalization");

    prefixes.add(prefix);

    if (!config.connections[name] || typeof config.connections[name] !== "object")
      throw new TypeError(`Invalid Duraxis connection: ${name}`);

    const connection = config.connections[name]!;

    if (
      Object.keys(config.connections).length > 1 &&
      connection.autoLoadEntities &&
      (connection.autoLoadEntities === true || !connection.autoLoadEntities.directories?.length) &&
      connection.entities === undefined
    )
      throw new Error(
        `Connection ${name} requires explicit discovery directories or entities in a multi-connection configuration`,
      );
  }
}

export function defineDuraxisConfig<const T extends DuraxisConfiguration>(config: T): T {
  if (!config || typeof config !== "object") throw new TypeError("Invalid Duraxis configuration");

  if ("connections" in config) {
    validateConnections(config);

    const names = Object.keys(config.connections);

    if (!names.length) throw new Error("At least one Duraxis connection is required");
    for (const name of names) validateConnectionName(name);

    selectDuraxisConnection(config);
  } else if (!config || !config.driver) throw new Error("A Duraxis storage driver is required");

  Object.defineProperty(config, CONFIGURATION, { value: true });

  return config;
}

export function validateConnectionName(name: string): string {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
    ["constructor", "prototype", "__proto__"].includes(name)
  )
    throw new Error("Invalid Duraxis connection name");

  return name;
}

export function selectDuraxisConnection(
  config: DuraxisConfiguration,
  name?: string,
): DuraxisConnectionOptions {
  if (!("connections" in config)) {
    if (name && name !== (config.name ?? "default"))
      throw new Error(`Unknown Duraxis connection: ${name}`);

    return config;
  }

  validateConnections(config);
  const selected = name ?? config.defaultConnection ?? Object.keys(config.connections).sort()[0]!;

  validateConnectionName(selected);

  if (!Object.hasOwn(config.connections, selected))
    throw new Error(`Unknown Duraxis connection: ${selected}`);

  return { ...config.connections[selected]!, name: selected };
}

export function duraxisDriverContext(options: DuraxisConnectionOptions): DuraxisDriverContext {
  const directory = options.location
    ? dirname(
        options.location instanceof URL || options.location.startsWith("file:")
          ? fileURLToPath(options.location)
          : resolve(options.location),
      )
    : resolve(options.baseDirectory ?? ".");

  let root = directory;

  if (options.baseDirectory) root = resolve(directory, options.baseDirectory);
  else
    while (!existsSync(resolve(root, "package.json")) && dirname(root) !== root)
      root = dirname(root);

  if (dirname(root) === root && !existsSync(resolve(root, "package.json"))) root = directory;

  const name = validateConnectionName(options.name ?? "default");
  const prefix =
    name === "default" ? "DURAXIS" : `DURAXIS_${name.toUpperCase().replace(/-/g, "_")}`;

  const env = Object.fromEntries(
    ["NAMESPACE", "STORAGE_DIRECTORY", "S3_BUCKET", "S3_PREFIX", "S3_ENDPOINT"].map((key) => [
      key,
      process.env[`${prefix}_${key}`],
    ]),
  );

  return {
    root,
    directory,
    env,
    resolvePath: (path) => (isAbsolute(path) ? path : resolve(root, path)),
  };
}

export function normalizeDuraxisConnection(options: DuraxisConnectionOptions) {
  if (
    !options ||
    (typeof options.driver !== "function" &&
      (typeof options.driver !== "object" || !options.driver))
  )
    throw new TypeError("Invalid Duraxis driver");

  if (
    options.migrations !== undefined &&
    typeof options.migrations !== "boolean" &&
    (typeof options.migrations !== "object" ||
      options.migrations === null ||
      Array.isArray(options.migrations))
  )
    throw new TypeError("Invalid Duraxis migrations configuration");

  if (typeof options.migrations === "object") {
    for (const key of ["directory", "snapshots"] as const)
      if (
        options.migrations[key] !== undefined &&
        (typeof options.migrations[key] !== "string" || !options.migrations[key]!.trim())
      )
        throw new TypeError(`Invalid migration ${key}`);

    if (
      options.migrations.format !== undefined &&
      !["ts", "js", "mts", "mjs"].includes(options.migrations.format)
    )
      throw new TypeError("Invalid migration format");
  }

  if (options.schema && !["create", "validate", "validate-managed"].includes(options.schema.mode))
    throw new TypeError("Invalid schema mode");

  if (
    options.autoLoadEntities !== undefined &&
    typeof options.autoLoadEntities !== "boolean" &&
    (typeof options.autoLoadEntities !== "object" ||
      !options.autoLoadEntities ||
      Array.isArray(options.autoLoadEntities))
  )
    throw new TypeError("Invalid entity discovery options");

  if (
    typeof options.autoLoadEntities === "object" &&
    options.autoLoadEntities.directories !== undefined &&
    (!Array.isArray(options.autoLoadEntities.directories) ||
      !options.autoLoadEntities.directories.length ||
      options.autoLoadEntities.directories.some((path) => typeof path !== "string" || !path.trim()))
  )
    throw new TypeError("Entity directories must be a nonempty array of paths");

  const context = duraxisDriverContext(options);

  if (options.migrations && options.schema?.mode === "create")
    throw new Error("Migrations require schema validation; automatic creation is disabled");

  const migrationOptions = typeof options.migrations === "object" ? options.migrations : {};

  const base =
    options.name && options.name !== "default"
      ? `duraxis/${validateConnectionName(options.name)}`
      : "duraxis";

  const database = {
    ...(options.name && options.name !== "default" ? { namespace: options.name } : {}),
    ...options.database,
    ...(context.env.NAMESPACE !== undefined ? { namespace: context.env.NAMESPACE } : {}),
  };

  if (options.cursorKeyEnv) {
    const key = process.env[options.cursorKeyEnv];

    if (!key || !/^[a-fA-F0-9]{64}$/.test(key))
      throw new Error(`Provision ${options.cursorKeyEnv} as 32 secret bytes encoded as hex`);

    database.cursorEncryption = {
      activeKeyId: "configured",
      keys: { configured: Buffer.from(key, "hex") },
    };
  }

  return {
    ...options,
    context,
    database,
    schema: options.schema ?? {
      mode: options.migrations ? ("validate-managed" as const) : ("validate" as const),
    },
    migrations: options.migrations
      ? {
          directory: context.resolvePath(migrationOptions.directory ?? `${base}/migrations`),
          snapshots: context.resolvePath(migrationOptions.snapshots ?? `${base}/snapshots`),
          format:
            migrationOptions.format ??
            (options.location?.toString().match(/\.[cm]?js$/)
              ? ("mjs" as const)
              : ("mts" as const)),
        }
      : undefined,
  };
}

class ConfiguredDatabase extends DuraxisDatabase {
  public constructor(
    options: DuraxisDatabaseOptions,
    private readonly owned: boolean,
  ) {
    super(options);
  }

  public override close(options: Parameters<DuraxisDatabase["close"]>[0] = {}): Promise<void> {
    return super.close({ closeStorage: this.owned, ...options });
  }
}

export async function createDatabase(
  config: DuraxisConfiguration,
  name?: string,
): Promise<DuraxisDatabase> {
  const options = normalizeDuraxisConnection(selectDuraxisConnection(config, name));
  const owned = options.closeStorage ?? typeof options.driver === "function";

  const driver =
    typeof options.driver === "function" ? await options.driver(options.context) : options.driver;

  try {
    if (!driver || driver.capabilities?.boundedReads !== true)
      throw new Error("Duraxis storage requires verified bounded-read support");
    return new ConfiguredDatabase({ ...options.database, storage: driver }, owned);
  } catch (cause) {
    if (owned && driver?.close) {
      try {
        await driver.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], "Database initialization and cleanup failed");
      }
    }
    throw cause;
  }
}
