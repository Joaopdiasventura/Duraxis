import { join, basename } from "node:path";
import { addFile, type FilePlan } from "../filesystem/file-plan.js";
import { exists, stringMap, type ProjectContext } from "./project-detector.js";
import type { InitializationOptions } from "./initialization-options.js";
import { projectSources, extensions } from "../templates/project.js";
import type { ManagedProject } from "./managed-project.js";
export function requiredPackages(options: InitializationOptions): string[] {
  return [
    "@duraxis/core",
    ...(options.driver === "custom"
      ? [
          "@duraxis/storage",
          ...(options.customModule && !options.customModule.startsWith(".")
            ? [options.customModule]
            : []),
        ]
      : [`@duraxis/storage-${options.driver}`]),
    ...(options.orm ? ["@duraxis/orm", "reflect-metadata"] : []),
    ...(options.framework === "nestjs"
      ? ["@duraxis/nestjs", "@nestjs/core", "@nestjs/common", "rxjs"]
      : []),
    ...(options.migrations ? ["@duraxis/migrations"] : []),
  ];
}
export function configSource(managed: ManagedProject): string {
  const options = managed.connections[managed.defaultConnection]!;
  const typed = options.language === "typescript";
  const esm = options.moduleFormat === "esm";
  const { runtime } = extensions(options);
  const entries = Object.entries(managed.connections).map(([name, connection]) => {
    const base = `${connection.sourceDir}/duraxis${name === "default" ? "" : `/connections/${name}`}`;
    const module = `./${base}/database.${extensions(connection).runtime}`;
    const entities = `./${base}/entities.${extensions(connection).runtime}`;
    return `${JSON.stringify(name)}: { moduleFormat: ${JSON.stringify(connection.moduleFormat)}, createDatabase: async () => (await import(${JSON.stringify(module)})).createDatabase(${JSON.stringify(name)}), ${connection.orm ? `entities: async () => (await import(${JSON.stringify(entities)})).entities,` : ""} ${connection.migrations ? `migrations: { directory: ${JSON.stringify(name === "default" ? "./duraxis/migrations" : `./duraxis/${name}/migrations`)}, snapshots: ${JSON.stringify(name === "default" ? "./duraxis/snapshots" : `./duraxis/${name}/snapshots`)}, format: ${JSON.stringify(typed ? "ts" : "js")} },` : ""} }`;
  });
  return `// Managed by Duraxis. Shared factories are application runtime modules.\nconst databases = {\n${entries.join(",\n")}\n};\n${esm ? "export default" : typed ? "export =" : "module.exports ="} { ...databases[${JSON.stringify(managed.defaultConnection)}], databases };\n`;
}
export async function planInitialization(
  context: ProjectContext,
  options: InitializationOptions,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  existing?: ManagedProject,
  name = "default",
): Promise<FilePlan> {
  if (!existing && context.configFiles.length)
    throw new Error(
      "Existing executable Duraxis configuration found. Preserve it; use manual integration or a separate project directory.",
    );
  const managed: ManagedProject = existing
    ? { ...existing, connections: { ...existing.connections, [name]: options } }
    : { version: 1, defaultConnection: "default", connections: { default: options } };
  const plan: FilePlan = {
    root: context.root,
    files: [],
    directories: [],
    warnings: [],
    dependencies,
    devDependencies,
    commands: [],
  };
  if (existing?.connections[name])
    throw new Error("Connection already exists; use config:set for managed settings");
  await addFile(plan, "duraxis.project.json", JSON.stringify(managed, null, 2) + "\n", !!existing);

  const sources = projectSources(options, name);
  for (const [path, content] of Object.entries(sources)) {
    await addFile(plan, path, content);
  }
  const defaultOptions = managed.connections[managed.defaultConnection]!;
  if (
    existing &&
    (options.language !== defaultOptions.language ||
      options.moduleFormat !== defaultOptions.moduleFormat)
  )
    throw new Error("Managed connections must share language and module format");
  if (existing) {
    const { readFile } = await import("node:fs/promises");
    if (
      (await readFile(
        join(context.root, `duraxis.config.${extensions(defaultOptions).source}`),
        "utf8",
      )) !== configSource(existing)
    )
      throw new Error(
        "Executable configuration was edited; add the named connection manually. No files were written.",
      );
  }
  await addFile(
    plan,
    `duraxis.config.${extensions(defaultOptions).source}`,
    configSource(managed),
    !!existing,
  );
  if (options.migrations) {
    const base = name === "default" ? "duraxis" : `duraxis/${name}`;
    plan.directories.push(`${base}/migrations`, `${base}/snapshots`);
    await addFile(plan, `${base}/migrations/package.json`, '{"type":"module"}\n');
    const { createSnapshot } = await import("@duraxis/migrations");
    await addFile(
      plan,
      `${base}/snapshots/baseline.json`,
      JSON.stringify(createSnapshot(null, null, []), null, 2) + "\n",
    );
  }
  if (
    !existing &&
    options.language === "typescript" &&
    !(await exists(join(context.root, "tsconfig.json")))
  )
    await addFile(
      plan,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            useDefineForClassFields: false,
            strict: true,
            outDir: "dist",
            rootDir: options.sourceDir,
            skipLibCheck: true,
          },
          include: [options.sourceDir],
        },
        null,
        2,
      ) + "\n",
    );
  const read = await import("node:fs/promises");
  const ignorePath = join(context.root, ".gitignore");
  const beforeIgnore = (await exists(ignorePath)) ? await read.readFile(ignorePath, "utf8") : "";
  const ignored = [
    "node_modules/",
    "dist/",
    ".env",
    ".env.local",
    ".duraxis-init.lock",
    ...(options.driver === "disk" &&
    !options.storageDirectory.startsWith("/") &&
    !options.storageDirectory.includes("..")
      ? [options.storageDirectory.replace(/^\.\//, "").replace(/\/$/, "") + "/"]
      : []),
  ];
  const missing = ignored.filter((line) => !beforeIgnore.split(/\r?\n/).includes(line));
  if (missing.length)
    await addFile(
      plan,
      ".gitignore",
      beforeIgnore +
        (beforeIgnore && !beforeIgnore.endsWith("\n") ? "\n" : "") +
        missing.join("\n") +
        "\n",
      true,
    );
  const env =
    [
      `DURAXIS_NAMESPACE=${options.namespace}`,
      ...(options.driver === "disk"
        ? [`DURAXIS_STORAGE_DIRECTORY=${options.storageDirectory}`]
        : []),
      ...(options.driver === "s3"
        ? [
            `DURAXIS_S3_BUCKET=${options.bucket}`,
            `DURAXIS_S3_PREFIX=${options.prefix}`,
            `AWS_REGION=${options.region ?? ""}`,
            ...(options.endpoint ? [`DURAXIS_S3_ENDPOINT=${options.endpoint}`] : []),
          ]
        : []),
      ...(options.cursorKeyEnv
        ? [
            `# Secret 32-byte key encoded as hex; provision securely, never commit it`,
            `${options.cursorKeyEnv}=`,
          ]
        : []),
    ]
      .join("\n")
      .replace(
        /DURAXIS_/g,
        name === "default" ? "DURAXIS_" : `DURAXIS_${name.toUpperCase().replace(/-/g, "_")}_`,
      ) + "\n";
  if (!(await exists(join(context.root, ".env.example")))) await addFile(plan, ".env.example", env);
  else
    plan.warnings.push("Existing .env.example preserved. Add new environment references manually.");
  const scripts = stringMap(context.manifest.scripts);
  if (options.migrations && scripts["duraxis:status"] === undefined)
    scripts["duraxis:status"] = "duraxis migrate:status";
  if (
    options.language === "typescript" &&
    scripts.build === undefined &&
    !(await exists(join(context.root, "tsconfig.json")))
  )
    scripts.build = "tsc -p tsconfig.json";
  const manifest = {
    ...context.manifest,
    ...(!context.hasManifest
      ? {
          name:
            basename(context.root)
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-")
              .replace(/^-+|-+$/g, "") || "duraxis-application",
          private: true,
          type: options.moduleFormat === "esm" ? "module" : "commonjs",
          engines: { node: ">=24.15.0" },
        }
      : {}),
    scripts,
  };
  await addFile(
    plan,
    "package.json",
    JSON.stringify(manifest, null, 2) + "\n",
    context.hasManifest,
  );
  if (options.driver === "memory")
    plan.warnings.push(
      "Memory data and migration history are volatile and cannot persist across independent CLI processes.",
    );
  if (options.driver === "custom")
    plan.warnings.push(
      "Custom driver is trusted executable code; it must implement conditional operations and bounded reads. Initialization does not certify persistence correctness.",
    );
  if (options.framework === "nestjs")
    plan.warnings.push(
      `Import ApplicationDuraxisModule from ./${options.sourceDir}/duraxis/${name === "default" ? "" : `connections/${name}/`}duraxis.module.${extensions(options).runtime} in AppModule.imports; enableShutdownHooks() in main. Existing application code is preserved.`,
    );
  if (options.migrations)
    plan.warnings.push(
      "Run migrations before application startup. Core-only configurations use manual migrations; automatic generation requires entities.",
    );
  if (options.language === "typescript" && (await exists(join(context.root, "tsconfig.json"))))
    plan.warnings.push(
      "Existing tsconfig preserved. Verify NodeNext, experimentalDecorators, emitDecoratorMetadata and useDefineForClassFields:false; see duraxis doctor.",
    );
  return plan;
}
