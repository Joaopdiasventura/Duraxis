import { posix } from "node:path";
import type { InitializationOptions } from "../init/initialization-options.js";
export function extensions(options: Pick<InitializationOptions, "language" | "moduleFormat">) {
  return {
    source:
      options.language === "typescript"
        ? options.moduleFormat === "esm"
          ? "mts"
          : "cts"
        : options.moduleFormat === "esm"
          ? "mjs"
          : "cjs",
    runtime: options.moduleFormat === "esm" ? "mjs" : "cjs",
  };
}
export function entitySource(
  name: string,
  collection: string,
  language: string,
  format: string,
): string {
  if (language === "typescript")
    return `import { Entity, PrimaryKey, Column } from "@duraxis/orm";\n@Entity(${JSON.stringify(collection)})\nexport class ${name} {\n  @PrimaryKey() id!: string;\n  @Column({ type: "string", required: true }) name!: string;\n}\n`;
  return `${format === "esm" ? 'import { Entity, PrimaryKey, Column } from "@duraxis/orm";' : 'const { Entity, PrimaryKey, Column } = require("@duraxis/orm");'}\n${format === "esm" ? "export " : ""}class ${name} {}\nPrimaryKey()(${name}.prototype, "id");\nColumn({ type: "string", required: true })(${name}.prototype, "name");\nEntity(${JSON.stringify(collection)})(${name});\n${format === "cjs" ? `exports.${name} = ${name};\n` : ""}`;
}
export function projectSources(
  options: InitializationOptions,
  connection = "default",
): Record<string, string> {
  const { source, runtime } = extensions(options);
  const base = `${options.sourceDir}/duraxis${connection === "default" ? "" : `/connections/${connection}`}`;
  const typed = options.language === "typescript";
  const esm = options.moduleFormat === "esm";
  const load = (names: string, module: string) =>
    esm || typed
      ? `import { ${names} } from ${JSON.stringify(module)};`
      : `const { ${names} } = require(${JSON.stringify(module)});`;
  const exp = (name: string) =>
    esm || typed ? `export async function ${name}` : `async function ${name}`;
  const tail = (names: string[]) =>
    !esm && !typed ? names.map((n) => `exports.${n} = ${n};`).join("\n") : "";
  const fromRoot = posix.relative(base, ".") || ".";
  const customReference = options.customModule?.startsWith(".")
    ? `${fromRoot}/${options.customModule.replace(/^\.\//, "")}`
    : options.customModule;
  const storeImport =
    options.driver === "custom"
      ? load(`${options.customExport} as customStorage`, customReference!)
      : load(
          options.driver === "disk"
            ? "AsyncDiskStorageDriver"
            : options.driver === "s3"
              ? "S3StorageDriver"
              : "MemoryStorageDriver",
          `@duraxis/storage-${options.driver}`,
        );
  const customImport =
    !esm && !typed
      ? storeImport.replace(
          `${options.customExport} as customStorage`,
          `${options.customExport}: customStorage`,
        )
      : storeImport;
  const store =
    options.driver === "memory"
      ? "new MemoryStorageDriver(connection.storageLimits)"
      : options.driver === "disk"
        ? 'await AsyncDiskStorageDriver.open({ ...connection.storageLimits, directory: resolve(root, process.env[envPrefix + "_STORAGE_DIRECTORY"] ?? connection.storageDirectory), ownershipRecovery: { mode: "manual", applicationId: connection.applicationId } })'
        : options.driver === "s3"
          ? 'new S3StorageDriver({ ...connection.storageLimits, bucket: process.env[envPrefix + "_S3_BUCKET"] ?? connection.bucket, prefix: process.env[envPrefix + "_S3_PREFIX"] ?? connection.prefix, client: { region: process.env.AWS_REGION ?? connection.region, endpoint: process.env[envPrefix + "_S3_ENDPOINT"] ?? connection.endpoint, forcePathStyle: connection.forcePathStyle, maxAttempts: connection.storageLimits.maxAttempts } })'
          : `${options.customConstructor ? "new customStorage" : "await customStorage"}(${options.customOptions ? "customOptions" : ""})`;
  const settingsType = typed
    ? `\ninterface ConnectionSettings { applicationId?: string; namespace: string; storageDirectory: string; bucket: string; prefix: string; region?: string; endpoint?: string; forcePathStyle: boolean; storageLimits: Record<string, number>; resources: import("@duraxis/core").DuraxisDatabaseOptions["resources"]; cursorKeyEnv?: string; schemaMode: "create" | "validate" | "validate-managed"; }\n`
    : "";
  const code = `${load("DuraxisDatabase", "@duraxis/core")}
${load("readFile", "node:fs/promises")}
${load("dirname, resolve", "node:path")}
${esm ? load("fileURLToPath", "node:url") : ""}
${customImport}
${options.customOptions ? (esm || typed ? `import customOptions from ${JSON.stringify(`${fromRoot}/${options.customOptions.replace(/^\.\//, "")}`)};` : `const customOptions = require(${JSON.stringify(`${fromRoot}/${options.customOptions.replace(/^\.\//, "")}`)});`) : ""}
${options.orm ? load("entities", `./entities.${runtime}`) + "\n" + load("DuraxisORM", "@duraxis/orm") : ""}
${settingsType}
${exp("connectionSettings")}(name = ${JSON.stringify(connection)}) {
  let root = ${esm ? "dirname(fileURLToPath(import.meta.url))" : "__dirname"};
  while (true) {
    try {
      const settings = JSON.parse(await readFile(resolve(root, "duraxis.project.json"), "utf8"));
      if (!Object.hasOwn(settings.connections, name)) throw new Error("Unknown Duraxis connection");
      const connection${typed ? ": ConnectionSettings" : ""} = settings.connections[name];
      return { root, connection };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || dirname(root) === root) throw error;
      root = dirname(root);
    }
  }
}
${exp("createStorage")}(name = ${JSON.stringify(connection)}) {
  const { root, connection } = await connectionSettings(name);
  const envPrefix = name === "default" ? "DURAXIS" : "DURAXIS_" + name.toUpperCase().replace(/-/g, "_");
  const driver${typed ? ': import("@duraxis/core").DuraxisDatabaseOptions["storage"]' : ""} = ${store};
  if (driver.capabilities?.boundedReads !== true) { await driver.close?.(); throw new Error("Custom storage requires verified bounded-read support"); }
  return driver;
}
${exp("databaseOptions")}(name = ${JSON.stringify(connection)}) {
  const { connection } = await connectionSettings(name);
  const envPrefix = name === "default" ? "DURAXIS" : "DURAXIS_" + name.toUpperCase().replace(/-/g, "_");
  const cursorKey = connection.cursorKeyEnv ? process.env[connection.cursorKeyEnv] : undefined;
  if (connection.cursorKeyEnv && (!cursorKey || !/^[a-fA-F0-9]{64}$/.test(cursorKey))) throw new Error("Set the configured cursor key environment variable to 32 secret bytes encoded as hex");
  return { namespace: process.env[envPrefix + "_NAMESPACE"] ?? connection.namespace, resources: connection.resources, ...(cursorKey ? { cursorEncryption: { activeKeyId: "configured", keys: { configured: Buffer.from(cursorKey, "hex") } } } : {}) };
}
${exp("createDatabase")}(name = ${JSON.stringify(connection)}) {
  const storage = await createStorage(name);
  try { return new DuraxisDatabase({ storage, ...await databaseOptions(name) }); }
  catch (error) { await storage.close?.(); throw error; }
}
${exp("closeDatabase")}(database${typed ? ": DuraxisDatabase" : ""}) { await database.close({ closeStorage: true }); }
${
  options.orm
    ? `${exp("createORM")}(name = ${JSON.stringify(connection)}) {
  const database = await createDatabase(name);
  try { const { connection } = await connectionSettings(name); const orm = new DuraxisORM({ database, entities, schema: { mode: connection.schemaMode }, closeDatabase: true, closeStorage: true }); await orm.initialize(); return orm; }
  catch (error) { await closeDatabase(database); throw error; }
}`
    : ""
}
${tail(["connectionSettings", "createStorage", "databaseOptions", "createDatabase", "closeDatabase", ...(options.orm ? ["createORM"] : [])])}
`;
  const registry = options.example
    ? `${load("Example", `./example.entity.${runtime}`)}\n${esm || typed ? "export const entities = [Example];" : "exports.entities = [Example];"}\n`
    : `${esm || typed ? "export const entities" : "exports.entities"}${typed ? ': import("@duraxis/orm").EntityClass[]' : ""} = [];\n`;
  const files: Record<string, string> = {
    [`${base}/database.${source}`]: code,
  };
  if (options.orm)
    files[`${base}/entities.${source}`] =
      "// Duraxis managed entity registry\n" +
      (esm || typed ? 'import "reflect-metadata";\n' : 'require("reflect-metadata");\n') +
      registry;
  if (options.example && options.orm)
    files[`${base}/example.entity.${source}`] = entitySource(
      "Example",
      "examples",
      options.language,
      options.moduleFormat,
    );
  if (options.framework === "nestjs")
    files[`${base}/duraxis.module.${source}`] = nestModule(
      "ApplicationDuraxisModule",
      options,
      connection,
    );
  return files;
}
export function nestModule(
  name: string,
  options: Pick<InitializationOptions, "language" | "moduleFormat">,
  connection: string,
): string {
  const { runtime } = extensions(options);
  const es = options.language === "typescript" || options.moduleFormat === "esm";
  const load = (names: string, module: string) =>
    es
      ? `import { ${names} } from ${JSON.stringify(module)};`
      : `const { ${names} } = require(${JSON.stringify(module)});`;
  return `${load("Module", "@nestjs/common")}\n${load("DuraxisModule", "@duraxis/nestjs")}\n${load("createStorage, databaseOptions, connectionSettings", `./database.${runtime}`)}\n${load("entities", `./entities.${runtime}`)}\nconst integration = DuraxisModule.forRootAsync({ name: ${JSON.stringify(connection)}, async useFactory() { const { connection } = await connectionSettings(${JSON.stringify(connection)}); return { driver: () => createStorage(${JSON.stringify(connection)}), database: await databaseOptions(${JSON.stringify(connection)}), entities, schema: { mode: connection.schemaMode }, closeStorage: true }; } });\n${options.language === "typescript" ? `@Module({ imports: [integration], exports: [DuraxisModule] })\nexport class ${name} {}` : `${options.moduleFormat === "esm" ? "export " : ""}class ${name} {}\nModule({ imports: [integration], exports: [DuraxisModule] })(${name});\n${options.moduleFormat === "cjs" ? `exports.${name} = ${name};` : ""}`}\n`;
}
