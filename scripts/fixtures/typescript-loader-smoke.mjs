import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/** Shared by workspace subprocess tests and the isolated packed consumer. */
export async function verifyTypeScriptLoader(cliURL, parent) {
  const api = await import(cliURL);
  const require = createRequire(cliURL);
  await import(pathToFileURL(require.resolve("reflect-metadata")).href);
  const root = await mkdtemp(join(parent, "duraxis loader São Paulo "));
  const base = `entities: [], migrations: { directory: "./migrations", snapshots: "./snapshots" }, driver() { throw new Error("must not open"); }`;
  const file = async (name, source) => {
    const path = join(root, name);
    await writeFile(path, source);
    return path;
  };
  const config = (path, loader = api) => loader.loadConfig(root, path);
  try {
    await file("package.json", '{"type":"module"}');
    await mkdir(join(root, "nested"));
    await file("late.ts", 'export const late: string = "cached dynamic import";');
    await file("nested/value.ts", 'export const value: string = "nested";');
    await file(
      "entities.ts",
      `import { Entity, PrimaryKey, Column } from "@duraxis/orm";
import { value } from "./nested/value.js";
@Entity("users") export class User { @PrimaryKey() id!: string; @Column({ type: "string" }) name!: string; static value = value; static async loadLater() { return (await import("./late.js")).late; } }`,
    );
    await file(
      "duraxis.config.ts",
      `import { User } from "./entities.js"; export default { defaultConnection: "named", connections: { named: { ${base}, entities: [User] } } };`,
    );
    const loaded = await api.loadConfig(join(root, "nested"), undefined, "named");
    const user = (await loaded.config.entities())[0];
    assert.equal(user.value, "nested");
    assert.equal(Reflect.getMetadata("design:type", user.prototype, "name"), String);
    assert.equal((await (await api.loadConfig(root)).config.entities())[0], user);
    // Direct .ts and file-URL imports; the loader handles query strings as well.
    await file("direct.ts", "export const direct: boolean = true;");
    const directURL = pathToFileURL(join(root, "direct.ts"));
    await file(
      "direct-config.mjs",
      `import { direct } from ${JSON.stringify(directURL.href + "?mode=test")}; export default { ${base}, entities: direct ? [] : null };`,
    );
    await config("direct-config.mjs");
    await file(
      "dynamic.config.ts",
      `export default { ${base}, entities: async () => [(await import("./entities.js")).User] };`,
    );
    const dynamic = await config("dynamic.config.ts");
    assert.equal((await dynamic.config.entities())[0], user);
    await file("winner.ts", 'throw new Error("TypeScript must not override JavaScript");');
    await file("winner.js", "export const winner = true;");
    await file(
      "javascript.config.js",
      `import { winner } from "./winner.js"; export default { ${base}, entities: winner ? [] : null };`,
    );
    await config("javascript.config.js");
    await file("modern.mts", "export const modern: boolean = true;");
    await file(
      "config.mts",
      `import { modern } from "./modern.mjs"; export default { ${base}, entities: modern ? [] : null };`,
    );
    await config("config.mts");
    await file("common.cts", 'const common: string = "commonjs"; export = common;');
    await file(
      "config.cts",
      `import common = require("./common.cjs"); export = { ${base}, entities: common === "commonjs" ? [] : null };`,
    );
    await config("config.cts");
    await file(
      "common-entity.cts",
      'import { Entity, PrimaryKey } from "@duraxis/orm"; @Entity("common_users") export class CommonUser { @PrimaryKey() id!: string; }',
    );
    await file(
      "dynamic.config.cts",
      `export = { ${base}, entities: async () => [(await import("./common-entity.cjs")).CommonUser] };`,
    );
    const commonDynamic = await config("dynamic.config.cts");
    assert.equal((await commonDynamic.config.entities())[0].name, "CommonUser");
    await file(
      "config.cjs",
      `const common = require("./common.cjs"); module.exports = { ${base}, entities: common === "commonjs" ? [] : null };`,
    );
    await config("config.cjs");
    // CommonJS consumers receive the same programmatic loader support.
    const cjs = require("./index.cjs");
    assert.equal(cjs.loadConfig, api.loadConfig);
    assert.equal(cjs.disposeTypeScriptLoader, api.disposeTypeScriptLoader);
    await file(
      "cjs-api.config.ts",
      `import { User } from "./entities.js"; export default { ${base}, entities: [User] };`,
    );
    assert.equal((await (await config("cjs-api.config.ts", cjs)).config.entities())[0], user);
    cjs.disposeTypeScriptLoader();
    await file("missing.config.ts", `import "./missing.js"; export default { ${base} };`);
    await assert.rejects(
      config("missing.config.ts"),
      (error) => error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("missing.js"),
    );
    await file("broken.js", 'import "duraxis-nonexistent-dependency";');
    await file("broken.ts", "export const unused = true;");
    await file("dependency.config.ts", `import "./broken.js"; export default { ${base} };`);
    await assert.rejects(
      config("dependency.config.ts"),
      (error) =>
        error.code === "ERR_MODULE_NOT_FOUND" &&
        error.message.includes("duraxis-nonexistent-dependency"),
    );
    await file("throw.js", 'throw new Error("existing JavaScript execution error");');
    await file("throw.ts", "export const unused = true;");
    await file("execution.config.ts", `import "./throw.js"; export default { ${base} };`);
    await assert.rejects(config("execution.config.ts"), /existing JavaScript execution error/);
    // Unrelated module graphs still use native Node resolution.
    const unrelated = await file("unrelated.ts", 'import "./not-native.js";');
    await file("not-native.ts", "export const native = false;");
    await assert.rejects(import(pathToFileURL(unrelated).href), /not-native.js/);
    api.disposeTypeScriptLoader();
    await file(
      "reinitialized.config.ts",
      `import { modern } from "./modern.mjs"; export default { ${base} };`,
    );
    await config("reinitialized.config.ts");
    assert.equal((await (await api.loadConfig(root)).config.entities())[0], user);
    assert.equal(await user.loadLater(), "cached dynamic import");
  } finally {
    api.disposeTypeScriptLoader();
    await rm(root, { recursive: true, force: true });
  }
}
