import { readFileSync, statSync } from "node:fs";
import { registerHooks, type ModuleHooks } from "node:module";
import { extname, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { assertSupportedRuntime } from "./runtime.mjs";

const sourceExtensions: Readonly<Record<string, string>> = {
  ".js": ".ts",
  ".mjs": ".mts",
  ".cjs": ".cts",
};
let hooks: ModuleHooks | undefined;
const modules = new Set<string>();

function localFile(value: string): URL | undefined {
  if (!value.startsWith("file:")) return;
  const url = new URL(value);
  const path = fileURLToPath(url);
  if (path.split(/[\\/]/).includes("node_modules")) return;
  return url;
}
function exists(url: URL): boolean {
  try {
    return statSync(url).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
function remember(url: string): void {
  if (localFile(url)) modules.add(url);
}

/** One hook pair per library instance, limited to explicitly loaded local module graphs. */
export function initializeTypeScriptLoader(entry: URL): void {
  assertSupportedRuntime();
  remember(entry.href);
  if (hooks) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const relative = /^(?:\.{1,2}[\\/]|\/|file:)/.test(specifier);
      const managed =
        relative &&
        (modules.has(specifier) ||
          (context.parentURL !== undefined && modules.has(context.parentURL)));
      try {
        const resolved = nextResolve(specifier, context);
        if (managed) remember(resolved.url);
        return resolved;
      } catch (error) {
        if (
          !managed ||
          !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        const requested = localFile(new URL(specifier, context.parentURL).href);
        if (!requested || exists(requested)) throw error;
        const path = fileURLToPath(requested);
        const extension = extname(path);
        const mapped = sourceExtensions[extension];
        if (!mapped) throw error;
        const candidate = pathToFileURL(path.slice(0, -extension.length) + mapped);
        candidate.search = requested.search;
        candidate.hash = requested.hash;
        if (!exists(candidate)) throw error;
        const resolved = nextResolve(
          context.conditions.includes("require") ? fileURLToPath(candidate) : candidate.href,
          context,
        );
        remember(resolved.url);
        return resolved;
      }
    },
    load(url, context, nextLoad) {
      if (!modules.has(url)) return nextLoad(url, context);
      const file = localFile(url);
      if (!file) return nextLoad(url, context);
      const path = fileURLToPath(file);
      if (!/\.(?:ts|mts|cts)$/.test(path) || /\.d\.(?:ts|mts|cts)$/.test(path))
        return nextLoad(url, context);
      let commonjs = path.endsWith(".cts");
      if (path.endsWith(".ts")) {
        let directory = dirname(path);
        while (true) {
          try {
            commonjs =
              JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).type !== "module";
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (dirname(directory) === directory) {
            commonjs = true;
            break;
          }
          directory = dirname(directory);
        }
      }
      const result = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,

          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
          sourceMap: false,
        },
      });
      const errors = (result.diagnostics ?? []).filter(
        (item) => item.category == ts.DiagnosticCategory.Error,
      );
      if (errors.length)
        throw new Error(
          ts.formatDiagnosticsWithColorAndContext(errors, {
            getCurrentDirectory: () => process.cwd(),
            getCanonicalFileName: (file) => file,
            getNewLine: () => "\n",
          }),
        );
      // Imported CommonJS source otherwise receives the ESM translator's synthetic
      // require, which bypasses customization hooks. Use Node's hook-aware require.
      return {
        format: commonjs ? "commonjs" : "module",
        source:
          (commonjs
            ? '"use strict";\nrequire = require("node:module").createRequire(__filename);\n'
            : "") + result.outputText,
        shortCircuit: true,
      };
    },
  });
}

/** Call only when no config/entity/migration callbacks need further dynamic imports. Node's module cache is retained. */
export function disposeTypeScriptLoader(): void {
  hooks?.deregister();
  hooks = undefined;
  // Retain graph identity alongside Node's module cache so cached callbacks can
  // resolve further imports after a later initialization.
}
