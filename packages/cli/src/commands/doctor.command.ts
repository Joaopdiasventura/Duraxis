import { satisfies } from "../dependencies/version-compatibility.js";
import { existsSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { createRequire } from "node:module";
import { exists, type ProjectContext } from "../init/project-detector.js";
interface Diagnostic {
  level: "PASS" | "WARN" | "FAIL" | "SKIP";
  check: string;
  message: string;
}
export function available(project: ProjectContext, name: string): boolean {
  if (
    !project.dependencies[name] &&
    !project.devDependencies[name] &&
    !existsSync(join(project.root, "node_modules", name))
  )
    return false;
  try {
    const require = createRequire(join(project.root, "package.json"));
    let installed = false;
    let directory = project.root;
    while (true) {
      if (
        existsSync(join(directory, ".pnp.cjs")) ||
        existsSync(join(directory, "node_modules", name))
      ) {
        installed = true;
        break;
      }
      if (dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    if (!installed) return false;
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}
export async function diagnostics(project: ProjectContext): Promise<Diagnostic[]> {
  const checks: Diagnostic[] = [];
  const add = (level: Diagnostic["level"], check: string, message: string) =>
    checks.push({ level, check, message });
  add(
    satisfies(process.versions.node, ">=24.15.0") ? "PASS" : "FAIL",
    "runtime",
    `Node.js ${process.versions.node}; requires >=24.15.0 (Bun is a package manager only)`,
  );
  add(
    project.hasManifest ? "PASS" : "FAIL",
    "manifest",
    project.hasManifest ? project.root : "Create package.json with duraxis init --yes",
  );
  add(
    project.managerConflict ? "FAIL" : "PASS",
    "package-manager",
    project.managerConflict
      ? "Conflicting lockfiles; choose --package-manager explicitly"
      : (project.manager ?? "npm default (no lockfile detected)"),
  );
  add(
    "PASS",
    "workspace",
    project.workspace
      ? `Application ${project.root}; workspace ${project.workspace}; installations use the application directory`
      : "Standalone package",
  );
  const manager = project.manager ?? "npm";
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const managerAvailable = (process.env.PATH ?? "")
    .split(delimiter)
    .slice(0, 512)
    .some((directory) => suffixes.some((suffix) => existsSync(join(directory, manager + suffix))));
  add(
    managerAvailable ? "PASS" : "WARN",
    "package-manager-availability",
    managerAvailable
      ? `${manager} executable found on PATH (not executed)`
      : `Install ${manager} or add it to PATH`,
  );
  add("PASS", "module-format", project.moduleFormat);
  if (await exists(join(project.root, "tsconfig.json"))) {
    const ts = (await import("typescript")).default;
    const parsed = ts.readConfigFile(join(project.root, "tsconfig.json"), ts.sys.readFile);
    if (parsed.error) add("FAIL", "typescript", "Cannot parse tsconfig.json");
    else {
      const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, project.root);
      const compiler = config.options;
      add(
        compiler.experimentalDecorators &&
          compiler.emitDecoratorMetadata &&
          compiler.useDefineForClassFields === false
          ? "PASS"
          : "WARN",
        "typescript",
        "ORM entities require experimentalDecorators:true, emitDecoratorMetadata:true, useDefineForClassFields:false; source configs follow package module semantics; NodeNext is supported",
      );
    }
  } else
    add(
      project.language === "typescript" ? "WARN" : "SKIP",
      "typescript",
      "No tsconfig.json; use explicit fields with JavaScript decorator functions",
    );
  if (project.configFiles.length === 1) {
    try {
      const { inspectStaticConfig, property } = await import("../init/static-config.js");
      const { readFile } = await import("node:fs/promises");
      const inspection = inspectStaticConfig(
        await readFile(join(project.root, project.configFiles[0]!), "utf8"),
        project.configFiles[0]!,
      );
      const ts = (await import("typescript")).default;
      const packages = new Set(["@duraxis/core"]);
      for (const statement of inspection.ast.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
          packages.add(statement.moduleSpecifier.text);
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations) {
            const call = declaration.initializer;
            if (
              call &&
              ts.isCallExpression(call) &&
              call.expression.getText(inspection.ast) === "require" &&
              call.arguments[0] &&
              ts.isStringLiteral(call.arguments[0])
            )
              packages.add(call.arguments[0].text);
          }
      }
      for (const connection of inspection.connections.values()) {
        if (property(connection, "entities") || property(connection, "autoLoadEntities"))
          packages.add("@duraxis/orm");
        const migrations = property(connection, "migrations");
        if (migrations && migrations.initializer.kind !== ts.SyntaxKind.FalseKeyword)
          packages.add("@duraxis/migrations");
      }
      if (project.nestjs) packages.add("@duraxis/nestjs");
      for (const name of packages)
        if (name.startsWith("@duraxis/"))
          add(
            available(project, name) ? "PASS" : "FAIL",
            `package:${name}`,
            `Runtime dependency ${name} must be installed in the application`,
          );
      add(
        "PASS",
        "static-configuration",
        `Connections: ${[...inspection.connections.keys()].join(", ")}; no executable code evaluated`,
      );
    } catch {
      add(
        "WARN",
        "static-configuration",
        "Dynamic or malformed configuration; inspect manually or use config:validate --evaluate for trusted code",
      );
    }
  }
  add(
    project.configFiles.length ? "WARN" : "FAIL",
    "configuration",
    project.configFiles.length
      ? "Executable configuration detected, not evaluated. Use config:validate --evaluate only for trusted code."
      : "Run duraxis init",
  );
  return checks;
}
