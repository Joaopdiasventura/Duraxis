import { compare, satisfies } from "../dependencies/version-compatibility.js";
import { diagnostics, available } from "./doctor.command.js";
import { installedPackage } from "../dependencies/installed-package.js";
import { configuredRegistry } from "../dependencies/configured-registry.js";
import { resolve, join, dirname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { CLIIO } from "../cli.js";
import type { ParsedCommand } from "../registry/argument-parser.js";
import { detectProject, exists } from "../init/project-detector.js";
import { executeFiles, type FilePlan } from "../filesystem/file-plan.js";
import { resolveDependencies } from "../dependencies/dependency-resolver.js";
import { RegistryClient } from "../dependencies/registry-client.js";
import { installCommands, runProcess } from "../dependencies/package-manager.js";
function plan(root: string): FilePlan {
  return {
    root,
    files: [],
    directories: [],
    warnings: [],
    dependencies: {},
    devDependencies: {},
    commands: [],
  };
}
function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 16) return "[unresolved: inspection depth limit]";
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular/shared reference]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /secret|password|token|credential|signingkey|encryption|access[_-]?key|private[_-]?key|api[_-]?key|^keys?$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(item, seen, depth + 1),
      ]),
    );
  }
  if (typeof value === "function") return "[trusted function; not evaluated]";
  if (typeof value === "string" && /^https?:/.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search) return "[REDACTED URL]";
    } catch {}
  }
  return value;
}
export async function administer(parsed: ParsedCommand, io: CLIIO): Promise<unknown> {
  const { values, definition } = parsed;
  const cwd = values.directory
    ? resolve(io.cwd ?? process.cwd(), values.directory)
    : (io.cwd ?? process.cwd());
  const explicit = values.config ? resolve(cwd, values.config) : undefined;
  if (explicit && !(await exists(explicit)))
    throw new Error("Explicit configuration file does not exist");
  const project = await detectProject(explicit ? dirname(explicit) : cwd);
  if (explicit) project.configFiles = [basename(explicit)];
  const root = project.root;
  let configuredDriver: string | undefined;
  if (project.configFiles.length === 1 && definition.name === "storage:list") {
    try {
      const { inspectStaticConfig, staticDriverInfo } = await import("../init/static-config.js");
      const inspection = inspectStaticConfig(
        await readFile(explicit ?? join(project.root, project.configFiles[0]!), "utf8"),
        explicit ?? project.configFiles[0]!,
      );
      const object = inspection.connections.get(values.database ?? inspection.defaultConnection);
      if (object) configuredDriver = staticDriverInfo(inspection, object).driver;
    } catch {
      /* Dynamic configurations remain unresolved without evaluation. */
    }
  }
  if (definition.name === "storage:list")
    return [
      {
        driver: "memory",
        persistent: false,
        limitation: "Process-local volatile data",
        package: "@duraxis/storage-memory",
      },
      {
        driver: "disk",
        persistent: true,
        limitation: "Single-owner local directory; recovery requires operator action",
        package: "@duraxis/storage-disk",
      },
      {
        driver: "s3",
        persistent: true,
        limitation:
          "Conditional-request-compatible provider required; destructive distributed GC unsupported",
        package: "@duraxis/storage-s3",
      },
      {
        driver: "custom",
        persistent: "implementation-dependent",
        limitation: "Conditional semantics and bounded reads required",
        package: "@duraxis/storage",
      },
    ].map((driver) => ({
      ...driver,
      available: true,
      installed: available(project, driver.package),
      configured: configuredDriver === driver.driver,
    }));
  if (definition.name === "doctor") {
    const checks = await diagnostics(project);
    return { failed: checks.some((c) => c.level === "FAIL"), diagnostics: checks };
  }
  if (definition.name === "upgrade") {
    const installed = Object.fromEntries(
      Object.entries({ ...project.dependencies, ...project.devDependencies }).filter(([name]) =>
        name.startsWith("@duraxis/"),
      ),
    );
    if (!Object.keys(installed).length)
      throw new Error("No Duraxis dependencies found in the selected project");
    for (const [name, specification] of Object.entries(installed)) {
      try {
        satisfies("0.0.0", specification);
      } catch {
        throw new Error(
          `Cannot upgrade unsupported dependency specification for ${name}; update workspace-owned versions with workspace release tooling, or use a supported registry version range`,
        );
      }
    }
    const resolved = await resolveDependencies(
      Object.keys(installed),
      { ...project.dependencies, ...project.devDependencies },
      new RegistryClient(await configuredRegistry(project, values.registry), io.fetch, io.signal),
      values.prerelease,
      process.versions.node,
      false,
    );
    const packages = await Promise.all(
      Object.keys(installed).map(async (name) => {
        const actual = (await installedPackage(root, name))?.version ?? installed[name];
        const downgradeBlocked =
          typeof actual === "string" &&
          /^v?\d+\.\d+\.\d+(?:[-+]|$)/.test(actual) &&
          compare(resolved[name]!, actual) < 0;
        return {
          package: name,
          installed: actual,
          declaration: installed[name],
          target: resolved[name],
          downgradeBlocked,
          status: downgradeBlocked
            ? "downgrade blocked"
            : actual === resolved[name]
              ? "up to date"
              : "update available",
        };
      }),
    );
    if (!values.apply)
      return {
        packages,
        warning:
          "Pre-1.0 minor updates may break compatibility. Review changelogs. No data format migration is performed.",
      };
    if (packages.some((item) => item.downgradeBlocked))
      throw new Error(
        "Automatic downgrades are unsupported; no dependencies were changed. Review the proposed versions and workspace release state manually.",
      );
    const production = Object.fromEntries(
      packages
        .filter((p) => project.dependencies[p.package] && p.target !== p.installed)
        .map((p) => [p.package, p.target!]),
    );
    const development = Object.fromEntries(
      packages
        .filter((p) => project.devDependencies[p.package] && p.target !== p.installed)
        .map((p) => [p.package, p.target!]),
    );
    const update = plan(root);
    update.commands = installCommands(
      (await import("../init/project-detector.js")).selectManager(
        project,
        values["package-manager"],
      ),
      production,
      development,
    );
    io.signal?.throwIfAborted();
    await executeFiles(update, async () => {
      for (const [command, ...args] of update.commands)
        await (io.runProcess ?? runProcess)({
          command: command!,
          args,
          cwd: root,
          signal: io.signal,
        });
      io.signal?.throwIfAborted();
    });
    return {
      status: "updated",
      packages,
      warning: "Review pre-1.0 changes before deployment. Database formats were not migrated.",
    };
  }
  if (values.evaluate || (definition.name === "storage:check" && values.live)) {
    const { config } = await (
      await import("../config.js")
    ).loadConfig(cwd, values.config, values.database);
    if (definition.name === "config:show")
      return { trustedCodeEvaluated: true, configuration: redact(config) };
    if (definition.name === "config:validate")
      return { valid: true, trustedCodeEvaluated: true, databaseOpened: false };
    if (definition.name === "storage:check") {
      if (project.configFiles.length === 1) {
        const { inspectStaticConfig, staticDriverInfo } = await import("../init/static-config.js");
        let inspection: ReturnType<typeof inspectStaticConfig> | undefined;
        try {
          inspection = inspectStaticConfig(
            await readFile(explicit ?? join(project.root, project.configFiles[0]!), "utf8"),
            explicit ?? project.configFiles[0]!,
          );
        } catch {
          // --live already authorized the executable factory. Run dynamic
          // factory behavior when its storage path cannot be inspected statically.
        }
        if (inspection) {
          const connection = values.database ?? inspection.defaultConnection;
          const object = inspection.connections.get(connection);
          if (!object) throw new Error("Unknown named database");
          const info = staticDriverInfo(inspection, object);
          if (info.driver === "disk") {
            const prefix =
              connection === "default"
                ? "DURAXIS"
                : `DURAXIS_${connection.toUpperCase().replace(/-/g, "_")}`;
            const directory = process.env[`${prefix}_STORAGE_DIRECTORY`] ?? info.directory;
            if (!directory || !(await exists(resolve(project.root, directory, "journal.log"))))
              throw new Error(
                "Live Disk check requires an existing initialized directory; refusing to create database files",
              );
          }
        }
      }
      const database = await config.createDatabase();
      try {
        await database.getCollectionDefinitions();
        return {
          valid: true,
          live: true,
          warning:
            "Trusted factory executed. Disk ownership was temporarily acquired; normal driver recovery may occur. No test objects were written.",
        };
      } finally {
        await database.close({ closeStorage: true });
      }
    }
  }
  const configPath =
    explicit ??
    (project.configFiles.length === 1 ? join(project.root, project.configFiles[0]!) : undefined);
  if (!configPath) throw new Error("Select a Duraxis configuration with --config, or run init");
  return (await import("./minimal-admin.js")).minimalAdmin(parsed, io, project, configPath, redact);
}
