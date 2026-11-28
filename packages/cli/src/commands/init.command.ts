import { configuredRegistry } from "../dependencies/configured-registry.js";
import { resolve } from "node:path";
import type { CLIIO } from "../cli.js";
import type { ParsedCommand } from "../registry/argument-parser.js";
import { detectProject, exists } from "../init/project-detector.js";
import { initializationOptions } from "../init/initialization-options.js";
import { planInitialization, requiredPackages } from "../init/initialization-planner.js";
import { executeFiles, describePlan } from "../filesystem/file-plan.js";
import { RegistryClient } from "../dependencies/registry-client.js";
import { resolveDependencies } from "../dependencies/dependency-resolver.js";
import { installCommands, runProcess } from "../dependencies/package-manager.js";
import { withPrompts, type Prompt } from "../terminal/prompts.js";
export async function initialize(parsed: ParsedCommand, io: CLIIO): Promise<unknown> {
  const values = { ...parsed.values };
  const project = await detectProject(
    resolve(io.cwd ?? process.cwd(), values.directory ?? "."),
    !!values.directory,
  );
  if (
    !values.directory &&
    project.root !== resolve(io.cwd ?? process.cwd()) &&
    (project.manifest.workspaces || (await exists(resolve(project.root, "pnpm-workspace.yaml"))))
  )
    throw new Error(
      "Initialization from a nested directory would target the workspace root. Select the application explicitly with --directory; use --directory . to create a new package here.",
    );
  if (await exists(resolve(project.root, ".duraxis-init.lock")))
    throw new Error(
      "Another initialization/update owns .duraxis-init.lock. Wait for it to finish; inspect stale guards before manual removal.",
    );
  if (project.configFiles.length)
    return {
      status: "already-initialized",
      root: project.root,
      configuration: project.configFiles,
      actions: ["config:show", "doctor"],
    };
  const interactive =
    io.interactive ?? (process.stdin.isTTY && process.stdout.isTTY && !values.json);
  if (values.framework === "auto") values.framework = project.nestjs ? "nestjs" : "standalone";
  const wizard = async (ask: Prompt) => {
    if (
      !project.hasManifest &&
      (await ask("Create a minimal Node.js project manifest?", "yes", ["yes", "no"])) !== "yes"
    )
      throw new Error("Initialization cancelled");
    values.framework ??= await ask("Integration", project.nestjs ? "nestjs" : "standalone", [
      "standalone",
      "nestjs",
    ]);
    values.driver ??= await ask("Storage driver", "disk", ["disk", "memory", "s3", "custom"]);
    if (values.framework === "nestjs") {
      if (values["no-orm"]) throw new Error("NestJS requires ORM");
      values.orm = true;
    } else if (values.orm === undefined && !values["no-orm"])
      values.orm = (await ask("Enable ORM?", "yes", ["yes", "no"])) === "yes";
    if (values.migrations === undefined && !values["no-migrations"])
      values.migrations =
        (await ask("Enable migrations?", values.driver === "memory" ? "no" : "yes", [
          "yes",
          "no",
        ])) === "yes";
    values.namespace ??= await ask("Database namespace (not an authorization boundary)", "default");
    if (values.driver === "s3") {
      values.bucket ??= await ask("S3 bucket", "");
      values.region ??= await ask("AWS region", "us-east-1");
    }
    if (values.driver === "custom")
      values["custom-module"] ??= await ask("Trusted custom storage module", "./storage.mjs");
    if (project.managerConflict)
      values["package-manager"] ??= await ask("Package manager", "npm", [
        "npm",
        "pnpm",
        "yarn",
        "bun",
      ]);
    if ((await ask("Configure advanced settings?", "no", ["yes", "no"])) === "yes") {
      values["source-dir"] ??= await ask("Source directory", "src");
      if (values.driver === "disk")
        values["storage-directory"] ??= await ask("Storage directory", "./data/duraxis");
      values["schema-mode"] ??= await ask(
        "Schema mode",
        values.migrations ? "validate-managed" : "create",
        ["create", "validate", "validate-managed"],
      );
    }
    if (values.orm && values.example === undefined && !values["no-example"])
      values.example = (await ask("Generate example entity?", "no", ["yes", "no"])) === "yes";
    if (values.install === undefined && !values["no-install"])
      values.install =
        (await ask("Install required dependencies?", "yes", ["yes", "no"])) === "yes";
  };
  if (!values.yes && !values["dry-run"]) {
    if (!interactive)
      throw new Error(
        "Non-interactive initialization requires --yes or --dry-run. No files were changed.",
      );
    if (io.prompt) await wizard(io.prompt);
    else await withPrompts(wizard, io.signal);
  }
  const options = await initializationOptions(project, values);
  const requested = [
    ...requiredPackages(options),
    "@duraxis/cli",
    ...(options.language === "typescript" ? ["typescript", "@types/node"] : []),
  ];
  const existing = { ...project.dependencies, ...project.devDependencies };
  const resolved = options.install
    ? await resolveDependencies(
        requested,
        existing,
        new RegistryClient(await configuredRegistry(project, values.registry), io.fetch, io.signal),
        values.prerelease,
      )
    : Object.fromEntries(requested.map((name) => [name, existing[name] ?? "latest"]));
  const devNames = new Set(["@duraxis/cli", "typescript", "@types/node"]);
  const dependencies = Object.fromEntries(
    Object.entries(resolved).filter(
      ([name]) =>
        (!devNames.has(name) || !!project.dependencies[name]) &&
        (requested.includes(name) || !name.startsWith("@duraxis/")) &&
        (!existing[name] || existing[name] !== resolved[name]),
    ),
  );
  const development = Object.fromEntries(
    Object.entries(resolved).filter(
      ([name]) =>
        devNames.has(name) &&
        !project.dependencies[name] &&
        (!existing[name] || existing[name] !== resolved[name]),
    ),
  );
  const plan = await planInitialization(project, options, dependencies, development);
  plan.commands = options.install
    ? installCommands(options.manager, dependencies, development)
    : [];
  if (options.install && !plan.commands.length) plan.commands.push([options.manager, "install"]);
  io.signal?.throwIfAborted();
  if (values["dry-run"]) return { status: "planned", ...describePlan(plan) };
  await executeFiles(plan, async () => {
    io.signal?.throwIfAborted();
    for (const [command, ...args] of plan.commands)
      await (io.runProcess ?? runProcess)({
        command: command!,
        args,
        cwd: project.root,
        signal: io.signal,
      });
    io.signal?.throwIfAborted();
  });
  return {
    status:
      options.driver === "custom"
        ? "configured-custom-driver-not-evaluated"
        : options.install
          ? "initialized"
          : "configured-dependencies-not-installed",
    databaseOpened: false,
    dependenciesInstalled: options.install,
    root: project.root,
    files: plan.files.map((f) => f.path),
    dependencies,
    devDependencies: development,
    warnings: plan.warnings,
    next: options.migrations
      ? options.orm
        ? [
            "Review entities",
            "duraxis migration:generate initial",
            "duraxis migrate:up",
            "Start application after migrations",
          ]
        : [
            "duraxis migration:create initial",
            "Implement the manual migration",
            "duraxis migration:snapshot --schema collections.json",
            "duraxis migrate:up",
          ]
      : [
          "Import createDatabase from @duraxis/core or createORM from @duraxis/orm and pass your duraxis.config",
          "Always close resources in finally",
        ],
  };
}
