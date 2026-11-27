import { join } from "node:path";
import { readObject, record, exists } from "./project-detector.js";
import { safeRelative } from "../filesystem/file-plan.js";
import type { InitializationOptions } from "./initialization-options.js";
export interface ManagedProject {
  version: 1;
  defaultConnection: string;
  connections: Record<string, InitializationOptions>;
}
export function connectionName(name: string): string {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
    ["constructor", "prototype", "__proto__"].includes(name)
  )
    throw new Error("Invalid connection name");
  return name;
}
export async function readManaged(root: string): Promise<ManagedProject> {
  const data = await readObject(join(root, "duraxis.project.json"));
  if (data.version !== 1 || typeof data.defaultConnection !== "string" || !record(data.connections))
    throw new Error("Invalid managed Duraxis project format");
  connectionName(data.defaultConnection);
  const connections: Record<string, InitializationOptions> = {};
  for (const [name, value] of Object.entries(data.connections)) {
    connectionName(name);
    if (
      !record(value) ||
      !["memory", "disk", "s3", "custom"].includes(String(value.driver)) ||
      !["standalone", "nestjs"].includes(String(value.framework)) ||
      !["typescript", "javascript"].includes(String(value.language)) ||
      !["esm", "cjs"].includes(String(value.moduleFormat)) ||
      typeof value.namespace !== "string" ||
      typeof value.sourceDir !== "string" ||
      typeof value.storageDirectory !== "string" ||
      typeof value.orm !== "boolean" ||
      typeof value.migrations !== "boolean"
    )
      throw new Error(`Invalid managed connection: ${name}`);
    safeRelative(value.sourceDir);
    if (
      !/^[A-Za-z0-9_/-]{1,128}$/.test(value.namespace) ||
      value.namespace.split("/").some((part) => !part || part === "..")
    )
      throw new Error("Invalid namespace");
    if (value.migrations && value.schemaMode === "create")
      throw new Error("Managed migrations require validation schema mode");
    if (
      value.driver === "s3" &&
      (typeof value.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket))
    )
      throw new Error("Invalid S3 bucket");
    if (value.endpoint !== undefined) {
      if (typeof value.endpoint !== "string") throw new Error("Invalid endpoint");
      const url = new URL(value.endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid or credential-bearing endpoint");
    }
    if (
      value.cursorKeyEnv !== undefined &&
      (typeof value.cursorKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.cursorKeyEnv))
    )
      throw new Error("Invalid cursor key environment reference");

    const { DEFAULT_RESOURCE_LIMITS } = await import("@duraxis/core");
    if (
      record(value.resources) &&
      Object.keys(value.resources).some((key) => !Object.hasOwn(DEFAULT_RESOURCE_LIMITS, key))
    )
      throw new Error("Unknown Core resource limit in managed settings");
    if (value.framework === "nestjs" && !value.orm) throw new Error("NestJS requires ORM");
    if (
      !["create", "validate", "validate-managed"].includes(String(value.schemaMode)) ||
      !record(value.storageLimits) ||
      !record(value.resources)
    )
      throw new Error("Invalid managed limits or schema mode");
    if (
      Object.values(value.storageLimits).some(
        (v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 1,
      ) ||
      Object.values(value.resources).some(
        (v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 1,
      )
    )
      throw new Error("Invalid managed resource limits");
    // Reconstruct only known configuration fields, never execute modules while inspecting.
    const driver = value.driver;
    const framework = value.framework;
    const language = value.language;
    const moduleFormat = value.moduleFormat;
    if (
      (driver !== "memory" && driver !== "disk" && driver !== "s3" && driver !== "custom") ||
      (framework !== "standalone" && framework !== "nestjs") ||
      (language !== "typescript" && language !== "javascript") ||
      (moduleFormat !== "esm" && moduleFormat !== "cjs")
    )
      throw new Error("Invalid integration");
    const schemaMode = value.schemaMode;
    if (schemaMode !== "create" && schemaMode !== "validate" && schemaMode !== "validate-managed")
      throw new Error("Invalid schema mode");
    connections[name] = {
      applicationId: typeof value.applicationId === "string" ? value.applicationId : undefined,
      framework,
      driver,
      language,
      moduleFormat,
      namespace: value.namespace,
      sourceDir: value.sourceDir,
      storageDirectory: value.storageDirectory,
      orm: value.orm,
      migrations: value.migrations,
      schemaMode,
      prefix: typeof value.prefix === "string" ? value.prefix : "",
      bucket: typeof value.bucket === "string" ? value.bucket : undefined,
      region: typeof value.region === "string" ? value.region : undefined,
      endpoint: typeof value.endpoint === "string" ? value.endpoint : undefined,
      forcePathStyle: value.forcePathStyle === true,
      example: value.example === true,
      install: value.install === true,
      manager:
        value.manager === "pnpm" || value.manager === "yarn" || value.manager === "bun"
          ? value.manager
          : "npm",
      customModule: typeof value.customModule === "string" ? value.customModule : undefined,
      customExport: typeof value.customExport === "string" ? value.customExport : "createStorage",
      customConstructor: value.customConstructor === true,
      customOptions: typeof value.customOptions === "string" ? value.customOptions : undefined,
      cursorKeyEnv: typeof value.cursorKeyEnv === "string" ? value.cursorKeyEnv : undefined,
      resources: value.resources,
      storageLimits: Object.fromEntries(
        Object.entries(value.storageLimits).map(([k, v]) => [k, Number(v)]),
      ),
    };
  }
  if (!Object.hasOwn(connections, data.defaultConnection))
    throw new Error("Missing default connection");
  return { version: 1, defaultConnection: data.defaultConnection, connections };
}
export async function findManagedRoot(cwd: string): Promise<string | undefined> {
  const { dirname, resolve } = await import("node:path");
  let root = resolve(cwd);
  while (true) {
    if (await exists(join(root, "duraxis.project.json"))) return root;
    if (dirname(root) === root) return undefined;
    root = dirname(root);
  }
}
