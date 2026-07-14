import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";

export const ENTRY_CHECK_HANDSHAKE_PREFIX = "PI_ENTRY_CHECK_MAIN:";

export type PromptHandler = (prompt: string) => Promise<string | void>;

export type PromptCliIo = {
  input?: Readable;
  output?: Writable;
};

export function parsePromptArguments(argv: string[] = process.argv): string | undefined {
  const prompt = argv.slice(2).join(" ").trim();
  return prompt || undefined;
}

export function isMainModule(metaUrl: string): boolean {
  const isMain = process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
  const entryCheckToken = process.env.PI_ENTRY_CHECK_TOKEN?.trim();
  if (isMain && entryCheckToken) {
    stderr.write(`${ENTRY_CHECK_HANDSHAKE_PREFIX}${entryCheckToken}\n`);
  }
  return isMain;
}

export async function runPromptCli(
  title: string,
  handlePrompt: PromptHandler,
  argv: string[] = process.argv,
  io: PromptCliIo = {},
): Promise<void> {
  const input = io.input ?? stdin;
  const output = io.output ?? stdout;
  const oneShotPrompt = parsePromptArguments(argv);
  if (oneShotPrompt) {
    await writePromptResult(output, await handlePrompt(oneShotPrompt));
    return;
  }

  const readline = createInterface({ input, output });
  output.write(`${title}. Type exit to quit.\n`);

  try {
    output.write("You > ");
    for await (const line of readline) {
      const prompt = line.trim();
      if (!prompt) {
        output.write("You > ");
        continue;
      }
      if (prompt === "exit" || prompt === "quit") break;
      await writePromptResult(output, await handlePrompt(prompt));
      output.write("You > ");
    }
  } finally {
    readline.close();
  }
}

async function writePromptResult(output: Writable, result: string | void): Promise<void> {
  if (result !== undefined) output.write(`${result}\n`);
}
