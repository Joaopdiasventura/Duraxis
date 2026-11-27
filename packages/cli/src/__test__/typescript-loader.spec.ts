import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSupportedRuntime } from "../runtime.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
describe("Node.js runtime and programmatic TypeScript loading", () => {
  it.each(["24.15.0", "24.15.1", "24.16.0", "25.0.0", "26.0.0"])(
    "accepts supported Node.js %s",
    (version) => {
      expect(() => assertSupportedRuntime(version)).not.toThrow();
    },
  );
  it.each(["20.20.0", "22.12.0", "23.11.0", "24.0.0", "24.14.9", "invalid"])(
    "rejects unsupported Node.js %s with upgrade instructions",
    (version) => {
      expect(() => assertSupportedRuntime(version)).toThrow(
        `Duraxis requires Node.js 24.15.0 or newer.\nCurrent version: ${version}\nPlease upgrade your Node.js installation.`,
      );
    },
  );
  it("checks the executable runtime before importing modern CLI APIs", async () => {
    const script = `Object.defineProperty(process.versions, "node", { value: "22.12.0" }); await import(${JSON.stringify(pathToFileURL(resolve(root, "dist/bin.js")).href)});`;
    try {
      await exec(process.execPath, ["--input-type=module", "--eval", script]);
      throw new Error("Expected runtime rejection");
    } catch (error) {
      expect((error as { stderr: string }).stderr).toBe(
        "Duraxis requires Node.js 24.15.0 or newer.\nCurrent version: 22.12.0\nPlease upgrade your Node.js installation.\n",
      );
    }
  });
  it("loads local ESM and CommonJS graphs, decorators, metadata, dynamic imports, errors, and Unicode paths through both library exports", async () => {
    const fixture = pathToFileURL(
      resolve(root, "../../scripts/fixtures/typescript-loader-smoke.mjs"),
    ).href;
    const entry = pathToFileURL(resolve(root, "dist/index.js")).href;
    const script = `import { verifyTypeScriptLoader } from ${JSON.stringify(fixture)}; await verifyTypeScriptLoader(${JSON.stringify(entry)}, ${JSON.stringify(root)});`;
    await expect(
      exec(process.execPath, ["--input-type=module", "--eval", script]),
    ).resolves.toMatchObject({ stderr: "" });
  });
});
