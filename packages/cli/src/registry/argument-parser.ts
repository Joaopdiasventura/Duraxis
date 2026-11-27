import { parseArgs } from "node:util";
import { options, findCommand } from "./command-registry.js";
export function parseCommand(args: readonly string[]) {
  const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  const name = parsed.values.version ? "version" : (parsed.positionals[0] ?? "help");
  const definition = findCommand(name);
  const positionals = parsed.positionals.slice(parsed.positionals[0] ? 1 : 0);
  if (positionals.length > definition.positional.length)
    throw new Error("Unexpected positional arguments");
  for (const option of Object.keys(parsed.values))
    if (!["config", "database", "json", "help", "version", ...definition.options].includes(option))
      throw new Error(`Option --${option} is not supported by ${name}`);
  if (!parsed.values.help) {
    if (!definition.optionalPositionals && positionals.length < definition.positional.length)
      throw new Error(`Missing positional arguments: ${definition.positional.join(", ")}`);
    for (const group of definition.exclusive)
      if (group.filter((n) => parsed.values[n] !== undefined).length > 1)
        throw new Error(`Mutually exclusive options: ${group.map((n) => `--${n}`).join(", ")}`);
    for (const option of definition.required)
      if (parsed.values[option] === undefined) throw new Error(`Missing required --${option}`);
  }
  return { ...parsed, definition, positionals };
}
export type ParsedCommand = ReturnType<typeof parseCommand>;
