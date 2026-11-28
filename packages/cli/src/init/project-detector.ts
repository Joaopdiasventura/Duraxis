import { readFile, access, readdir, opendir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value) || Object.values(value).some((v) => typeof v !== "string"))
    throw new Error("Expected a string-valued object");
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, String(value)]));
}
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
export async function readObject(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON syntax in ${path}; correct the file before retrying`);
  }
  if (!record(value)) throw new Error(`Expected JSON object: ${path}`);
  return value;
}
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export interface ProjectContext {
  root: string;
  manifest: Record<string, unknown>;
  hasManifest: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  manager?: PackageManager;
  managerConflict: boolean;
  workspace?: string;
  language: "typescript" | "javascript";
  moduleFormat: "esm" | "cjs";
  nestjs: boolean;
  configFiles: string[];
  environmentFiles: string[];
  sourceDir: string;
  nestModules: string[];
  entryPoints: string[];
  migrationDirectories: string[];
  hasGitignore: boolean;
}
const locks = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
} as const;
export async function detectProject(cwd: string, exact = false): Promise<ProjectContext> {
  let root = resolve(cwd);
  let directory = root;
  if (!exact)
    while (true) {
      if (await exists(join(directory, "package.json"))) {
        root = directory;
        break;
      }
      if (dirname(directory) === directory) break;
      directory = dirname(directory);
    }
  const hasManifest = await exists(join(root, "package.json"));
  const manifest = hasManifest ? await readObject(join(root, "package.json")) : {};
  const dependencies = stringMap(manifest.dependencies);
  const devDependencies = stringMap(manifest.devDependencies);
  let workspace: string | undefined;
  const detected = new Set<PackageManager>();
  directory = root;
  while (true) {
    if (directory !== root && (await exists(join(directory, "package.json")))) {
      const parent = await readObject(join(directory, "package.json"));
      if (parent.workspaces || (await exists(join(directory, "pnpm-workspace.yaml")))) {
        const manager =
          typeof parent.packageManager === "string"
            ? parent.packageManager.split("@")[0]
            : undefined;
        if (manager === "npm" || manager === "pnpm" || manager === "yarn" || manager === "bun")
          detected.add(manager);
      }
    }
    for (const [lock, manager] of Object.entries(locks))
      if (await exists(join(directory, lock))) detected.add(manager);
    if (
      directory !== root &&
      ((await exists(join(directory, "pnpm-workspace.yaml"))) ||
        ((await exists(join(directory, "package.json"))) &&
          (await readObject(join(directory, "package.json"))).workspaces))
    )
      workspace ??= directory;
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  const declared =
    typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  if (declared && !["npm", "pnpm", "yarn", "bun"].includes(declared))
    throw new Error("Unsupported packageManager field");
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun")
    detected.add(declared);
  const manager = detected.size === 1 ? [...detected][0] : undefined;
  let sourceDir =
    (await exists(join(root, "source"))) && !(await exists(join(root, "src"))) ? "source" : "src";
  const sourceRoots = new Set([sourceDir]);
  if (await exists(join(root, "nest-cli.json"))) {
    const nest = await readObject(join(root, "nest-cli.json"));
    if (typeof nest.sourceRoot === "string") sourceDir = nest.sourceRoot;
    if (record(nest.projects))
      for (const project of Object.values(nest.projects)) {
        if (record(project) && typeof project.sourceRoot === "string" && project.type !== "library")
          sourceRoots.add(project.sourceRoot);
      }
    sourceRoots.add(sourceDir);
  } else if (await exists(join(root, "tsconfig.json"))) {
    const ts = (await import("typescript")).default;
    const raw = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    if (!raw.error) {
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
      if (parsed.options.rootDir) {
        const { relative } = await import("node:path");
        const candidate = relative(root, parsed.options.rootDir).replaceAll("\\", "/");
        if (candidate && !candidate.startsWith("..")) {
          sourceDir = candidate;
          sourceRoots.add(candidate);
        }
      }
    }
  }
  const { safeRelative } = await import("../filesystem/file-plan.js");
  for (const source of sourceRoots) safeRelative(source);
  const nestModules: string[] = [];
  const entryPoints: string[] = [];
  const sourceConfigs: string[] = [];
  const visited = new Set<string>();
  const queue = [...sourceRoots].map((path) => ({ path, depth: 0 }));
  let inspected = 0;
  for (let index = 0; index < queue.length && inspected < 2000; index++) {
    const item = queue[index]!;
    if (visited.has(item.path)) continue;
    visited.add(item.path);
    if (!(await exists(join(root, item.path)))) continue;
    const directory = await opendir(join(root, item.path));
    for await (const entry of directory) {
      if (++inspected > 2000) break;
      const path = `${item.path}/${entry.name}`;
      if (
        entry.isDirectory() &&
        item.depth < 3 &&
        !["node_modules", "dist", ".git"].includes(entry.name)
      )
        queue.push({ path, depth: item.depth + 1 });
      if (entry.isFile() && /^duraxis\.config\.[cm]?[jt]s$/.test(entry.name))
        sourceConfigs.push(path);
      if (entry.isFile() && /\.module\.[cm]?[jt]s$/.test(entry.name)) nestModules.push(path);
      if (entry.isFile() && /^(?:main|index|server|app)\.[cm]?[jt]s$/.test(entry.name))
        entryPoints.push(path);
    }
  }
  const migrationDirectories: string[] = [];
  for (const path of ["duraxis/migrations", "migrations"])
    if (await exists(join(root, path))) migrationDirectories.push(path);
  const files = await readdir(root).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return {
    root,
    manifest,
    hasManifest,
    dependencies,
    devDependencies,
    manager,
    managerConflict: detected.size > 1,
    workspace,
    language:
      (await exists(join(root, "tsconfig.json"))) ||
      dependencies.typescript ||
      devDependencies.typescript ||
      [...nestModules, ...entryPoints].some((path) => /\.[cm]?ts$/.test(path))
        ? "typescript"
        : "javascript",
    moduleFormat: manifest.type === "module" ? "esm" : "cjs",
    nestjs: !!(dependencies["@nestjs/core"] || devDependencies["@nestjs/core"]),
    configFiles: [
      ...files.filter((f) => /^duraxis.config\.(?:[cm]?[jt]s)$/.test(f)),
      ...sourceConfigs,
    ],
    environmentFiles: files.filter((f) => /^\.env(?:\.|$)/.test(f)),
    sourceDir,
    nestModules,
    entryPoints,
    migrationDirectories,
    hasGitignore: await exists(join(root, ".gitignore")),
  };
}
export function selectManager(context: ProjectContext, value?: string): PackageManager {
  if (value && value !== "auto") {
    if (value === "npm" || value === "pnpm" || value === "yarn" || value === "bun") return value;
    throw new Error("Invalid package manager");
  }
  if (context.managerConflict)
    throw new Error(
      "Conflicting package managers/lockfiles. Specify --package-manager explicitly.",
    );
  return context.manager ?? "npm";
}
