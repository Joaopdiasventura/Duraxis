import { copyFile, writeFile, chmod } from "node:fs/promises";
await writeFile(
  "dist/bin.js",
  '#!/usr/bin/env node\nimport { runCLI } from "./index.js";\nprocess.exitCode = await runCLI(process.argv.slice(2));\n',
);
await chmod("dist/bin.js", 0o755);
await copyFile("src/ts-loader.mjs", "dist/ts-loader.mjs");
