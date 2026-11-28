import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPackage } from "../dependencies/installed-package.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "duraxis-installed-"));
  roots.push(root);
  return root;
}
async function packageManifest(directory: string, version: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@duraxis/core",
      version,
      exports: "./index.js",
    }),
  );
  await writeFile(
    join(directory, "index.js"),
    'throw new Error("Package inspection must not execute code");',
  );
}

describe("installed package metadata", () => {
  it("does not mistake the CLI workspace dependency for an installation in the selected project", async () => {
    const root = await temporary();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@duraxis/core": "0.3.0" } }),
    );
    expect(await installedPackage(root, "@duraxis/core")).toBeUndefined();
  });

  it.skipIf(!!process.versions.pnp)(
    "ignores an inactive PnP manifest when no package is installed",
    async () => {
      const root = await temporary();
      await writeFile(
        join(root, ".pnp.cjs"),
        'throw new Error("Metadata inspection must not load this file");',
      );
      expect(await installedPackage(root, "@duraxis/core")).toBeUndefined();
    },
  );

  it("reads the project's installed version without executing its entry point", async () => {
    const root = await temporary();
    await packageManifest(join(root, "node_modules/@duraxis/core"), "0.3.0");
    expect(await installedPackage(root, "@duraxis/core")).toMatchObject({ version: "0.3.0" });
  });

  it("finds hoisted installations and prefers the application's own package", async () => {
    const root = await temporary();
    const application = join(root, "apps/api");
    await mkdir(application, { recursive: true });
    await packageManifest(join(root, "node_modules/@duraxis/core"), "0.4.0");
    expect(await installedPackage(application, "@duraxis/core")).toMatchObject({
      version: "0.4.0",
    });
    await packageManifest(join(application, "node_modules/@duraxis/core"), "0.3.0");
    expect(await installedPackage(application, "@duraxis/core")).toMatchObject({
      version: "0.3.0",
    });
  });

  it("reads linked workspace package metadata", async () => {
    const root = await temporary();
    const linked = join(root, "packages/core");
    await packageManifest(linked, "0.6.0");
    await mkdir(join(root, "node_modules/@duraxis"), { recursive: true });
    await symlink(
      linked,
      join(root, "node_modules/@duraxis/core"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await installedPackage(root, "@duraxis/core")).toMatchObject({ version: "0.6.0" });
  });
});
