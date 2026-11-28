import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { runCLI } from "../cli.js";
import { loadConfig } from "../config.js";
import { integrateNestModule } from "../init/nest-integration.js";
import { detectProject } from "../init/project-detector.js";
import { inspectStaticConfig } from "../init/static-config.js";
import { addFile, executeFiles, type FilePlan } from "../filesystem/file-plan.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "duraxis minimal-"));
  roots.push(root);
  return root;
}
async function invoke(root: string, args: string[]) {
  const out: string[] = [],
    errors: string[] = [];
  const code = await runCLI(args, {
    cwd: root,
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  });
  return { code, out: out.join("\n"), errors: errors.join("\n") };
}
async function link(root: string) {
  await mkdir(join(root, "node_modules/@duraxis"), { recursive: true });
  for (const name of [
    "core",
    "orm",
    "nestjs",
    "migrations",
    "storage",
    "storage-memory",
    "storage-s3",
    "storage-disk",
  ])
    await symlink(
      resolve(import.meta.dirname, "../../../", name),
      join(root, "node_modules/@duraxis", name),
    );
  const require = createRequire(resolve(import.meta.dirname, "../../../nestjs/package.json"));
  await mkdir(join(root, "node_modules/@nestjs"), { recursive: true });
  for (const name of ["common", "core"])
    await symlink(
      resolve(require.resolve(`@nestjs/${name}/package.json`), ".."),
      join(root, "node_modules/@nestjs", name),
    );
}
describe("minimal configuration and automatic integration", () => {
  it("preserves an existing ESM Nest application, Yarn, TypeORM, guards, config, migrations and feature modules", async () => {
    const root = await temporary();
    const applicationFiles: Record<string, string> = {
      "migrations/001-existing.ts": 'export const existingMigration = "must remain unchanged";\n',
      "nest-cli.json": '{ "sourceRoot": "src" }\n',
      "package.json":
        '{\n  "name": "test-application",\n  "private": true,\n  "type": "module",\n  "packageManager": "yarn@4.6.0",\n  "dependencies": {\n    "@nestjs/core": "^11.0.0",\n    "@nestjs/common": "^11.0.0",\n    "@nestjs/typeorm": "^11.0.0",\n    "typeorm": "^0.3.0"\n  }\n}\n',
      "src/app.module.ts":
        'import { Module as NestModule } from "@nestjs/common";\nimport { APP_GUARD } from "@nestjs/core";\nimport { TypeOrmModule } from "@nestjs/typeorm";\nimport { applicationConfig } from "./config/application.config.js";\nimport { AuthGuard } from "./guards/auth.guard.js";\nimport { ObservabilityModule } from "./observability/observability.module.js";\nimport { UsersModule } from "./features/users/users.module.js";\nimport { ReportsModule } from "./features/reports/reports.module.js";\n\n@NestModule({\n  imports: [\n    // Existing persistence must remain intact.\n    TypeOrmModule.forRoot(applicationConfig.database),\n    ObservabilityModule,\n    UsersModule,\n    ReportsModule,\n  ],\n  controllers: [],\n  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],\n  exports: [UsersModule],\n})\nexport class AppModule {}\n',
      "src/config/application.config.ts":
        'export const applicationConfig = {\n  database: { type: "postgres", migrations: ["./migrations/*.js"] },\n};\n',
      "src/features/reports/report.entity.ts":
        "export default interface Report {\n  id: string;\n}\n",
      "src/features/reports/reports.module.ts":
        'import { Module } from "@nestjs/common";\n@Module({})\nexport class ReportsModule {}\n',
      "src/features/users/user.entity.ts":
        "export interface User {\n  id: string;\n  email: string;\n}\nexport class UserDTO {\n  id?: string;\n}\n",
      "src/features/users/users.module.ts":
        'import { Module } from "@nestjs/common";\n@Module({})\nexport class UsersModule {}\n',
      "src/guards/auth.guard.ts":
        "export class AuthGuard {\n  canActivate() {\n    return true;\n  }\n}\n",
      "src/observability/observability.module.ts":
        'import { Module } from "@nestjs/common";\n@Module({})\nexport class ObservabilityModule {}\n',
      "src/typeorm.d.ts":
        '// Compile-only test boundary: no TypeORM execution is necessary to load Duraxis config.\ndeclare module "@nestjs/typeorm" {\n  export const TypeOrmModule: { forRoot(options: unknown): import("@nestjs/common").DynamicModule };\n}\n',
      "tsconfig.json":
        '{\n  "compilerOptions": {\n    "target": "ES2023",\n    "module": "NodeNext",\n    "moduleResolution": "NodeNext",\n    "experimentalDecorators": true,\n    "emitDecoratorMetadata": true,\n    "useDefineForClassFields": false,\n    "strict": true,\n    "outDir": "dist",\n    "rootDir": "src",\n    "skipLibCheck": true\n  },\n  "include": ["src"]\n}\n',
    };
    for (const [path, content] of Object.entries(applicationFiles)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await link(root);
    await writeFile(join(root, ".env.example"), "EXISTING=yes\nAWS_REGION=eu-west-1\n");
    const original = await readFile(join(root, "src/app.module.ts"), "utf8");
    const saved = await readFile(join(root, "src/config/application.config.ts"), "utf8");
    const args = [
      "init",
      "--driver",
      "s3",
      "--bucket",
      "test-bucket",
      "--migrations",
      "--no-install",
      "--yes",
    ];
    const dry = await invoke(root, [...args, "--dry-run", "--json"]);
    expect(dry.code, dry.errors).toBe(0);
    expect(dry.out).toContain("src/app.module.ts");
    expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toBe(original);
    const result = await invoke(root, args);
    expect(result.code, result.errors).toBe(0);
    const app = await readFile(join(root, "src/app.module.ts"), "utf8");
    expect(app).toContain("DuraxisModule.forRoot(duraxisConfig)");
    for (const text of [
      "TypeOrmModule.forRoot(applicationConfig.database)",
      "ObservabilityModule,",
      "UsersModule,",
      "ReportsModule,",
      "providers: [{ provide: APP_GUARD, useClass: AuthGuard }]",
      "exports: [UsersModule]",
      "// Existing persistence must remain intact.",
    ])
      expect(app).toContain(text);
    expect(await readFile(join(root, "src/config/application.config.ts"), "utf8")).toBe(saved);
    expect(await readFile(join(root, "migrations/001-existing.ts"), "utf8")).toContain(
      "must remain unchanged",
    );
    expect(await readdir(join(root, "src"))).not.toContain("duraxis");
    expect((await detectProject(root)).manager).toBe("yarn");
    const env = await readFile(join(root, ".env.example"), "utf8");
    expect(env).toContain("EXISTING=yes");
    expect(env.match(/AWS_REGION=/g)).toHaveLength(1);
    const config = await loadConfig(root);
    expect(config.config.migrations?.directory).toBe(join(root, "duraxis/migrations"));
    const entities = config.config.entities as () => Promise<readonly unknown[]>;
    await expect(entities()).rejects.toThrow("No Duraxis entities");
    expect((await invoke(root, ["migration:generate", "empty"])).code).toBe(1);
    expect((await invoke(root, ["generate:entity", "Account"])).code).toBe(0);
    expect((await entities()).map((entity: any) => entity.name)).toEqual(["Account"]);
    expect((await invoke(root, ["migration:generate", "accounts"])).code).toBe(0);
    expect((await invoke(root, ["migrate:check", "--offline"])).code).toBe(0);
    const repeated = await invoke(root, args);
    expect(repeated.out).toContain("already-initialized");
    expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toBe(app);
    const raw = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")),
    ).toEqual([]);
    program.emit();
    // No CLI, TypeScript or dotenv package exists in this application's production node_modules.
    expect(await readdir(join(root, "node_modules/@duraxis"))).not.toContain("cli");
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import config from "./dist/duraxis.config.js"; import { createDatabase } from "@duraxis/core"; const db = await createDatabase(config); await db.close();',
      ],
      { cwd: root },
    );
  }, 30000);
  it("uses AST aliases and preserves comments; rejects dynamic imports and existing root registrations", () => {
    const original = `import { Module as M } from '@nestjs/common';\nimport { DuraxisModule as D } from '@duraxis/nestjs';\n@M({ providers: [/* guard */ Guard] }) export class AppModule {}`;
    const updated = integrateNestModule(original, "src/app.module.ts", "src/duraxis.config.ts");
    expect(updated).toContain("D.forRoot(duraxisConfig)");
    expect(updated).toContain("providers: [/* guard */ Guard]");
    expect(updated.match(/@duraxis\/nestjs/g)).toHaveLength(1);
    expect(() =>
      integrateNestModule(updated, "src/app.module.ts", "src/duraxis.config.ts"),
    ).toThrow("Existing Duraxis");
    expect(() =>
      integrateNestModule(
        original.replace("providers: [/* guard */ Guard]", "imports: dynamicModules"),
        "src/app.module.ts",
        "src/duraxis.config.ts",
      ),
    ).toThrow("inline array");
  });
  it("detects monorepo apps and requires selection when multiple AppModules exist", async () => {
    const root = await temporary();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { "@nestjs/core": "^11" } }),
    );
    await writeFile(
      join(root, "nest-cli.json"),
      JSON.stringify({
        monorepo: true,
        projects: {
          api: { type: "application", sourceRoot: "apps/api/src" },
          worker: { type: "application", sourceRoot: "apps/worker/src" },
        },
      }),
    );
    for (const name of ["api", "worker"]) {
      await mkdir(join(root, `apps/${name}/src`), { recursive: true });
      await writeFile(
        join(root, `apps/${name}/src/app.module.ts`),
        'import { Module } from "@nestjs/common"; @Module({}) export class AppModule {}',
      );
    }
    const project = await detectProject(root);
    expect(project.nestModules).toHaveLength(2);
    const args = ["init", "--driver", "memory", "--no-migrations", "--no-install", "--yes"];
    expect((await invoke(root, args)).code).toBe(1);
    expect((await invoke(root, [...args, "--source-dir", "apps/api/src"])).code).toBe(0);
    expect(await readFile(join(root, "apps/worker/src/app.module.ts"), "utf8")).not.toContain(
      "Duraxis",
    );
  });
  it("rolls back modified files and refuses dynamic static mutations without executing code", async () => {
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
    await writeFile(join(root, "old.txt"), "keep");
    await addFile(files, "old.txt", "updated", true);
    await addFile(files, "new.txt", "new");
    await expect(
      executeFiles(files, async () => {
        throw new Error("install failed");
      }),
    ).rejects.toThrow("install failed");
    expect(await readFile(join(root, "old.txt"), "utf8")).toBe("keep");
    expect(await readdir(root)).not.toContain("new.txt");
    expect(() =>
      inspectStaticConfig('throw Error("DO NOT EXECUTE"); export default factory();', "config.ts"),
    ).toThrow("user-authored");
  });
});

it.each(["esm", "cjs"])(
  "adds centralized JavaScript connections in %s without duplicate helper declarations",
  async (format) => {
    const root = await temporary();
    await link(root);
    const initialized = await invoke(root, [
      "init",
      "--framework",
      "standalone",
      "--driver",
      "memory",
      "--no-orm",
      "--no-migrations",
      "--language",
      "javascript",
      "--module-format",
      format,
      "--no-install",
      "--yes",
    ]);
    expect(initialized.code, initialized.errors).toBe(0);
    const path = join(root, "src/duraxis.config.js");
    await writeFile(path, (await readFile(path, "utf8")) + "\n// keep application comment\n");
    const added = await invoke(root, [
      "connection:add",
      "reporting",
      "--driver",
      "memory",
      "--no-orm",
      "--no-migrations",
      "--no-install",
      "--yes",
    ]);
    expect(added.code, added.errors).toBe(0);
    const source = await readFile(path, "utf8");
    expect(source).toContain("// keep application comment");
    expect(
      source.match(/(?:import \{ defineDuraxisConfig|const \{ defineDuraxisConfig)/g),
    ).toHaveLength(1);
    const config = await loadConfig(root, undefined, "reporting");
    const database = await config.config.createDatabase();
    try {
      expect(database.namespace).toBe("reporting");
    } finally {
      await database.close({ closeStorage: true });
    }
  },
);
