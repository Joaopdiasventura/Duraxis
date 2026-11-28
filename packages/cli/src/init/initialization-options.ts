import { satisfies } from "../dependencies/version-compatibility.js";
import { resolve, sep } from "node:path";
import type { ParsedCommand } from "../registry/argument-parser.js";
import {
  selectManager,
  readObject,
  record,
  exists,
  type ProjectContext,
  type PackageManager,
} from "./project-detector.js";
import { safeRelative } from "../filesystem/file-plan.js";
export interface InitializationOptions {
  framework: "standalone" | "nestjs";
  driver: "memory" | "disk" | "s3" | "custom";
  orm: boolean;
  migrations: boolean;
  language: "typescript" | "javascript";
  moduleFormat: "esm" | "cjs";
  namespace: string;
  sourceDir: string;
  storageDirectory: string;
  bucket?: string;
  prefix: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  schemaMode: "create" | "validate" | "validate-managed";
  applicationId?: string;
  example: boolean;
  install: boolean;
  manager: PackageManager;
  customModule?: string;
  customExport: string;
  customConstructor: boolean;
  customOptions?: string;
  resources: Record<string, unknown>;
  storageLimits: Record<string, number>;
  cursorKeyEnv?: string;
}

export function assertStorageDirectory(
  root: string,
  value: string,
  sourceDir: string,
  migrations: boolean,
): void {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error("Invalid storage directory");
  const directory = resolve(root, value);
  const source = resolve(root, sourceDir);
  const artifacts = resolve(root, "duraxis");
  if (
    directory === resolve(root) ||
    source === directory ||
    source.startsWith(directory + sep) ||
    (migrations && (directory === artifacts || directory.startsWith(artifacts + sep)))
  )
    throw new Error(
      "Storage directory conflicts with project source or migration artifacts; choose a separate data directory",
    );
}
function choice<T extends string>(
  value: string | undefined,
  choices: readonly T[],
  fallback: T,
  automatic = false,
): T {
  if (value === undefined || (automatic && value === "auto")) return fallback;
  const selected = choices.find((c) => c === value);
  if (!selected) throw new Error(`Expected one of: ${choices.join(", ")}`);
  return selected;
}
export async function initializationOptions(
  context: ProjectContext,
  values: ParsedCommand["values"],
): Promise<InitializationOptions> {
  if (
    record(context.manifest.engines) &&
    typeof context.manifest.engines.node === "string" &&
    !satisfies(process.versions.node, context.manifest.engines.node)
  )
    throw new Error(
      "Project Node.js engines exclude the current supported runtime; update package.json before initializing Duraxis",
    );
  const framework = choice(
    values.framework,
    ["standalone", "nestjs"],
    context.nestjs ? "nestjs" : "standalone",
    true,
  );
  const driver = choice(values.driver, ["memory", "disk", "s3", "custom"], "disk");
  const orm = values.orm ?? (!values["no-orm"] && framework === "nestjs");
  const migrations = values.migrations ?? (!values["no-migrations"] && driver !== "memory");
  if (framework === "nestjs" && !orm)
    throw new Error("NestJS integration requires ORM; remove --no-orm");
  if (values.example && !orm) throw new Error("Example entity generation requires --orm");
  const language = choice(
    values.language,
    ["typescript", "javascript"],
    context.hasManifest ? context.language : "typescript",
    true,
  );
  const moduleFormat = choice(
    values["module-format"],
    ["esm", "cjs"],
    context.hasManifest ? context.moduleFormat : "esm",
    true,
  );
  if (context.hasManifest && moduleFormat !== context.moduleFormat)
    throw new Error(
      "Selected module format differs from package.json; use the existing format or update the package type before initialization",
    );
  const sourceDir = safeRelative(values["source-dir"] ?? context.sourceDir);
  const namespace = values.namespace ?? "default";
  if (
    !/^[A-Za-z0-9_/-]{1,128}$/.test(namespace) ||
    namespace.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid namespace; namespace is not authorization");
  for (const value of [values["storage-directory"], values.bucket, values.prefix, values.region])
    if (value && /[\r\n\0]/.test(value))
      throw new Error("Configuration values must not contain control characters");
  if (driver === "disk")
    assertStorageDirectory(
      context.root,
      values["storage-directory"] ?? "./data/duraxis",
      sourceDir,
      migrations,
    );
  const bucket = values.bucket;
  if (driver === "s3" && (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)))
    throw new Error("S3 requires --bucket with a valid general-purpose bucket name");
  if (values.endpoint) {
    const url = new URL(values.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Endpoint must not contain credentials, query or fragment");
  }
  const customModule = values["custom-module"];
  if (
    driver === "custom" &&
    (!customModule ||
      !/^(?:\.?\.?\/[A-Za-z0-9_./-]+|(?:@[a-z0-9-]+\/)?[a-z0-9._-]+)$/.test(customModule) ||
      customModule.includes(".."))
  )
    throw new Error(
      "Custom storage requires a safe relative module or package reference via --custom-module",
    );
  if (customModule?.startsWith(".") && !(await exists(resolve(context.root, customModule))))
    throw new Error(
      "Custom storage module does not exist; implement the StorageDriver contract first",
    );
  const customExport = values["custom-export"] ?? "createStorage";
  if (!/^[A-Za-z_$][\w$]*$/.test(customExport)) throw new Error("Invalid custom export name");
  if (values["custom-options"]) safeRelative(values["custom-options"].replace(/^\.\//, ""));
  if (values["custom-options"] && !(await exists(resolve(context.root, values["custom-options"]))))
    throw new Error("Custom configuration module does not exist");
  if (values["cursor-key-env"] && !/^[A-Z_][A-Z0-9_]*$/.test(values["cursor-key-env"]))
    throw new Error("Invalid cursor key environment variable name");
  if (values["ownership-recovery"] && values["ownership-recovery"] !== "manual")
    throw new Error(
      "CLI-generated Disk integrations require manual ownership recovery; automatic lock recovery is not enabled",
    );
  if (
    values["application-id"] &&
    (values["application-id"].length > 128 || /[\r\n\0]/.test(values["application-id"]))
  )
    throw new Error("Invalid application identity");
  const storageLimits: Record<string, number> = {};
  const supported =
    driver === "memory"
      ? ["max-stored-bytes", "max-object-bytes", "max-entries"]
      : driver === "disk"
        ? ["max-object-bytes", "max-metadata-bytes", "max-journal-bytes", "max-queued-operations"]
        : driver === "s3"
          ? ["max-object-bytes", "max-pending-operations", "max-attempts"]
          : [];
  for (const name of [
    "max-stored-bytes",
    "max-object-bytes",
    "max-entries",
    "max-metadata-bytes",
    "max-journal-bytes",
    "max-queued-operations",
    "max-pending-operations",
    "max-attempts",
  ] as const) {
    if (values[name] !== undefined) {
      const value = Number(values[name]);
      if (
        !supported.includes(name) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        (name === "max-attempts" && value > 10) ||
        (name === "max-journal-bytes" && value < 1024 * 1024)
      )
        throw new Error(`Invalid or unsupported --${name}`);
      storageLimits[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    }
  }
  const resources = values["resources-file"]
    ? await readObject(resolve(context.root, values["resources-file"]))
    : {};
  const { resourceLimits } = await import("@duraxis/core");
  const known = Object.keys(resourceLimits());
  if (
    Object.keys(resources).some((k) => !known.includes(k)) ||
    Object.values(resources).some((v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
  )
    throw new Error("Invalid Core resources JSON");
  const schemaMode = choice(
    values["schema-mode"],
    ["create", "validate", "validate-managed"],
    migrations ? "validate-managed" : "create",
  );
  if (migrations && schemaMode === "create")
    throw new Error("Migrations require validate or validate-managed schema mode");
  return {
    applicationId: values["application-id"],
    framework,
    driver,
    orm,
    migrations,
    language,
    moduleFormat,
    namespace,
    sourceDir,
    storageDirectory: values["storage-directory"] ?? "./data/duraxis",
    bucket,
    prefix: values.prefix ?? "",
    region: values.region,
    endpoint: values.endpoint,
    forcePathStyle: values["force-path-style"] ?? false,
    schemaMode,
    example: values.example ?? false,
    install: values.install ?? !values["no-install"],
    manager: selectManager(context, values["package-manager"]),
    customModule,
    customExport,
    customConstructor: values["custom-constructor"] ?? false,
    customOptions: values["custom-options"],
    resources,
    storageLimits,
    cursorKeyEnv: values["cursor-key-env"],
  };
}
