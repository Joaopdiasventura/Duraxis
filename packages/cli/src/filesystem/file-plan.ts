import { lstat, readFile, writeFile, mkdir, rename, unlink, rmdir, chmod } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
export interface FileChange {
  path: string;
  content: string;
  before?: string;
}
export interface FilePlan {
  root: string;
  files: FileChange[];
  directories: string[];
  warnings: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  commands: string[][];
}
export function safeRelative(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => p === ".." || p === "." || !p) ||
    path.includes(":")
  )
    throw new Error(`Unsafe project path: ${path}`);
  return path;
}
export async function assertNoSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  let cursor = absolute;
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error(`Symlinks are not allowed in managed paths: ${cursor}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
}
export async function addFile(
  plan: FilePlan,
  path: string,
  content: string,
  update = false,
): Promise<void> {
  safeRelative(path);
  const target = resolve(plan.root, path);
  await assertNoSymlinks(target);
  let before: string | undefined;
  try {
    before = await readFile(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (before === content) return;
  if (before !== undefined && !update) throw new Error(`Refusing to overwrite ${path}`);
  if (plan.files.some((f) => f.path === path)) throw new Error(`Duplicate planned file: ${path}`);
  plan.files.push({ path, content, ...(before === undefined ? {} : { before }) });
}
export async function executeFiles<T>(plan: FilePlan, after: () => Promise<T>): Promise<T> {
  await assertNoSymlinks(plan.root);
  await mkdir(plan.root, { recursive: true });
  const lockPath = join(plan.root, ".duraxis-init.lock");
  const lock = await import("node:fs/promises").then((fs) => fs.open(lockPath, "wx"));
  const applied: FileChange[] = [];
  const createdDirectories: string[] = [];
  const ensureDirectory = async (path: string): Promise<void> => {
    if (path === plan.root) return;
    if (relative(plan.root, path).startsWith("..")) throw new Error("Directory escapes project");
    await assertNoSymlinks(path);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory()) throw new Error("Expected a directory");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await ensureDirectory(dirname(path));
    await mkdir(path);
    createdDirectories.push(path);
  };
  const replace = async (target: string, content: string) => {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const mode = (await lstat(target)).mode & 0o777;
      await writeFile(temporary, content, { flag: "wx", mode });
      await chmod(temporary, mode);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  try {
    for (const path of plan.directories)
      await ensureDirectory(resolve(plan.root, safeRelative(path)));
    for (const file of plan.files) {
      const target = resolve(plan.root, safeRelative(file.path));
      await assertNoSymlinks(target);
      await ensureDirectory(dirname(target));
      if (file.before === undefined) await writeFile(target, file.content, { flag: "wx" });
      else {
        if ((await readFile(target, "utf8")) !== file.before)
          throw new Error(`File changed since planning: ${file.path}`);
        await replace(target, file.content);
      }
      applied.push(file);
    }
    return await after();
  } catch (cause) {
    const failures: unknown[] = [];
    for (const file of applied.reverse())
      try {
        const target = resolve(plan.root, file.path);
        await assertNoSymlinks(target);
        if ((await readFile(target, "utf8")) !== file.content)
          throw new Error(`Rollback preserved a concurrently changed file: ${file.path}`);
        if (file.before === undefined) await unlink(target);
        else await replace(target, file.before);
      } catch (error) {
        failures.push(error);
      }
    for (const path of createdDirectories.reverse())
      await rmdir(path).catch((error) => {
        if (!["ENOTEMPTY", "ENOENT"].includes(error.code)) failures.push(error);
      });
    if (failures.length)
      throw new AggregateError(
        [cause, ...failures],
        "Initialization failed; some files changed externally and were preserved. Inspect package.json and lockfiles before retrying.",
      );
    throw cause;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Public plans describe changes without echoing secrets in existing file contents. */
export function describePlan(plan: FilePlan) {
  return {
    root: plan.root,
    files: plan.files.map((file) => ({
      path: file.path,
      action: file.before === undefined ? "create" : "modify",
      bytes: Buffer.byteLength(file.content),
    })),
    directories: plan.directories,
    dependencies: plan.dependencies,
    devDependencies: plan.devDependencies,
    commands: plan.commands,
    warnings: plan.warnings,
  };
}
