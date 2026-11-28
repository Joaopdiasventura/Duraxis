import { posix } from "node:path";
import type { InitializationOptions } from "../init/initialization-options.js";
import type { ProjectConfiguration } from "../init/initialization-planner.js";
export function extensions(options: Pick<InitializationOptions, "language" | "moduleFormat">) {
  return { source: options.language === "typescript" ? "ts" : "js", runtime: "js" };
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

export function connectionSource(
  options: InitializationOptions,
  name: string,
  alias: string,
): string {
  const q = JSON.stringify;
  const filteredLimits = Object.fromEntries(
    Object.entries(options.storageLimits).filter(
      ([key]) => options.driver !== "s3" || key !== "maxAttempts",
    ),
  );
  const limits = Object.keys(filteredLimits).length
    ? JSON.stringify(filteredLimits).slice(1, -1) + ", "
    : "";
  const env = (key: string, fallback: string | undefined) =>
    `env.${key}${fallback === undefined ? "" : ` ?? ${q(fallback)}`}`;
  const driver =
    options.driver === "memory"
      ? `new ${alias}(${Object.keys(options.storageLimits).length ? q(options.storageLimits) : ""})`
      : options.driver === "disk"
        ? `${alias}.open({ ${limits}directory: resolvePath(${env("STORAGE_DIRECTORY", options.storageDirectory)}), ownershipRecovery: { mode: "manual"${options.applicationId ? `, applicationId: ${q(options.applicationId)}` : ""} } })`
        : options.driver === "s3"
          ? `new ${alias}({ ${limits}bucket: ${env("S3_BUCKET", options.bucket)}, prefix: ${env("S3_PREFIX", options.prefix)}, client: { region: process.env.AWS_REGION${options.region ? ` ?? ${q(options.region)}` : ""}${options.endpoint ? `, endpoint: ${env("S3_ENDPOINT", options.endpoint)}` : ", endpoint: env.S3_ENDPOINT"}${options.forcePathStyle ? ", forcePathStyle: true" : ""}${options.storageLimits.maxAttempts ? `, maxAttempts: ${options.storageLimits.maxAttempts}` : ""} } })`
          : `${options.customConstructor ? "new " : ""}${alias}(${options.customOptions ? `customOptions_${name.replaceAll("-", "_")}` : ""})`;
  const fields = [
    `location: ${options.moduleFormat === "esm" ? "import.meta.url" : "__filename"}`,
    `driver: (${options.driver === "memory" || options.driver === "custom" ? "" : options.driver === "s3" ? "{ env }" : "{ env, resolvePath }"}) => ${driver}`,
    ...(options.orm
      ? [
          `autoLoadEntities: ${name === "default" ? "true" : `{ directories: [${q(`./features/${name}`)}] }`}`,
        ]
      : []),
    ...(options.migrations ? ["migrations: true"] : []),
    ...(!options.migrations && options.orm ? [`schema: { mode: ${q(options.schemaMode)} }`] : []),
    ...(options.migrations && options.schemaMode !== "validate-managed"
      ? [`schema: { mode: ${q(options.schemaMode)} }`]
      : []),
    ...(options.namespace !== "default" || Object.keys(options.resources).length
      ? [
          `database: { ${options.namespace !== "default" ? `namespace: ${q(options.namespace)}, ` : ""}${Object.keys(options.resources).length ? `resources: ${q(options.resources)}` : ""} }`,
        ]
      : []),
    ...(options.cursorKeyEnv ? [`cursorKeyEnv: ${q(options.cursorKeyEnv)}`] : []),
  ];
  return `{\n  ${fields.join(",\n  ")},\n}`;
}
export function configurationSource(managed: ProjectConfiguration, storageAlias?: string): string {
  const options = managed.connections[managed.defaultConnection]!;
  const es = options.language === "typescript" || options.moduleFormat === "esm";
  const imports = [
    es
      ? 'import { defineDuraxisConfig } from "@duraxis/core";'
      : 'const { defineDuraxisConfig } = require("@duraxis/core");',
  ];
  const entries = Object.entries(managed.connections).map(([name, connection], index) => {
    const className =
      connection.driver === "disk"
        ? "AsyncDiskStorageDriver"
        : connection.driver === "s3"
          ? "S3StorageDriver"
          : connection.driver === "memory"
            ? "MemoryStorageDriver"
            : connection.customExport;
    const alias = storageAlias
      ? `${storageAlias}${index || ""}`
      : Object.keys(managed.connections).length === 1
        ? className
        : `Storage${index}`;
    const module =
      connection.driver === "custom"
        ? connection.customModule!.startsWith(".")
          ? posix.relative(connection.sourceDir, connection.customModule!.replace(/^\.\//, ""))
          : connection.customModule!
        : `@duraxis/storage-${connection.driver}`;
    const reference =
      connection.driver === "custom" &&
      connection.customModule!.startsWith(".") &&
      !module.startsWith(".")
        ? `./${module}`
        : module;
    imports.push(
      es
        ? `import { ${className}${alias === className ? "" : ` as ${alias}`} } from ${JSON.stringify(reference)};`
        : `const { ${className}${alias === className ? "" : `: ${alias}`} } = require(${JSON.stringify(reference)});`,
    );
    if (connection.customOptions) {
      let custom = posix.relative(
        connection.sourceDir,
        connection.customOptions.replace(/^\.\//, ""),
      );
      if (!custom.startsWith(".")) custom = `./${custom}`;
      imports.push(
        es
          ? `import customOptions_${name.replaceAll("-", "_")} from ${JSON.stringify(custom)};`
          : `const customOptions_${name.replaceAll("-", "_")} = require(${JSON.stringify(custom)});`,
      );
    }
    return [name, connectionSource(connection, name, alias)] as const;
  });
  const value =
    entries.length === 1 && entries[0]![0] === "default"
      ? entries[0]![1]
      : `{ defaultConnection: ${JSON.stringify(managed.defaultConnection)}, connections: {\n${entries.map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(",\n")}\n} }`;
  return `${imports.join("\n")}\n\n${es ? "export default" : "module.exports ="} defineDuraxisConfig(${value});\n`;
}
export function projectSources(
  options: InitializationOptions,
  connection = "default",
): Record<string, string> {
  const files: Record<string, string> = {};
  if (options.example && options.orm)
    files[
      `${options.sourceDir}/features/${connection}/example.entity.${extensions(options).source}`
    ] = entitySource("Example", "examples", options.language, options.moduleFormat);
  return files;
}
