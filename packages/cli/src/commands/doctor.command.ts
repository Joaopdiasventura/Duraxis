import { satisfies } from "../dependencies/version-compatibility.js";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { createRequire } from "node:module";
import { exists, record, stringMap, type ProjectContext } from "../init/project-detector.js";
import type { ManagedProject } from "../init/managed-project.js";
import { requiredPackages } from "../init/initialization-planner.js";
import { installedPackage } from "../dependencies/installed-package.js";
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
    createRequire(join(project.root, "package.json")).resolve(name);
    return true;
  } catch {
    return false;
  }
}
export async function diagnostics(
  project: ProjectContext,
  managed?: ManagedProject,
  selected = "default",
): Promise<Diagnostic[]> {
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
        "Legacy ORM entities require experimentalDecorators:true, emitDecoratorMetadata:true, useDefineForClassFields:false; generated .mts/.cts modules require NodeNext",
      );
    }
  } else
    add(
      project.language === "typescript" ? "WARN" : "SKIP",
      "typescript",
      "No tsconfig.json; use explicit fields with JavaScript decorator functions",
    );
  if (!managed) {
    add(
      project.configFiles.length ? "WARN" : "FAIL",
      "configuration",
      project.configFiles.length
        ? "Executable configuration detected, not evaluated. Use config:validate --evaluate only for trusted code."
        : "Run duraxis init",
    );
    return checks;
  }
  add(
    "PASS",
    "project-files",
    `Source ${project.sourceDir}; module candidates: ${project.nestModules.join(", ") || "none"}; entry points: ${project.entryPoints.join(", ") || "none"}; existing migration directories: ${project.migrationDirectories.join(", ") || "none"}; .gitignore: ${project.hasGitignore ? "present" : "absent"}. Inspection is bounded and does not execute source.`,
  );
  const options = managed.connections[selected];
  if (!options) {
    add("FAIL", "connection", "Unknown named connection");
    return checks;
  }
  add(
    "PASS",
    "configuration",
    `Managed version 1; connections: ${Object.keys(managed.connections).join(", ")}`,
  );
  for (const name of [...requiredPackages(options), "@duraxis/cli"])
    add(
      available(project, name) ? "PASS" : "FAIL",
      `package:${name}`,
      available(project, name)
        ? "Resolvable without executing package code"
        : `Install ${name} in ${project.root}`,
    );
  for (const name of requiredPackages(options)) {
    const manifest = await installedPackage(project.root, name);
    if (!manifest) continue;
    try {
      if (record(manifest.engines) && typeof manifest.engines.node === "string")
        add(
          satisfies(process.versions.node, manifest.engines.node) ? "PASS" : "FAIL",
          `engines:${name}`,
          `Installed ${name} Node.js engine compatibility`,
        );
      for (const [peer, range] of Object.entries(stringMap(manifest.peerDependencies))) {
        const installed = await installedPackage(project.root, peer);
        const peerMeta = record(manifest.peerDependenciesMeta)
          ? manifest.peerDependenciesMeta[peer]
          : undefined;
        if (!installed && record(peerMeta) && peerMeta.optional === true) continue;
        add(
          installed && typeof installed.version === "string" && satisfies(installed.version, range)
            ? "PASS"
            : "FAIL",
          `peer:${name}:${peer}`,
          `Requires ${peer} ${range}; install compatible peer dependencies`,
        );
      }
    } catch {
      add(
        "WARN",
        `compatibility:${name}`,
        "Installed metadata uses unsupported version range syntax; verify compatibility manually",
      );
    }
  }
  add(
    options.framework !== "nestjs" || options.orm ? "PASS" : "FAIL",
    "framework",
    `${options.framework}${options.framework === "nestjs" ? "; import generated module and enableShutdownHooks()" : ""}`,
  );
  if (options.cursorKeyEnv)
    add(
      /^[a-fA-F0-9]{64}$/.test(process.env[options.cursorKeyEnv] ?? "") ? "PASS" : "FAIL",
      "cursor-key",
      `Provision ${options.cursorKeyEnv} securely as 32 bytes in hex (value redacted)`,
    );
  if (options.driver === "s3")
    add(
      options.bucket || process.env.DURAXIS_S3_BUCKET ? "PASS" : "FAIL",
      "storage",
      "S3 configuration only; credentials use the default AWS chain, connectivity not tested",
    );
  else
    add(
      "PASS",
      "storage",
      options.driver === "memory"
        ? "Volatile storage; independent CLI processes do not share data"
        : options.driver === "disk"
          ? "Exclusive directory ownership required; no automatic lock recovery"
          : "Custom implementation must enforce conditional operations and bounded reads",
    );
  if (options.migrations) {
    const base = selected === "default" ? "duraxis" : `duraxis/${selected}`;
    add(
      (await exists(join(project.root, base, "snapshots/baseline.json"))) ? "PASS" : "FAIL",
      "migrations",
      "Baseline and directories checked statically; use migrate:check --offline for artifact validation (executes trusted migration modules)",
    );
  } else add("SKIP", "migrations", "Disabled");
  add(
    "SKIP",
    "connectivity",
    "No database opened; use storage:check --live explicitly where supported",
  );
  return checks;
}
