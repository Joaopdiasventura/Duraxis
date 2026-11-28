import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readObject } from "../init/project-detector.js";
export async function installedPackage(
  root: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  let directory: string;
  try {
    directory = dirname(createRequire(join(root, "package.json")).resolve(name));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = await readObject(join(directory, "package.json"));
      if (manifest.name === name) return manifest;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return undefined;
}
