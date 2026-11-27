import ts from "typescript";
import { readFile } from "node:fs/promises";
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error.code == "ERR_MODULE_NOT_FOUND" &&
      /^(\.|\/)/.test(specifier) &&
      specifier.endsWith(".js")
    )
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    throw error;
  }
}
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts") || url.endsWith(".d.ts")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
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
  return { format: "module", source: result.outputText, shortCircuit: true };
}
