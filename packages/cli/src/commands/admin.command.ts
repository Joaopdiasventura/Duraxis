import { compare, satisfies } from "../dependencies/version-compatibility.js";
import { diagnostics, available } from "./doctor.command.js";
import { installedPackage } from "../dependencies/installed-package.js";
import { configuredRegistry } from "../dependencies/configured-registry.js";
import { resolve, join, dirname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { CLIIO } from "../cli.js";
import type { ParsedCommand } from "../registry/argument-parser.js";
import { detectProject, exists } from "../init/project-detector.js";
import { findManagedRoot, readManaged, connectionName } from "../init/managed-project.js";
import { initializationOptions, assertStorageDirectory } from "../init/initialization-options.js";
import { planInitialization, requiredPackages } from "../init/initialization-planner.js";
import { addFile, executeFiles, describePlan, type FilePlan } from "../filesystem/file-plan.js";
import { extensions, entitySource } from "../templates/project.js";
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
  const { values, definition, positionals } = parsed;
  const cwd = values.directory
    ? resolve(io.cwd ?? process.cwd(), values.directory)
    : (io.cwd ?? process.cwd());
  const explicit = values.config ? resolve(cwd, values.config) : undefined;
  if (explicit && !(await exists(explicit)))
    throw new Error("Explicit configuration file does not exist");
  const explicitManaged =
    explicit &&
    /^duraxis\.config\.[cm]?[jt]s$/.test(basename(explicit)) &&
    (await exists(join(dirname(explicit), "duraxis.project.json")));
  const managedRoot = explicit
    ? explicitManaged
      ? dirname(explicit)
      : undefined
    : values.directory
      ? (await exists(join(cwd, "duraxis.project.json")))
        ? cwd
        : undefined
      : await findManagedRoot(cwd);
  if (values.directory && !managedRoot)
    throw new Error("The selected directory has no managed Duraxis project; run init there first");
  const project = await detectProject(managedRoot ?? (explicit ? dirname(explicit) : cwd));
  if (explicit) project.configFiles = [basename(explicit)];
  const root = managedRoot ?? project.root;
  const managed = managedRoot ? await readManaged(root) : undefined;
  const selected = values.database ?? managed?.defaultConnection ?? "default";
  const selectedOptions = managed?.connections[selected];
  const execute = async (files: FilePlan, after: () => Promise<void> = async () => {}) => {
    if (values["dry-run"]) return { status: "planned", ...describePlan(files) };
    await executeFiles(files, after);
    return { status: "updated", files: files.files.map((f) => f.path), warnings: files.warnings };
  };
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
      configured: selectedOptions?.driver === driver.driver,
    }));
  if (definition.name === "doctor") {
    const checks = await diagnostics(project, managed, selected);
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
      if (
        selectedOptions?.driver === "disk" &&
        !(await exists(
          resolve(
            root,
            process.env[
              (selected === "default"
                ? "DURAXIS"
                : "DURAXIS_" + selected.toUpperCase().replace(/-/g, "_")) + "_STORAGE_DIRECTORY"
            ] ?? selectedOptions.storageDirectory,
            "journal.log",
          ),
        ))
      )
        throw new Error(
          "Live Disk check requires an existing initialized directory; refusing to create database files",
        );
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
  if (!managed)
    return (() => {
      if (definition.name === "config:show" || definition.name === "config:validate") {
        if (!project.configFiles.length && !values.config)
          throw new Error("No configuration found; run duraxis init");
        return {
          unresolved: true,
          files: values.config ? [resolve(cwd, values.config)] : project.configFiles,
          message:
            "Executable configuration was not evaluated. Use --evaluate explicitly for trusted application code.",
        };
      }
      throw new Error(
        "This operation requires duraxis.project.json managed settings; preserve executable configurations and integrate manually.",
      );
    })();
  if (!selectedOptions) throw new Error("Unknown named database");
  if (definition.name === "connection:list")
    return {
      default: managed.defaultConnection,
      connections: Object.entries(managed.connections).map(([name, connection]) => ({
        name,
        driver: connection.driver,
        namespace: connection.namespace,
        migrations: connection.migrations,
      })),
    };
  if (definition.name === "config:show")
    return {
      configuration: redact(selectedOptions),
      connection: selected,
      environment: "Values are not read or displayed",
      databaseOpened: false,
    };
  if (definition.name === "config:validate" || definition.name === "storage:check") {
    const checks = await diagnostics(project, managed, selected);
    return {
      failed: checks.some((c) => c.level === "FAIL"),
      diagnostics: checks,
      databaseOpened: false,
    };
  }
  if (definition.name === "config:set") {
    const [key, value] = positionals;
    if (!key || value === undefined) throw new Error("Usage: config:set <key> <value>");
    if (
      !new Set([
        "namespace",
        "storageDirectory",
        "bucket",
        "prefix",
        "region",
        "endpoint",
        "schemaMode",
      ]).has(key)
    )
      throw new Error(
        "Unsupported managed key; edit application factories and settings manually. Secrets must use environment references.",
      );
    if (key === "storageDirectory" && selectedOptions.driver === "disk")
      assertStorageDirectory(root, value, selectedOptions.sourceDir, selectedOptions.migrations);
    if (
      key === "namespace" &&
      (!/^[A-Za-z0-9_/-]{1,128}$/.test(value) ||
        value.split("/").some((part) => !part || part === ".."))
    )
      throw new Error("Invalid namespace");
    if (key === "schemaMode" && !["create", "validate", "validate-managed"].includes(value))
      throw new Error("Invalid schemaMode");
    if (key === "schemaMode" && selectedOptions.migrations && value === "create")
      throw new Error("Migrations require validation schema mode");
    if (key === "endpoint") {
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Endpoint must not contain secrets");
    }
    if (/[\r\n\0]/.test(value))
      throw new Error("Configuration values must not contain control characters");
    if (key === "bucket" && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value))
      throw new Error("Invalid bucket");
    const files = plan(root);
    await addFile(
      files,
      "duraxis.project.json",
      JSON.stringify(
        {
          ...managed,
          connections: { ...managed.connections, [selected]: { ...selectedOptions, [key]: value } },
        },
        null,
        2,
      ) + "\n",
      true,
    );
    return execute(files);
  }
  if (definition.name === "connection:add") {
    const name = connectionName(positionals[0] ?? "");
    const options = await initializationOptions(project, {
      ...values,
      namespace: values.namespace ?? name,
      language: values.language ?? selectedOptions.language,
      "module-format": values["module-format"] ?? selectedOptions.moduleFormat,
      "source-dir": values["source-dir"] ?? selectedOptions.sourceDir,
    });
    if (
      options.driver === "disk" &&
      Object.values(managed.connections).some(
        (existing) =>
          existing.driver === "disk" && existing.storageDirectory === options.storageDirectory,
      )
    )
      throw new Error(
        "Named Disk connections require a distinct --storage-directory to avoid ownership conflicts",
      );
    const needed = [...requiredPackages(options), "@duraxis/cli"];
    const existing = { ...project.dependencies, ...project.devDependencies };
    const resolved = options.install
      ? await resolveDependencies(
          needed,
          existing,
          new RegistryClient(
            await configuredRegistry(project, values.registry),
            io.fetch,
            io.signal,
          ),
          values.prerelease,
        )
      : Object.fromEntries(needed.map((n) => [n, existing[n] ?? "latest"]));
    const dependencies = Object.fromEntries(
      Object.entries(resolved).filter(
        ([n]) => n !== "@duraxis/cli" && needed.includes(n) && !existing[n],
      ),
    );
    const dev: Record<string, string> = existing["@duraxis/cli"]
      ? {}
      : { "@duraxis/cli": resolved["@duraxis/cli"]! };
    const files = await planInitialization(project, options, dependencies, dev, managed, name);
    files.commands = options.install ? installCommands(options.manager, dependencies, dev) : [];
    if (options.install && !files.commands.length)
      files.commands.push([options.manager, "install"]);
    return execute(files, async () => {
      for (const [command, ...args] of files.commands)
        await (io.runProcess ?? runProcess)({
          command: command!,
          args,
          cwd: root,
          signal: io.signal,
        });
    });
  }
  if (definition.name === "generate:entity" || definition.name === "generate:module") {
    const name = positionals[0];
    if (!name || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(name))
      throw new Error("Use a PascalCase identifier (letters and digits only)");
    const files = plan(root);
    const { source, runtime } = extensions(selectedOptions);
    const base = `${selectedOptions.sourceDir}/duraxis${selected === "default" ? "" : `/connections/${selected}`}`;
    if (definition.name === "generate:entity") {
      if (!selectedOptions.orm) throw new Error("Entity generation requires ORM integration");
      const filename = `${name.replace(/[A-Z]/g, (letter, index: number) => `${index ? "-" : ""}${letter.toLowerCase()}`)}.entity`;
      await addFile(
        files,
        `${base}/${filename}.${source}`,
        entitySource(
          name,
          name.toLowerCase() + "s",
          selectedOptions.language,
          selectedOptions.moduleFormat,
        ),
      );
      const registryPath = `${base}/entities.${source}`;
      const original = await readFile(join(root, registryPath), "utf8");
      const ts = (await import("typescript")).default;
      const ast = ts.createSourceFile(registryPath, original, ts.ScriptTarget.Latest, true);
      let array: import("typescript").ArrayLiteralExpression | undefined;
      for (const statement of ast.statements) {
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === "entities" &&
              declaration.initializer &&
              ts.isArrayLiteralExpression(declaration.initializer)
            )
              array = declaration.initializer;
        if (
          ts.isExpressionStatement(statement) &&
          ts.isBinaryExpression(statement.expression) &&
          ts.isPropertyAccessExpression(statement.expression.left) &&
          statement.expression.left.getText(ast) === "exports.entities" &&
          ts.isArrayLiteralExpression(statement.expression.right)
        )
          array = statement.expression.right;
      }
      if (
        !original.startsWith("// Duraxis managed entity registry") ||
        !array ||
        array.elements.some((e) => !ts.isIdentifier(e))
      )
        throw new Error(
          "Entity registry is user-authored or unsupported; add the entity manually. No files were written.",
        );
      const imported =
        selectedOptions.language === "typescript" || selectedOptions.moduleFormat === "esm"
          ? `import { ${name} } from "./${filename}.${runtime}";\n`
          : `const { ${name} } = require("./${filename}.${runtime}");\n`;
      const updated =
        original.slice(0, array.end - 1) +
        (array.elements.length ? ", " : "") +
        name +
        original.slice(array.end - 1);
      await addFile(
        files,
        registryPath,
        "// Duraxis managed entity registry\n" +
          imported +
          updated.slice("// Duraxis managed entity registry\n".length),
        true,
      );
    } else {
      if (selectedOptions.framework !== "nestjs")
        throw new Error("Module generation requires NestJS integration");
      const es =
        selectedOptions.language === "typescript" || selectedOptions.moduleFormat === "esm";
      const imports = es
        ? `import { Module } from "@nestjs/common";\nimport { DuraxisModule } from "@duraxis/nestjs";\nimport { entities } from "./entities.${runtime}";`
        : `const { Module } = require("@nestjs/common");\nconst { DuraxisModule } = require("@duraxis/nestjs");\nconst { entities } = require("./entities.${runtime}");`;
      const metadata = `{ imports: [DuraxisModule.forFeature(entities, ${JSON.stringify(selected)})], exports: [DuraxisModule] }`;
      await addFile(
        files,
        `${base}/${name}.module.${source}`,
        `${imports}\n${selectedOptions.language === "typescript" ? `@Module(${metadata})\nexport class ${name}Module {}` : `${selectedOptions.moduleFormat === "esm" ? "export " : ""}class ${name}Module {}\nModule(${metadata})(${name}Module);\n${!es ? `exports.${name}Module = ${name}Module;` : ""}`}\n`,
      );
    }
    return execute(files);
  }
  throw new Error(`No handler for ${definition.name}`);
}
