import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../init/project-detector.js";
/** Read registry locations only; never forward or print credentials from npmrc. */
export async function configuredRegistry(
  project: ProjectContext,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.npm_config_registry) return process.env.npm_config_registry;
  let registry: string | undefined;
  for (const root of [project.workspace, project.root].filter((p): p is string => !!p)) {
    let text: string;
    try {
      text = await readFile(join(root, ".npmrc"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const entries = new Map(
      text
        .split(/\r?\n/)
        .filter((line) => !/^\s*[#;]/.test(line))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
    registry = entries.get("@duraxis:registry") ?? entries.get("registry") ?? registry;
  }
  if (registry?.includes("${"))
    throw new Error(
      "Registry URL contains unresolved environment references; pass --registry without embedded credentials",
    );
  return registry;
}
