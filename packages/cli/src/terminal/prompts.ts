import { createInterface } from "node:readline/promises";
export type Prompt = (
  question: string,
  fallback: string,
  choices?: readonly string[],
) => Promise<string>;
export async function withPrompts<T>(
  run: (ask: Prompt) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  const ask: Prompt = async (question, fallback, choices) => {
    signal?.throwIfAborted();
    const numbered = choices
      ? `\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}\n`
      : "";
    const value = await new Promise<string>((resolve, reject) => {
      const cancel = () => {
        cleanup();
        reject(new Error("Initialization cancelled (EOF or Ctrl+C)"));
      };
      const cleanup = () => {
        terminal.removeListener("close", cancel);
        terminal.removeListener("SIGINT", cancel);
      };
      terminal.once("close", cancel);
      terminal.once("SIGINT", cancel);
      terminal.question(`${question}${numbered} [${fallback}]: `, { signal }).then(
        (answer) => {
          cleanup();
          resolve(answer.trim() || fallback);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
    if (choices && /^\d+$/.test(value)) {
      const selected = choices[Number(value) - 1];
      if (!selected) throw new Error("Invalid numbered selection");
      return selected;
    }
    if (choices && !choices.includes(value))
      throw new Error(`Choose one of: ${choices.join(", ")}`);
    return value;
  };
  try {
    return await run(ask);
  } finally {
    terminal.close();
  }
}
