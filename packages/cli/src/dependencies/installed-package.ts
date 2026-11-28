import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { exists, readObject } from "../init/project-detector.js";

export async function installedPackage(
  root: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return undefined;

  let directory = resolve(root);
  let plugAndPlay = false;
  while (true) {
    const path = join(directory, "node_modules", name, "package.json");
    if (await exists(path)) {
      const manifest = await readObject(path);
      return manifest.name === name ? manifest : undefined;
    }
    plugAndPlay ||= await exists(join(directory, ".pnp.cjs"));
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }

  // PnP installations have no node_modules tree; their active resolver owns lookup.
  // Otherwise, do not inherit packages available only to the CLI or a test loader.
  if (!plugAndPlay || !process.versions.pnp) return undefined;
  try {
    directory = dirname(createRequire(join(resolve(root), "package.json")).resolve(name));
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
