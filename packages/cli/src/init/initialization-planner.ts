import { join, basename } from "node:path";
import { addFile, type FilePlan } from "../filesystem/file-plan.js";
import { exists, stringMap, type ProjectContext } from "./project-detector.js";
import type { InitializationOptions } from "./initialization-options.js";
import { projectSources, extensions, configurationSource } from "../templates/project.js";
export interface ProjectConfiguration {
  defaultConnection: string;
  connections: Record<string, InitializationOptions>;
}
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
export { configurationSource as configSource } from "../templates/project.js";
export async function planInitialization(
  context: ProjectContext,
  options: InitializationOptions,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  name = "default",
): Promise<FilePlan> {
  if (context.configFiles.length)
    throw new Error("Existing Duraxis configuration found; no files were written.");
  const managed: ProjectConfiguration = {
    defaultConnection: "default",
    connections: { default: options },
  };
  const plan: FilePlan = {
    root: context.root,
    files: [],
    directories: [],
    warnings: [],
    dependencies,
    devDependencies,
    commands: [],
  };

  const sources = projectSources(options, name);
  for (const [path, content] of Object.entries(sources)) {
    await addFile(plan, path, content);
  }
  const configPath = `${options.sourceDir}/duraxis.config.${extensions(options).source}`;
  await addFile(plan, configPath, configurationSource(managed));
  if (options.framework === "nestjs") {
    const { readFile } = await import("node:fs/promises");
    const { integrateNestModule } = await import("./nest-integration.js");
    const candidates = context.nestModules.filter(
      (path) =>
        /(?:^|\/)app\.module\.[cm]?[jt]s$/.test(path) && path.startsWith(options.sourceDir + "/"),
    );
    if (candidates.length === 0 && !context.hasManifest) {
      const app = `${options.sourceDir}/app.module.${extensions(options).source}`;
      const es = options.language === "typescript" || options.moduleFormat === "esm";
      const imports = es
        ? `import { Module } from "@nestjs/common";\nimport { DuraxisModule } from "@duraxis/nestjs";\nimport duraxisConfig from "./duraxis.config.js";`
        : `const { Module } = require("@nestjs/common");\nconst { DuraxisModule } = require("@duraxis/nestjs");\nconst duraxisConfig = require("./duraxis.config.js");`;
      const metadata = "{ imports: [DuraxisModule.forRoot(duraxisConfig)] }";
      await addFile(
        plan,
        app,
        imports +
          "\n" +
          (options.language === "typescript"
            ? `@Module(${metadata})\nexport class AppModule {}\n`
            : `${es ? "export " : ""}class AppModule {}\nModule(${metadata})(AppModule);\n${es ? "" : "exports.AppModule = AppModule;\n"}`),
      );
    } else {
      if (candidates.length !== 1)
        throw new Error(
          "Select one NestJS application using --source-dir (and --directory for its package). Expected one existing app.module.ts; no files were written.",
        );
      const app = candidates[0]!;
      const original = await readFile(join(context.root, app), "utf8");
      await addFile(plan, app, integrateNestModule(original, app, configPath), true);
    }
  }
  if (options.migrations) {
    const base = name === "default" ? "duraxis" : `duraxis/${name}`;
    plan.directories.push(`${base}/migrations`, `${base}/snapshots`);
    const { createSnapshot } = await import("@duraxis/migrations");
    await addFile(
      plan,
      `${base}/snapshots/baseline.json`,
      JSON.stringify(createSnapshot(null, null, []), null, 2) + "\n",
    );
  }
  if (options.language === "typescript" && !(await exists(join(context.root, "tsconfig.json"))))
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
  const envPath = join(context.root, ".env.example");
  const beforeEnv = (await exists(envPath)) ? await read.readFile(envPath, "utf8") : "";
  const declared = new Set(
    beforeEnv
      .split(/\r?\n/)
      .map((line) => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter(Boolean),
  );
  const additions = env
    .split("\n")
    .filter((line) => line && !line.startsWith("#") && !declared.has(line.split("=")[0]));
  if (additions.length)
    await addFile(
      plan,
      ".env.example",
      beforeEnv +
        (beforeEnv && !beforeEnv.endsWith("\n") ? "\n" : "") +
        additions.join("\n") +
        "\n",
      true,
    );
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
    ...(Object.keys(dependencies).length
      ? { dependencies: { ...context.dependencies, ...dependencies } }
      : {}),
    ...(Object.keys(devDependencies).length
      ? { devDependencies: { ...context.devDependencies, ...devDependencies } }
      : {}),
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
      "Duraxis registered directly in AppModule. Enable shutdown hooks in main for operating-system signal cleanup.",
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
