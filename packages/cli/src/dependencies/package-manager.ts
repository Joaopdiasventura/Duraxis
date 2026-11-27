import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { exists, type PackageManager } from "../init/project-detector.js";
export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<void>;
export const runProcess: ProcessRunner = async (request) => {
  let command = request.command;
  let args = [...request.args];
  if (process.platform === "win32") {
    const require = createRequire(join(request.cwd, "package.json"));
    const entries: Record<string, string> = {
      npm: "npm/bin/npm-cli.js",
      pnpm: "pnpm/bin/pnpm.cjs",
      yarn: "yarn/bin/yarn.js",
    };
    if (command !== "bun") {
      let script: string | undefined;
      try {
        script = require.resolve(entries[command]!);
      } catch {
        for (const directory of (process.env.PATH ?? "").split(delimiter)) {
          const candidate = join(directory, "node_modules", entries[command] ?? "");
          if (await exists(candidate)) {
            script = candidate;
            break;
          }
        }
      }
      if (!script)
        throw new Error(
          `Cannot locate ${command} JavaScript entry point on Windows. Install it locally or use a supported Node package manager installation.`,
        );
      command = process.execPath;
      args = [script, ...args];
    } else command = "bun.exe";
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      signal: request.signal,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const forceCancellation = () => {
      cancellationTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      cancellationTimer.unref();
    };
    request.signal?.addEventListener("abort", forceCancellation, { once: true });
    if (request.signal?.aborted) forceCancellation();
    let failed = false;
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(cancellationTimer);
      request.signal?.removeEventListener("abort", forceCancellation);
      if (!failed && code === 0) resolve();
      else
        reject(
          new Error(
            `${request.command} failed (exit ${code ?? "signal"}). Installation may have changed lockfiles or run lifecycle scripts; inspect the project before retrying.`,
          ),
        );
    });
  });
};
export function installCommands(
  manager: PackageManager,
  dependencies: Record<string, string>,
  development: Record<string, string>,
): string[][] {
  const groups: readonly [boolean, Record<string, string>][] = [
    [false, dependencies],
    [true, development],
  ];
  return groups.flatMap(([dev, values]) => {
    const specs = Object.entries(values).map(([name, range]) => `${name}@${range}`);
    if (!specs.length) return [];
    return [
      [
        manager,
        manager === "npm" ? "install" : "add",
        ...(dev ? [manager === "npm" ? "--save-dev" : "-D"] : []),
        ...specs,
      ],
    ];
  });
}
