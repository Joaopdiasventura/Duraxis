import { readFile } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import ts from "typescript";
import type { CLIIO } from "../cli.js";
import type { ParsedCommand } from "../registry/argument-parser.js";
import type { ProjectContext } from "../init/project-detector.js";
import {
  inspectStaticConfig,
  property,
  replaceExpression,
  setLiteralProperty,
} from "../init/static-config.js";
import { validateConnectionName as connectionName } from "@duraxis/core";
import { initializationOptions } from "../init/initialization-options.js";
import { entitySource, extensions, configurationSource } from "../templates/project.js";
import { addFile, executeFiles, describePlan, type FilePlan } from "../filesystem/file-plan.js";
import { requiredPackages } from "../init/initialization-planner.js";
import { resolveDependencies } from "../dependencies/dependency-resolver.js";
import { RegistryClient } from "../dependencies/registry-client.js";
import { configuredRegistry } from "../dependencies/configured-registry.js";
import { installCommands, runProcess } from "../dependencies/package-manager.js";

export async function minimalAdmin(
  parsed: ParsedCommand,
  io: CLIIO,
  project: ProjectContext,
  path: string,
  redact: (value: unknown) => unknown,
): Promise<unknown> {
  const source = await readFile(path, "utf8");
  const { values, positionals, definition } = parsed;
  let inspected: ReturnType<typeof inspectStaticConfig>;
  try {
    inspected = inspectStaticConfig(source, path);
  } catch (error) {
    if (definition.name === "config:show")
      return {
        unresolved: true,
        files: [path],
        message:
          "Executable configuration was not evaluated. Use --evaluate explicitly for trusted application code.",
      };
    throw error;
  }
  const selected = values.database ?? inspected.defaultConnection;
  const object = inspected.connections.get(selected);
  if (!object) throw new Error("Unknown named database");
  connectionName(selected);
  for (const name of inspected.connections.keys()) connectionName(name);
  const files: FilePlan = {
    root: project.root,
    files: [],
    directories: [],
    warnings: [],
    dependencies: {},
    devDependencies: {},
    commands: [],
  };
  const finish = async () => {
    if (values["dry-run"]) return { status: "planned", ...describePlan(files) };
    await executeFiles(files, async () => {
      for (const [command, ...args] of files.commands)
        await (io.runProcess ?? runProcess)({
          command: command!,
          args,
          cwd: project.root,
          signal: io.signal,
        });
    });
    return {
      status: "updated",
      files: files.files.map((file) => file.path),
      warnings: files.warnings,
    };
  };
  const configPath = relative(project.root, path).replaceAll("\\", "/");
  if (definition.name === "config:show")
    return {
      configuration: redact(inspected.value),
      connection: selected,
      databaseOpened: false,
      trustedCodeEvaluated: false,
    };
  if (definition.name === "connection:list")
    return {
      default: inspected.defaultConnection,
      connections: [...inspected.connections.keys()].map((name) => ({ name })),
    };
  if (definition.name === "config:validate" || definition.name === "storage:check") {
    const errors = (inspected.ast as unknown as { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics;
    if (errors.length) throw new Error("Invalid configuration syntax");
    for (const [name, connection] of inspected.connections) {
      if (!property(connection, "driver")) throw new Error(`Missing driver for ${name}`);
      if (property(connection, "migrations")?.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        const schema = property(connection, "schema")?.initializer;
        if (
          schema &&
          ts.isObjectLiteralExpression(schema) &&
          property(schema, "mode")?.initializer &&
          ts.isStringLiteral(property(schema, "mode")!.initializer) &&
          (property(schema, "mode")!.initializer as ts.StringLiteral).text === "create"
        )
          throw new Error("Migrations require schema validation");
      }
    }
    return {
      valid: true,
      databaseOpened: false,
      trustedCodeEvaluated: false,
      message:
        "Static structure validated. Driver factories and environment expressions remain unevaluated; use --evaluate for trusted runtime validation.",
    };
  }
  if (definition.name === "config:set") {
    const [key, text] = positionals;
    if (!key || text === undefined || /[\r\n\0]/.test(text))
      throw new Error("Usage: config:set <key> <value>; control characters are forbidden");
    const supported = [
      "namespace",
      "schemaMode",
      "bucket",
      "prefix",
      "region",
      "endpoint",
      "storageDirectory",
    ];
    if (!supported.includes(key))
      throw new Error(
        "Unsupported key; edit advanced configuration manually. Secrets must use environment references.",
      );
    if (
      key === "namespace" &&
      (!/^[A-Za-z0-9_/-]{1,128}$/.test(text) ||
        text.split("/").some((part) => !part || part === ".."))
    )
      throw new Error("Invalid namespace");
    if (key === "bucket" && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text))
      throw new Error("Invalid bucket");
    if (key === "endpoint") {
      const url = new URL(text);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Endpoint must not contain secrets");
    }
    let updated: string;
    if (key === "namespace" || key === "schemaMode") {
      const field = key === "namespace" ? "database" : "schema";
      const innerKey = key === "namespace" ? "namespace" : "mode";
      if (key === "schemaMode" && !["create", "validate", "validate-managed"].includes(text))
        throw new Error("Invalid schemaMode");
      const migrations = property(object, "migrations")?.initializer;
      if (
        key === "schemaMode" &&
        text === "create" &&
        migrations &&
        migrations.kind !== ts.SyntaxKind.FalseKeyword
      )
        throw new Error("Migrations require validation schema mode");
      const target = property(object, field);
      if (target && !ts.isObjectLiteralExpression(target.initializer))
        throw new Error("Dynamic configuration requires manual editing");
      updated = target
        ? setLiteralProperty(
            source,
            target.initializer as ts.ObjectLiteralExpression,
            innerKey,
            JSON.stringify(text),
            inspected.ast,
          )
        : setLiteralProperty(
            source,
            object,
            field,
            `{ ${innerKey}: ${JSON.stringify(text)} }`,
            inspected.ast,
          );
    } else {
      const driver = property(object, "driver")?.initializer;
      if (!driver || !ts.isArrowFunction(driver))
        throw new Error("Custom driver factories require manual editing");
      const body = driver.body;
      if (
        (!ts.isNewExpression(body) && !ts.isCallExpression(body)) ||
        body.arguments?.length !== 1 ||
        !ts.isObjectLiteralExpression(body.arguments[0]!)
      )
        throw new Error("Custom driver options require manual editing");
      let options = body.arguments[0] as ts.ObjectLiteralExpression;
      if (key === "region" || key === "endpoint") {
        const client = property(options, "client")?.initializer;
        if (!client || !ts.isObjectLiteralExpression(client))
          throw new Error("Custom client options require manual editing");
        options = client;
      }
      const driverKey = key === "storageDirectory" ? "directory" : key;
      const target = property(options, driverKey);
      if (key === "storageDirectory")
        (await import("../init/initialization-options.js")).assertStorageDirectory(
          project.root,
          text,
          project.sourceDir,
          !!property(object, "migrations"),
        );
      let expression = target?.initializer;
      if (
        expression &&
        ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "resolvePath" &&
        expression.arguments.length === 1
      )
        expression = expression.arguments[0];
      if (
        expression &&
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        ts.isStringLiteral(expression.right)
      )
        expression = expression.right;
      if (
        expression &&
        ts.isPropertyAccessExpression(expression) &&
        expression.expression.getText(inspected.ast) === "env" &&
        (key === "endpoint" || key === "prefix" || key === "bucket")
      ) {
        updated = replaceExpression(
          source,
          expression,
          `${expression.getText(inspected.ast)} ?? ${JSON.stringify(text)}`,
          inspected.ast,
        );
      } else {
        if (!expression || !ts.isStringLiteral(expression))
          throw new Error(
            "Only literal driver settings or generated environment fallbacks can be changed safely; edit this expression manually",
          );
        updated = replaceExpression(source, expression, JSON.stringify(text), inspected.ast);
      }
    }
    await addFile(files, configPath, updated, true);
    return finish();
  }
  if (definition.name === "connection:add") {
    const name = connectionName(positionals[0] ?? "");
    if (inspected.connections.has(name)) throw new Error("Connection already exists");
    if (
      [...inspected.connections.keys()].some(
        (existing) =>
          existing.toUpperCase().replace(/-/g, "_") === name.toUpperCase().replace(/-/g, "_"),
      )
    )
      throw new Error("Connection names collide after environment variable normalization");
    for (const [existingName, existing] of inspected.connections) {
      const automatic = property(existing, "autoLoadEntities")?.initializer;
      const directories =
        automatic && ts.isObjectLiteralExpression(automatic)
          ? property(automatic, "directories")?.initializer
          : undefined;
      const scoped =
        directories &&
        ts.isArrayLiteralExpression(directories) &&
        directories.elements.length > 0 &&
        directories.elements.every(ts.isStringLiteral);
      if (
        automatic &&
        automatic.kind !== ts.SyntaxKind.FalseKeyword &&
        !scoped &&
        !property(existing, "entities")
      )
        throw new Error(
          `Narrow connection ${existingName} discovery to explicit directories before adding another connection; this prevents cross-connection entity leakage. No files were written.`,
        );
    }
    const options = await initializationOptions(project, {
      ...values,
      namespace: values.namespace ?? name,
      language: values.language ?? (/\.[cm]?ts$/.test(path) ? "typescript" : "javascript"),
      "source-dir": dirname(configPath),
      framework: values.framework ?? (project.nestjs ? "nestjs" : "standalone"),
    });
    if (
      (options.language === "typescript" ? !/\.[cm]?ts$/.test(path) : !/\.[cm]?js$/.test(path)) ||
      options.moduleFormat !== project.moduleFormat
    )
      throw new Error(
        "Named connections must use the existing configuration language and module format",
      );
    if (options.driver === "disk" && !values["storage-directory"])
      throw new Error("Named Disk connections require an explicit distinct --storage-directory");
    if (options.driver === "disk") {
      const { staticDriverInfo } = await import("../init/static-config.js");
      for (const existing of inspected.connections.values()) {
        const info = staticDriverInfo(inspected, existing);
        if (
          info.driver === "disk" &&
          info.directory &&
          resolve(project.root, info.directory) === resolve(project.root, options.storageDirectory)
        )
          throw new Error(
            "Named Disk connections require distinct storage directories to avoid ownership conflicts",
          );
      }
    }
    let alias = "DuraxisAddedStorage";
    while (source.includes(alias)) alias += "Next";
    const generated = configurationSource(
      { defaultConnection: name, connections: { [name]: options } },
      alias,
    );
    const addition = inspectStaticConfig(generated, path);
    const connection = addition.connections.get(name)!;
    let updated: string;
    const named = property(inspected.object, "connections");
    if (named)
      updated = setLiteralProperty(
        source,
        named.initializer as ts.ObjectLiteralExpression,
        JSON.stringify(name),
        connection.getText(addition.ast),
        inspected.ast,
      );
    else
      updated = replaceExpression(
        source,
        inspected.object,
        `{ defaultConnection: "default", connections: { default: ${inspected.object.getText(inspected.ast)}, ${JSON.stringify(name)}: ${connection.getText(addition.ast)} } }`,
        inspected.ast,
      );
    const imports = addition.ast.statements.filter((statement) => {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
        return statement.moduleSpecifier.text !== "@duraxis/core";
      if (!ts.isVariableStatement(statement)) return false;
      return !statement.declarationList.declarations.some((declaration) => {
        const call = declaration.initializer;
        return (
          call &&
          ts.isCallExpression(call) &&
          call.expression.getText(addition.ast) === "require" &&
          call.arguments[0] &&
          ts.isStringLiteral(call.arguments[0]) &&
          call.arguments[0].text === "@duraxis/core"
        );
      });
    });
    updated =
      imports.map((statement) => statement.getText(addition.ast)).join("\n") + "\n" + updated;
    await addFile(files, configPath, updated, true);
    if (options.migrations) {
      const base = `duraxis/${name}`;
      files.directories.push(`${base}/migrations`, `${base}/snapshots`);
      const { createSnapshot } = await import("@duraxis/migrations");
      await addFile(
        files,
        `${base}/snapshots/baseline.json`,
        JSON.stringify(createSnapshot(null, null, []), null, 2) + "\n",
      );
    }
    const needed = requiredPackages(options);
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
      : Object.fromEntries(needed.map((name) => [name, existing[name] ?? "latest"]));
    files.dependencies = Object.fromEntries(
      Object.entries(resolved).filter(([name]) => !existing[name]),
    );
    files.commands = options.install
      ? installCommands(options.manager, files.dependencies, {})
      : [];
    if (Object.keys(files.dependencies).length)
      await addFile(
        files,
        "package.json",
        JSON.stringify(
          { ...project.manifest, dependencies: { ...project.dependencies, ...files.dependencies } },
          null,
          2,
        ) + "\n",
        true,
      );
    return finish();
  }
  if (definition.name === "generate:entity" || definition.name === "generate:module") {
    const name = positionals[0];
    if (!name || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(name))
      throw new Error("Use a PascalCase identifier (letters and digits only)");
    const format = extensions(project);
    const base = `${dirname(configPath)}/features/${selected}`;
    if (definition.name === "generate:entity") {
      if (!property(object, "autoLoadEntities") && !property(object, "entities"))
        throw new Error("Entity generation requires ORM integration");
      await addFile(
        files,
        `${base}/${name.replace(/[A-Z]/g, (letter, index: number) => `${index ? "-" : ""}${letter.toLowerCase()}`)}.entity.${format.source}`,
        entitySource(name, name.toLowerCase() + "s", project.language, project.moduleFormat),
      );
    } else {
      if (!project.nestjs) throw new Error("Module generation requires NestJS integration");
      if (project.language !== "typescript")
        throw new Error(
          "JavaScript feature modules require explicit application registration; use DuraxisModule.forFeature([])",
        );
      const entityFile = `${name.replace(/[A-Z]/g, (letter, index: number) => `${index ? "-" : ""}${letter.toLowerCase()}`)}.entity`;
      const hasEntity = await (
        await import("../init/project-detector.js")
      ).exists(join(project.root, `${base}/${entityFile}.${format.source}`));
      await addFile(
        files,
        `${base}/${name.toLowerCase()}.module.ts`,
        `import { Module } from "@nestjs/common";\nimport { DuraxisModule } from "@duraxis/nestjs";\n${hasEntity ? `import { ${name} } from "./${entityFile}.${format.runtime}";\n` : ""}\n@Module({ imports: [DuraxisModule.forFeature([${hasEntity ? name : ""}], ${JSON.stringify(selected)})], exports: [DuraxisModule] })\nexport class ${name}Module {}\n`,
      );
    }
    return finish();
  }
  throw new Error(`Unsupported operation for executable configuration: ${definition.name}`);
}
