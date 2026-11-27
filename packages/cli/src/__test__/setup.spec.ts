import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { runCLI } from "../cli.js";
import { loadConfig, importFile } from "../config.js";
import { detectProject, selectManager } from "../init/project-detector.js";
import { commands, helpText } from "../registry/command-registry.js";
import { parseCommand } from "../registry/argument-parser.js";
import { satisfies } from "../dependencies/version-compatibility.js";
import { RegistryClient } from "../dependencies/registry-client.js";
import { resolveDependencies } from "../dependencies/dependency-resolver.js";
import { addFile, executeFiles, type FilePlan } from "../filesystem/file-plan.js";
const roots: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (
      /^DURAXIS_(?:[A-Z0-9_]+_)?(?:STORAGE_DIRECTORY|NAMESPACE|S3_BUCKET|S3_PREFIX|S3_ENDPOINT)$/.test(
        key,
      )
    )
      vi.stubEnv(key, undefined);
  vi.stubEnv("npm_config_registry", undefined);
});

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "duraxis setup ü-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function invoke(root: string, args: string[], extra: Parameters<typeof runCLI>[1] = {}) {
  const output: string[] = [],
    errors: string[] = [];
  const code = await runCLI(args, {
    cwd: root,
    out: (line) => output.push(line),
    error: (line) => errors.push(line),
    ...extra,
  });
  return { code, output: output.join("\n"), errors: errors.join("\n") };
}
async function linkPackages(root: string) {
  await mkdir(join(root, "node_modules/@duraxis"), { recursive: true });
  for (const name of [
    "core",
    "orm",
    "nestjs",
    "migrations",
    "cli",
    "storage",
    "storage-memory",
    "storage-disk",
    "storage-s3",
  ])
    await symlink(
      resolve(import.meta.dirname, "../../../", name),
      join(root, "node_modules/@duraxis", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, "../../../../node_modules/@types/node"),
    join(root, "node_modules/@types/node"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const require = createRequire(resolve(import.meta.dirname, "../../package.json"));
  const reflect = require.resolve("reflect-metadata");
  await symlink(
    resolve(reflect, ".."),
    join(root, "node_modules/reflect-metadata"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const nestRequire = createRequire(resolve(import.meta.dirname, "../../../nestjs/package.json"));
  await mkdir(join(root, "node_modules/@nestjs"), { recursive: true });
  for (const name of ["common", "core"])
    await symlink(
      resolve(nestRequire.resolve(`@nestjs/${name}/package.json`), ".."),
      join(root, "node_modules/@nestjs", name),
      process.platform === "win32" ? "junction" : "dir",
    );
}
describe("registry and version ranges", () => {
  it("documents every registered command and option without project access", () => {
    const root = helpText();
    for (const command of commands) {
      expect(root).toContain(command.name);
      for (const option of command.options) expect(helpText(command)).toContain(`--${option}`);
    }
    expect(() => parseCommand(["nonsense"])).toThrow("Unknown");
    expect(() => parseCommand(["init", "--orm", "--no-orm"])).toThrow("exclusive");
    expect(() => parseCommand(["doctor", "--driver", "disk"])).toThrow("not supported");
  });
  it.each([
    ["24.15.0", ">=24.15.0", true],
    ["22.12.0", ">=24.15.0", false],
    ["0.3.5", "^0.3.0", true],
    ["0.4.0", "^0.3.0", false],
    ["11.2.0", ">=10 <13", true],
    ["24.15.0", "<=24", true],
    ["0.4.0", "^0", true],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["2.1.0", "1.x || 2.x", true],
  ] as const)("checks %s against %s", (actual, range, expected) =>
    expect(satisfies(actual, range)).toBe(expected),
  );
  it("rejects unsupported ranges rather than guessing", () =>
    expect(() => satisfies("1.0.0", "workspace:*")).toThrow("Unsupported"));
  it("resolves latest compatible stable versions and checks peer constraints", async () => {
    const request: typeof fetch = async () =>
      Response.json({
        versions: {
          "1.0.0": { engines: { node: ">=24" } },
          "1.2.0": { engines: { node: ">=24" } },
          "2.0.0": { engines: { node: ">=26" } },
          "3.0.0-beta.1": {},
        },
      });
    expect(
      await resolveDependencies(
        ["@duraxis/core"],
        {},
        new RegistryClient(undefined, request),
        false,
        "24.15.0",
      ),
    ).toEqual({ "@duraxis/core": "1.2.0" });
    await expect(
      resolveDependencies(
        ["@duraxis/core"],
        {},
        new RegistryClient(undefined, async () => new Response("", { status: 503 })),
      ),
    ).rejects.toThrow("HTTP 503");
    const bad: typeof fetch = async () =>
      Response.json({ versions: { "1.0.0": { engines: { node: ">=26" } } } });
    await expect(
      resolveDependencies(
        ["@duraxis/core"],
        {},
        new RegistryClient(undefined, bad),
        false,
        "24.15.0",
      ),
    ).rejects.toThrow("No compatible");
  });
});
describe("project detection and safe plans", () => {
  it.each([
    ["npm", "package-lock.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
  ])("detects %s without executing scripts", async (manager, lock) => {
    const root = await temporary();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: `${manager}@1.0.0`, type: "module" }),
    );
    await writeFile(join(root, lock), "");
    expect(selectManager(await detectProject(root))).toBe(manager);
  });
  it("selects the nearest workspace package and rejects ambiguous lockfiles", async () => {
    const root = await temporary();
    await writeFile(
      join(root, "package.json"),
      '{"workspaces":["apps/*"],"packageManager":"pnpm@12.16.1"}',
    );
    await mkdir(join(root, "apps/api/src"), { recursive: true });
    await writeFile(
      join(root, "apps/api/package.json"),
      '{"dependencies":{"@nestjs/core":"^11.0.0"}}',
    );
    await writeFile(
      join(root, "apps/api/src/app.module.ts"),
      'throw new Error("must never execute during discovery");',
    );
    await writeFile(
      join(root, "apps/api/src/main.ts"),
      'throw new Error("must never execute during discovery");',
    );
    const project = await detectProject(join(root, "apps/api/src"));
    expect(project.root).toBe(join(root, "apps/api"));
    expect(project.workspace).toBe(root);
    expect(project.nestjs).toBe(true);
    expect(selectManager(project)).toBe("pnpm");
    expect(project.nestModules).toContain("src/app.module.ts");
    expect(project.entryPoints).toContain("src/main.ts");
    await writeFile(join(root, "apps/api/yarn.lock"), "");
    const conflicting = await detectProject(join(root, "apps/api/src"));
    expect(() => selectManager(conflicting)).toThrow("Conflicting");
    await mkdir(join(root, "apps/uninitialized/src"), { recursive: true });
    const unsafeRoot = await invoke(join(root, "apps/uninitialized/src"), [
      "init",
      "--driver",
      "memory",
      "--no-install",
      "--yes",
    ]);
    expect(unsafeRoot.code).toBe(1);
    expect(unsafeRoot.errors).toContain("target the workspace root");
    expect(await readdir(root)).not.toContain("duraxis.project.json");
  });
  it("rolls back controlled files and rejects symlink escapes and stale plans", async () => {
    const root = await temporary();
    const files: FilePlan = {
      root,
      files: [],
      directories: [],
      warnings: [],
      dependencies: {},
      devDependencies: {},
      commands: [],
    };
    await addFile(files, "safe.txt", "before");
    await expect(
      executeFiles(files, async () => {
        throw new Error("installation failed");
      }),
    ).rejects.toThrow("installation failed");
    expect(await readdir(root)).toEqual([]);
    const outside = await temporary();
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(addFile(files, "escape/file", "x")).rejects.toThrow("Symlinks");
    await expect(addFile(files, "../escape", "x")).rejects.toThrow("Unsafe");
    await writeFile(join(root, "existing"), "a");
    const next = { ...files, files: [] };
    await addFile(next, "existing", "b", true);
    await writeFile(join(root, "existing"), "changed");
    await expect(executeFiles(next, async () => {})).rejects.toThrow("changed since planning");
    expect(await readFile(join(root, "existing"), "utf8")).toBe("changed");
  });
  it("supports cancellation and validates incompatible combinations before writing", async () => {
    const root = await temporary();
    expect((await invoke(root, ["init", "--driver", "auto", "--no-install", "--yes"])).code).toBe(
      1,
    );
    expect(
      (
        await invoke(root, [
          "init",
          "--driver",
          "memory",
          "--schema-mode",
          "auto",
          "--no-install",
          "--yes",
        ])
      ).code,
    ).toBe(1);
    expect(await readdir(root)).toEqual([]);

    expect(
      (await invoke(root, ["init", "--framework", "nestjs", "--no-orm", "--no-install", "--yes"]))
        .code,
    ).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(
      (
        await invoke(root, ["init"], {
          interactive: true,
          prompt: async () => {
            throw new Error("cancelled");
          },
        })
      ).code,
    ).toBe(1);
    expect(await readdir(root)).toEqual([]);

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "^12.0.0" } }),
    );
    const questions: string[] = [];
    const automatic = await invoke(
      root,
      ["init", "--framework", "auto", "--driver", "memory", "--no-migrations", "--no-install"],
      {
        interactive: true,
        prompt: async (question, fallback) => {
          questions.push(question);
          return fallback;
        },
      },
    );
    expect(automatic.code, automatic.errors).toBe(0);
    expect(questions).not.toContain("Enable ORM?");
  });
  it("dry-run is write-free and missing packages are diagnosed without opening a database", async () => {
    const root = await temporary();
    expect(
      (await invoke(root, ["init", "--driver", "memory", "--no-install", "--dry-run", "--json"]))
        .code,
    ).toBe(0);
    expect(await readdir(root)).toEqual([]);
    await invoke(root, ["init", "--driver", "memory", "--no-install", "--yes"]);
    const before = await readdir(root);
    const diagnosed = await invoke(root, ["doctor", "--json"]);
    expect(diagnosed, diagnosed.output).toHaveProperty("code", 1);
    expect(diagnosed.output).toContain("FAIL");
    expect(await readdir(root)).toEqual(before);
  });
});
describe("generated applications", () => {
  it.each(["typescript", "javascript"] as const)(
    "generates all official standalone and NestJS combinations in %s",
    async (language) => {
      for (const moduleFormat of ["esm", "cjs"] as const)
        for (const framework of ["standalone", "nestjs"] as const)
          for (const driver of ["memory", "disk", "s3"] as const) {
            const root = await temporary();
            await linkPackages(root);
            const result = await invoke(root, [
              "init",
              "--framework",
              framework,
              "--driver",
              driver,
              "--orm",
              "--no-migrations",
              "--language",
              language,
              "--module-format",
              moduleFormat,
              "--bucket",
              "test-bucket",
              "--example",
              "--no-install",
              "--yes",
            ]);
            expect(result.errors).toBe("");
            expect(result.code).toBe(0);
            const source =
              language === "typescript"
                ? moduleFormat === "esm"
                  ? "mts"
                  : "cts"
                : moduleFormat === "esm"
                  ? "mjs"
                  : "cjs";
            if (language === "typescript") {
              const configuration = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
              const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root);
              const program = ts.createProgram(parsed.fileNames, parsed.options);
              const errors = ts.getPreEmitDiagnostics(program);
              expect(
                errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
              ).toEqual([]);
              program.emit();
            }
            const applicationDir = language === "typescript" ? "dist" : "src";
            const emittedExtension = moduleFormat === "esm" ? "mjs" : "cjs";
            const script = `import assert from "node:assert/strict";
import { loadConfig } from "@duraxis/cli";
import { pathToFileURL } from "node:url";
const loaded = await loadConfig(process.cwd());
assert.equal(loaded.config.migrations, undefined);
const initialDatabase = await loaded.config.createDatabase(); await initialDatabase.close({closeStorage:true});
const factory = await import(pathToFileURL(${JSON.stringify(join(root, `${applicationDir}/duraxis/database.${emittedExtension}`))}).href);
${driver !== "s3" ? `const orm = await factory.createORM(); const {entities} = await import(pathToFileURL(${JSON.stringify(join(root, `${applicationDir}/duraxis/entities.${emittedExtension}`))}).href); await orm.getRepository(entities[0]).insert({id:"one", name:"example"}); assert.equal((await orm.getRepository(entities[0]).find()).length,1); await orm.close();` : ""}
${framework === "nestjs" ? `const integration = await import(pathToFileURL(${JSON.stringify(join(root, `${applicationDir}/duraxis/duraxis.module.${emittedExtension}`))}).href); assert.ok(integration.ApplicationDuraxisModule);` : ""}
`;
            await writeFile(join(root, "generated-smoke.mjs"), script);
            await promisify(execFile)(process.execPath, ["generated-smoke.mjs"], { cwd: root });
            expect((await invoke(root, ["init", "--yes"])).output).toContain("already-initialized");
          }
    },
    120000,
  );
  it("supports Core-only settings and named connections, static inspection and safe generators", async () => {
    const root = await temporary();
    await linkPackages(root);
    expect(
      (
        await invoke(root, [
          "init",
          "--driver",
          "memory",
          "--no-orm",
          "--no-migrations",
          "--no-install",
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect((await invoke(root, ["config:validate", "--json"])).code).toBe(0);
    expect((await invoke(root, ["generate:entity", "User"])).code).toBe(1);
    expect(
      (
        await invoke(root, [
          "connection:add",
          "reporting",
          "--driver",
          "disk",
          "--orm",
          "--no-migrations",
          "--no-install",
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect((await invoke(root, ["generate:entity", "User", "--database", "reporting"])).code).toBe(
      0,
    );
    expect(
      (await invoke(root, ["config:set", "namespace", "reports", "--database", "reporting"])).code,
    ).toBe(0);
    const connection = await loadConfig(root, undefined, "reporting");
    const db = await connection.config.createDatabase();
    expect(db.namespace).toBe("reports");
    await db.close({ closeStorage: true });
    expect((await invoke(root, ["migrate:status"])).errors).toContain("disabled");
    expect((await invoke(root, ["connection:list", "--json"])).output).toContain("reporting");
  });
});

describe("installation and dependency failure boundaries", () => {
  const metadata: typeof fetch = async () =>
    Response.json({ versions: { "1.0.0": { engines: { node: ">=24" } } } });
  it("installs in the selected workspace package and separates development dependencies", async () => {
    const root = await temporary();
    await mkdir(join(root, "apps/api"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"workspaces":["apps/*"]}');
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    await writeFile(join(root, "apps/api/package.json"), '{"name":"api","type":"module"}');
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
    const result = await invoke(
      join(root, "apps/api"),
      ["init", "--driver", "memory", "--no-migrations", "--yes", "--package-manager", "pnpm"],
      {
        fetch: metadata,
        runProcess: async (request) => {
          calls.push(request);
        },
      },
    );
    expect(result.code, result.errors).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.cwd === join(root, "apps/api"))).toBe(true);
    expect(calls[0]!.args).toContain("@duraxis/core@1.0.0");
    expect(calls[1]!.args).toContain("-D");
    expect(calls[1]!.args).toContain("@duraxis/cli@1.0.0");
  });
  it("reports installation failure and rolls back controlled files", async () => {
    const root = await temporary();
    await writeFile(join(root, "package.json"), '{"name":"before"}');
    const result = await invoke(root, ["init", "--driver", "memory", "--yes"], {
      fetch: metadata,
      runProcess: async () => {
        throw new Error("installer failed; lockfile may require recovery");
      },
    });
    expect(result.code).toBe(1);
    expect(result.errors).toContain("installer failed");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"before"}');
    expect(await readdir(root)).toEqual(["package.json"]);
  });
  it("rejects conflicting peer requirements and an already cancelled registry request", async () => {
    const request: typeof fetch = async (url) =>
      Response.json({
        versions: String(url).includes("%40duraxis")
          ? { "1.0.0": { peerDependencies: { "@nestjs/core": "^11.0.0" } } }
          : { "12.0.0": {} },
      });
    await expect(
      resolveDependencies(
        ["@duraxis/nestjs"],
        { "@nestjs/core": "^12.0.0" },
        new RegistryClient(undefined, request),
      ),
    ).rejects.toThrow("not provably compatible");
    const controller = new AbortController();
    controller.abort();
    const aborted: typeof fetch = async (_, init) => {
      init?.signal?.throwIfAborted();
      return Response.json({ versions: {} });
    };
    await expect(
      new RegistryClient(undefined, aborted, controller.signal).get("@duraxis/core"),
    ).rejects.toThrow("timed out or cancelled");
  });
  it("uses an initialization guard and preserves user configuration edits", async () => {
    const root = await temporary();
    await writeFile(join(root, ".duraxis-init.lock"), "busy");
    const result = await invoke(root, ["init", "--driver", "memory", "--no-install", "--yes"]);
    expect(result.code).toBe(1);
    expect(await readdir(root)).toEqual([".duraxis-init.lock"]);
    await rm(join(root, ".duraxis-init.lock"));
    await invoke(root, ["init", "--driver", "memory", "--no-install", "--yes"]);
    const config = (await readdir(root)).find((file) => file.startsWith("duraxis.config."))!;
    const before = await readFile(join(root, config), "utf8");
    await writeFile(join(root, config), before + "\n// user edit\n");
    const add = await invoke(root, [
      "connection:add",
      "other",
      "--driver",
      "memory",
      "--no-migrations",
      "--no-install",
      "--yes",
    ]);
    expect(add.code).toBe(1);
    expect(add.errors).toContain("edited");
    expect(await readFile(join(root, config), "utf8")).toBe(before + "\n// user edit\n");
  });
});

describe("Core and custom integrations", () => {
  it.each(["esm", "cjs"] as const)(
    "runs Core-only official factories in %s",
    async (moduleFormat) => {
      for (const driver of ["memory", "disk", "s3"]) {
        const root = await temporary();
        await linkPackages(root);
        const result = await invoke(root, [
          "init",
          "--driver",
          driver,
          "--bucket",
          "test-bucket",
          "--region",
          "us-east-1",
          "--no-orm",
          "--no-migrations",
          "--language",
          "javascript",
          "--module-format",
          moduleFormat,
          "--no-install",
          "--yes",
        ]);
        expect(result.code, result.errors).toBe(0);
        const config = await loadConfig(root);
        expect(config.config.entities).toBeUndefined();
        expect(config.config.migrations).toBeUndefined();
        if (driver !== "s3") {
          const database = await config.config.createDatabase();
          try {
            await database.transaction((tx) => tx.put("key", new Uint8Array([1])));
            expect(await database.snapshot((tx) => tx.get("key"))).toEqual(new Uint8Array([1]));
          } finally {
            await database.close({ closeStorage: true });
          }
        }
      }
    },
  );
  it("uses a real custom factory without generating a fake driver", async () => {
    const root = await temporary();
    await linkPackages(root);
    await writeFile(
      join(root, "custom.mjs"),
      'import { MemoryStorageDriver } from "@duraxis/storage-memory"; export function makeStorage(){ return new MemoryStorageDriver(); }',
    );
    const result = await invoke(root, [
      "init",
      "--driver",
      "custom",
      "--custom-module",
      "./custom.mjs",
      "--custom-export",
      "makeStorage",
      "--language",
      "javascript",
      "--module-format",
      "esm",
      "--no-migrations",
      "--no-install",
      "--yes",
    ]);
    expect(result.code, result.errors).toBe(0);
    const { config } = await loadConfig(root);
    const database = await config.createDatabase();
    await database.transaction((tx) => tx.put("key", new Uint8Array([2])));
    expect(await database.snapshot((tx) => tx.get("key"))).toEqual(new Uint8Array([2]));
    await database.close({ closeStorage: true });
  });
});

describe("administrative trust and update boundaries", () => {
  it("checks upgrades without applying and applies only explicit Duraxis updates", async () => {
    const root = await temporary();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@duraxis/core": "0.3.0", "unrelated-library": "1.0.0" } }),
    );
    const request: typeof fetch = async () =>
      Response.json({ versions: { "0.3.0": {}, "0.4.0": { engines: { node: ">=24" } } } });
    const commands: string[][] = [];
    const injected = {
      fetch: request,
      runProcess: async (request: import("../dependencies/package-manager.js").ProcessRequest) => {
        commands.push([request.command, ...request.args]);
      },
    };
    const check = await invoke(root, ["upgrade", "--check", "--json"], injected);
    expect(check.code, check.errors).toBe(0);
    expect(check.output).toContain("0.4.0");
    expect(commands).toEqual([]);
    const apply = await invoke(root, ["upgrade", "--apply", "--json"], injected);
    expect(apply.code, apply.errors).toBe(0);
    expect(commands).toEqual([["npm", "install", "@duraxis/core@0.4.0"]]);
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("unrelated-library");
    expect((await invoke(root, ["upgrade", "--check", "--apply"], injected)).code).toBe(1);
  });
  it("keeps executable configuration inert until explicit evaluation and redacts credentials", async () => {
    const root = await temporary();
    const marker = join(root, "evaluated");
    await writeFile(
      join(root, "duraxis.config.mjs"),
      `import {writeFile} from "node:fs/promises"; await writeFile(${JSON.stringify(marker)},"evaluated"); const extension={accessKeyId:"SECRET-VALUE",password:"SECRET-VALUE",url:"https://user:SECRET-VALUE@example.test"}; extension.circular=extension; export default {extension,createDatabase(){throw new Error("Factory must not run during inspection");}};`,
    );
    const staticResult = await invoke(root, ["config:show", "--json"]);
    expect(staticResult.code, staticResult.errors).toBe(0);
    expect(staticResult.output).toContain("not evaluated");
    expect(await readdir(root)).not.toContain("evaluated");
    const evaluated = await invoke(root, ["config:show", "--evaluate", "--json"]);
    expect(evaluated.code, evaluated.errors).toBe(0);
    expect(evaluated.output).not.toContain("SECRET-VALUE");
    expect(evaluated.output).toContain("REDACTED");
    expect(await readdir(root)).toContain("evaluated");
  });
  it("offers help/version outside a project without touching registry or storage", async () => {
    const root = await temporary();
    const unavailable: typeof fetch = async () => {
      throw new Error("Network must not run");
    };
    for (const args of [
      ["--help"],
      ["help", "init"],
      ["init", "--help"],
      ["help", "migrate:up"],
      ["--version"],
    ]) {
      const result = await invoke(root, args, { fetch: unavailable });
      expect(result.code, result.errors).toBe(0);
      expect(result.output).not.toContain("\u001b[");
    }
    expect(await readdir(root)).toEqual([]);
  });
});

it("checks the selected connection's Disk environment path before a live open", async () => {
  const root = await temporary();
  await linkPackages(root);
  expect(
    (await invoke(root, ["init", "--driver", "memory", "--no-migrations", "--no-install", "--yes"]))
      .code,
  ).toBe(0);
  expect(
    (
      await invoke(root, [
        "connection:add",
        "reporting",
        "--driver",
        "disk",
        "--storage-directory",
        "./data/reporting",
        "--no-migrations",
        "--no-install",
        "--yes",
      ])
    ).code,
  ).toBe(0);
  await mkdir(join(root, "existing-default"));
  await writeFile(join(root, "existing-default/journal.log"), "");
  vi.stubEnv("DURAXIS_STORAGE_DIRECTORY", join(root, "existing-default"));
  vi.stubEnv("DURAXIS_REPORTING_STORAGE_DIRECTORY", join(root, "not-initialized"));
  const result = await invoke(root, ["storage:check", "--database", "reporting", "--live"]);
  expect(result.code, result.errors).toBe(1);
  expect(result.errors).toContain("existing initialized directory");
  expect(await readdir(root)).not.toContain("not-initialized");
});

it("does not echo secret-bearing fragments from malformed managed JSON", async () => {
  const root = await temporary();
  await writeFile(join(root, "duraxis.project.json"), '{"password":SECRET-VALUE}');
  const result = await invoke(root, ["config:show", "--json"]);
  expect(result.code).toBe(1);
  expect(result.errors).toContain("Invalid JSON syntax");
  expect(result.errors).not.toContain("SECRET-VALUE");
});

it("does not edit default managed settings when an alternate executable config is selected", async () => {
  const root = await temporary();
  await linkPackages(root);
  await invoke(root, ["init", "--driver", "memory", "--no-migrations", "--no-install", "--yes"]);
  const before = await readFile(join(root, "duraxis.project.json"), "utf8");
  await writeFile(
    join(root, "other.config.mjs"),
    'throw new Error("Must not execute during static inspection");',
  );
  const changed = await invoke(root, [
    "config:set",
    "namespace",
    "other",
    "--config",
    "other.config.mjs",
  ]);
  expect(changed.code).toBe(1);
  expect(await readFile(join(root, "duraxis.project.json"), "utf8")).toBe(before);
  const shown = await invoke(root, ["config:show", "--config", "other.config.mjs", "--json"]);
  expect(shown.code, shown.errors).toBe(0);
  expect(shown.output).toContain("unresolved");
  expect(shown.output).toContain("other.config.mjs");
});

it("does not echo existing manifest secrets in dry-run plans", async () => {
  const root = await temporary();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "existing", scripts: { start: "TOKEN=SECRET-VALUE node index.js" } }),
  );
  const result = await invoke(root, [
    "init",
    "--driver",
    "memory",
    "--no-install",
    "--dry-run",
    "--json",
  ]);
  expect(result.code, result.errors).toBe(0);
  expect(result.output).not.toContain("SECRET-VALUE");
  expect(result.output).toContain('"action":"modify"');
  expect(await readdir(root)).toEqual(["package.json"]);
});

it("never replaces workspace links or automatically downgrades installed Duraxis packages", async () => {
  const root = await temporary();
  await linkPackages(root);
  let calls = 0;
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "@duraxis/core": "workspace:*" } }),
  );
  const injected = {
    fetch: async () => Response.json({ versions: { "0.1.0": {} } }),
    runProcess: async () => {
      calls++;
    },
  };
  const workspace = await invoke(root, ["upgrade", "--apply"], injected);
  expect(workspace.code).toBe(1);
  expect(workspace.errors).toContain("workspace release tooling");
  expect(calls).toBe(0);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "@duraxis/core": "0.3.0" } }),
  );
  const downgrade = await invoke(root, ["upgrade", "--apply"], injected);
  expect(downgrade.code).toBe(1);
  expect(downgrade.errors).toContain("downgrades are unsupported");
  expect(calls).toBe(0);
  expect(await readFile(join(root, "package.json"), "utf8")).toContain("0.3.0");
});
