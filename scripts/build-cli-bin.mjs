import { copyFile, writeFile, chmod } from "node:fs/promises";
await writeFile(
  "dist/bin.js",
  '#!/usr/bin/env node\nimport { assertSupportedRuntime } from "./runtime.mjs";\ntry {\n  assertSupportedRuntime();\n  const { runCLI } = await import("./index.js");\n  process.exitCode = await runCLI(process.argv.slice(2));\n} catch (error) {\n  console.error(error instanceof Error ? error.message : String(error));\n  process.exitCode = 1;\n}\n',
);
await chmod("dist/bin.js", 0o755);
await copyFile("src/runtime.mjs", "dist/runtime.mjs");

// Node 24 require(ESM) keeps programmatic exports and loader state identical.
await writeFile(
  "dist/index.cjs",
  '"use strict";\nrequire("./runtime.mjs").assertSupportedRuntime();\nmodule.exports = require("./index.js");\n',
);
