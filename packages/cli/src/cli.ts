import { parseCommand } from "./registry/argument-parser.js";
import { helpText, findCommand } from "./registry/command-registry.js";
import type { ProcessRunner } from "./dependencies/package-manager.js";
import type { Prompt } from "./terminal/prompts.js";
export interface CLIIO {
  readonly cwd?: string;
  readonly out?: (message: string) => void;
  readonly error?: (message: string) => void;
  readonly fetch?: typeof fetch;
  readonly runProcess?: ProcessRunner;
  readonly prompt?: Prompt;
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
}
export async function runCLI(args: readonly string[], io: CLIIO = {}): Promise<number> {
  const out = io.out ?? console.log;
  const error = io.error ?? console.error;
  let json = args.includes("--json");
  let migrationCommand = false;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Operation cancelled"));
  process.once("SIGINT", interrupt);
  const context = {
    ...io,
    signal: io.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal,
  };
  try {
    const parsed = parseCommand(args);
    json = parsed.values.json ?? false;
    if (parsed.values.help || parsed.definition.handler === "help") {
      const target =
        parsed.definition.handler === "help" && parsed.positionals[0]
          ? findCommand(parsed.positionals[0])
          : parsed.definition.handler === "help"
            ? undefined
            : parsed.definition;
      out(json ? JSON.stringify({ help: helpText(target) }) : helpText(target));
      return 0;
    }
    if (parsed.definition.handler === "version") {
      const { readFile } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      let root = import.meta.dirname;
      while (true) {
        try {
          const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
          if (
            manifest &&
            typeof manifest === "object" &&
            "name" in manifest &&
            manifest.name === "@duraxis/cli" &&
            "version" in manifest
          ) {
            out(json ? JSON.stringify({ version: manifest.version }) : String(manifest.version));
            return 0;
          }
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
        if (dirname(root) === root) throw new Error("CLI package version unavailable");
        root = dirname(root);
      }
    }
    if (parsed.definition.handler === "migration") {
      migrationCommand = true;
      const code = await (
        await import("./commands/migration.command.js")
      ).executeMigration(parsed, context);
      context.signal.throwIfAborted();
      return code;
    }
    const result =
      parsed.definition.handler === "init"
        ? await (await import("./commands/init.command.js")).initialize(parsed, context)
        : await (await import("./commands/admin.command.js")).administer(parsed, context);
    out(
      json
        ? JSON.stringify(result)
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2),
    );
    return result && typeof result === "object" && "failed" in result && result.failed === true
      ? 1
      : 0;
  } catch (cause) {
    const cleanupFailed = cause instanceof Error && cause.name === "DuraxisMigrationCleanupError";
    const message = cleanupFailed
      ? "Migration database cleanup failed; inspect storage health and migration status before retrying"
      : context.signal.aborted
        ? migrationCommand
          ? "Migration operation cancelled. Inspect local artifacts and migrate:status before retrying; publication may have completed."
          : "Operation cancelled"
        : cause instanceof Error
          ? cause.message
          : "Command failed";
    error(
      json
        ? JSON.stringify({
            error: {
              code: cleanupFailed
                ? "CLEANUP_FAILED"
                : context.signal.aborted
                  ? "CANCELLED"
                  : "COMMAND_FAILED",
              message,
            },
          })
        : message,
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
