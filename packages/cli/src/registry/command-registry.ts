export const options = {
  config: { type: "string" },
  database: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  framework: { type: "string" },
  driver: { type: "string" },
  orm: { type: "boolean" },
  "no-orm": { type: "boolean" },
  migrations: { type: "boolean" },
  "no-migrations": { type: "boolean" },
  "package-manager": { type: "string" },
  language: { type: "string" },
  "module-format": { type: "string" },
  namespace: { type: "string" },
  directory: { type: "string" },
  "source-dir": { type: "string" },
  "storage-directory": { type: "string" },
  bucket: { type: "string" },
  prefix: { type: "string" },
  region: { type: "string" },
  endpoint: { type: "string" },
  "force-path-style": { type: "boolean" },
  "schema-mode": { type: "string" },
  example: { type: "boolean" },
  "no-example": { type: "boolean" },
  install: { type: "boolean" },
  "no-install": { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  steps: { type: "string" },
  to: { type: "string" },
  "allow-destructive": { type: "boolean" },
  offline: { type: "boolean" },
  persisted: { type: "boolean" },
  schema: { type: "string" },
  live: { type: "boolean" },
  evaluate: { type: "boolean" },
  check: { type: "boolean" },
  apply: { type: "boolean" },
  registry: { type: "string" },
  prerelease: { type: "boolean" },
  "custom-module": { type: "string" },
  "custom-export": { type: "string" },
  "custom-constructor": { type: "boolean" },
  "custom-options": { type: "string" },
  "max-stored-bytes": { type: "string" },
  "max-object-bytes": { type: "string" },
  "max-entries": { type: "string" },
  "max-metadata-bytes": { type: "string" },
  "max-journal-bytes": { type: "string" },
  "max-queued-operations": { type: "string" },
  "max-pending-operations": { type: "string" },
  "max-attempts": { type: "string" },
  "ownership-recovery": { type: "string" },
  "application-id": { type: "string" },
  "resources-file": { type: "string" },
  "cursor-key-env": { type: "string" },
} as const;
export type OptionName = keyof typeof options;
export interface CommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly category: string;
  readonly description: string;
  readonly positional: readonly string[];
  readonly optionalPositionals?: boolean;
  readonly options: readonly OptionName[];
  readonly required: readonly OptionName[];
  readonly defaults: Readonly<Record<string, string | boolean>>;
  readonly exclusive: readonly (readonly OptionName[])[];
  readonly examples: readonly string[];
  readonly configuration: "none" | "static" | "migration";
  readonly database: boolean | "conditional";
  readonly interactive: boolean;
  readonly handler: "init" | "admin" | "migration" | "help" | "version";
}
const initOptions: readonly OptionName[] = [
  "framework",
  "driver",
  "orm",
  "no-orm",
  "migrations",
  "no-migrations",
  "package-manager",
  "language",
  "module-format",
  "namespace",
  "directory",
  "source-dir",
  "storage-directory",
  "bucket",
  "prefix",
  "region",
  "endpoint",
  "force-path-style",
  "schema-mode",
  "example",
  "no-example",
  "install",
  "no-install",
  "dry-run",
  "yes",
  "registry",
  "prerelease",
  "custom-module",
  "custom-export",
  "custom-constructor",
  "custom-options",
  "max-stored-bytes",
  "max-object-bytes",
  "max-entries",
  "max-metadata-bytes",
  "max-journal-bytes",
  "max-queued-operations",
  "max-pending-operations",
  "max-attempts",
  "resources-file",
  "cursor-key-env",
  "ownership-recovery",
  "application-id",
];
function command(
  name: string,
  category: string,
  description: string,
  handler: CommandDefinition["handler"],
  extra: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    name,
    category,
    description,
    handler,
    aliases: [],
    positional: [],
    options: [],
    required: [],
    defaults: {},
    exclusive: [],
    examples: [`duraxis ${name}`],
    configuration: "none",
    database: false,
    interactive: false,
    ...extra,
  };
}
export const commands: readonly CommandDefinition[] = [
  command("init", "SETUP", "Initialize and configure Duraxis", "init", {
    options: initOptions,
    interactive: true,
    defaults: {
      driver: "disk",
      framework: "auto",
      language: "auto",
      "module-format": "auto",
      namespace: "default",
      install: true,
    },
    exclusive: [
      ["orm", "no-orm"],
      ["migrations", "no-migrations"],
      ["install", "no-install"],
      ["example", "no-example"],
    ],
    examples: [
      "duraxis init --driver disk --migrations --yes",
      "duraxis init --driver memory --no-orm --no-install --yes",
    ],
  }),
  command(
    "doctor",
    "SETUP",
    "Diagnose project and environment without executing configuration",
    "admin",
  ),
  command(
    "config:show",
    "CONFIGURATION",
    "Show redacted static configuration (or trusted code with --evaluate)",
    "admin",
    { options: ["evaluate"], configuration: "static" },
  ),
  command(
    "config:validate",
    "CONFIGURATION",
    "Validate configuration without opening storage",
    "admin",
    { options: ["evaluate"], configuration: "static" },
  ),
  command("config:set", "CONFIGURATION", "Set a supported managed connection value", "admin", {
    positional: ["key", "value"],
    options: ["dry-run"],
    configuration: "static",
  }),
  command("connection:add", "CONFIGURATION", "Add a managed named connection", "admin", {
    positional: ["name"],
    options: initOptions,
    configuration: "static",
  }),
  command(
    "connection:list",
    "CONFIGURATION",
    "List connections without opening databases",
    "admin",
    { configuration: "static" },
  ),
  command("storage:list", "STORAGE", "List official drivers and operational limits", "admin"),
  command(
    "storage:check",
    "STORAGE",
    "Check configuration; --live opens storage read-only",
    "admin",
    { options: ["live"], configuration: "static" },
  ),
  command(
    "generate:entity",
    "GENERATORS",
    "Generate an ORM entity and update a managed registry",
    "admin",
    { positional: ["name"], options: ["dry-run"], configuration: "static" },
  ),
  command("generate:module", "GENERATORS", "Generate a NestJS feature module", "admin", {
    positional: ["name"],
    options: ["dry-run"],
    configuration: "static",
  }),
  ...(
    [
      ["migration:create", "Create a manual migration", ["name"], []],
      ["migration:generate", "Generate a schema migration", ["name"], ["allow-destructive"]],
      ["migration:snapshot", "Save expected schema snapshot", [], ["schema"]],
      ["migration:remove", "Remove latest unpublished migration", [], ["yes"]],
      ["migration:baseline", "Adopt existing schema", ["name"], ["yes"]],
      [
        "migrate:up",
        "Apply pending migrations",
        [],
        ["steps", "to", "dry-run", "allow-destructive"],
      ],
      ["migrate:down", "Roll back migrations (target retained)", [], ["steps", "to", "yes"]],
      ["migrate:status", "Display migration history", [], []],
      ["migrate:diff", "Compare schemas", [], ["persisted"]],
      ["migrate:check", "Validate migration integrity", [], ["offline"]],
    ] satisfies [string, string, string[], OptionName[]][]
  ).map(([name, description, positional, supported]) =>
    command(name, "MIGRATIONS", description, "migration", {
      positional,
      options: supported,
      configuration: "migration",
      required:
        name === "migration:snapshot"
          ? ["schema"]
          : ["migration:remove", "migration:baseline", "migrate:down"].includes(name)
            ? ["yes"]
            : [],
      database: name.startsWith("migrate:")
        ? "conditional"
        : ["migration:baseline", "migration:remove"].includes(name),
      exclusive: [["steps", "to"]],
    }),
  ),
  command(
    "upgrade",
    "DEPENDENCIES",
    "Check or explicitly apply compatible published updates",
    "admin",
    {
      options: ["check", "apply", "package-manager", "registry", "prerelease"],
      exclusive: [["check", "apply"]],
      defaults: { check: true },
    },
  ),
  command("help", "INFORMATION", "Display command documentation", "help", {
    positional: ["command"],
    optionalPositionals: true,
  }),
  command("version", "INFORMATION", "Display the CLI version", "version", {
    aliases: ["--version"],
  }),
];
export function findCommand(name: string): CommandDefinition {
  const found = commands.find((c) => c.name === name || c.aliases.includes(name));
  if (!found) throw new Error(`Unknown command: ${name}. Run duraxis help.`);
  return found;
}
export function helpText(definition?: CommandDefinition): string {
  if (!definition)
    return `Duraxis CLI\n\nUsage: duraxis <command> [options]\n\n${[
      ...new Set(commands.map((c) => c.category)),
    ]
      .map(
        (category) =>
          `${category}\n${commands
            .filter((c) => c.category === category)
            .map((c) => `  ${c.name.padEnd(22)} ${c.description}`)
            .join("\n")}`,
      )
      .join(
        "\n\n",
      )}\n\nExamples:\n  duraxis init\n  duraxis doctor\n  duraxis help init\n  duraxis migrate:status\n  duraxis upgrade --check\n`;
  const supportedOptions: readonly OptionName[] = [
    "config",
    "database",
    "json",
    "help",
    ...definition.options,
  ];
  return `${definition.description}\n\nUsage: duraxis ${definition.name} ${definition.positional.map((p) => `<${p}>`).join(" ")} [options]\n\n${supportedOptions.map((name) => `  --${name}${options[name].type === "string" ? " <value>" : ""}${definition.defaults[name] !== undefined ? ` (default: ${definition.defaults[name]})` : ""}${definition.required.includes(name) ? " (required)" : ""}`).join("\n")}\n\nConfiguration: ${definition.configuration}; database access: ${definition.database === "conditional" ? "depends on command flags" : definition.database ? "required" : "not required by default"}.\n${definition.exclusive.map((group) => `Mutually exclusive: ${group.map((n) => `--${n}`).join(", ")}`).join("\n")}\n${definition.name === "storage:check" ? "Live Disk checks may acquire exclusive directory ownership. No test objects are written." : ""}\nExamples:\n${definition.examples.map((e) => `  ${e}`).join("\n")}`;
}
