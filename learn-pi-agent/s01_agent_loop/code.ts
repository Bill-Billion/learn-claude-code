import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantStopReason = "stop" | "toolUse" | "error";

export type AssistantMessage = {
  role: "assistant";
  content: string;
  stopReason: AssistantStopReason;
};

export type AgentMessage = UserMessage | AssistantMessage;

export type AgentState = {
  messages: AgentMessage[];
};

export type Provider = {
  complete(messages: AgentMessage[]): Promise<AssistantMessage>;
};

export function createInitialState(): AgentState {
  return { messages: [] };
}

export function createUserMessage(content: string): UserMessage {
  return { role: "user", content };
}

export class DemoProvider implements Provider {
  async complete(messages: AgentMessage[]): Promise<AssistantMessage> {
    const last = messages.at(-1);
    if (!last || last.role !== "user") {
      return {
        role: "assistant",
        content: "No new user message.",
        stopReason: "error",
      };
    }

    if (last.content.toLowerCase().includes("tool")) {
      return {
        role: "assistant",
        content: "I want to call a tool, but this lesson has no tool executor yet.",
        stopReason: "toolUse",
      };
    }

    return {
      role: "assistant",
      content: `Received: ${last.content}`,
      stopReason: "stop",
    };
  }
}

export async function runOneTurn(
  state: AgentState,
  provider: Provider,
  userInput: string,
): Promise<AssistantMessage> {
  const userMessage = createUserMessage(userInput);
  state.messages.push(userMessage);

  const assistantMessage = await provider.complete(state.messages);
  state.messages.push(assistantMessage);

  return assistantMessage;
}

export async function runScript(
  inputs: string[],
  provider: Provider = new DemoProvider(),
): Promise<AgentState> {
  const state = createInitialState();

  for (const text of inputs) {
    await runOneTurn(state, provider, text);
  }

  return state;
}

function printAssistant(message: AssistantMessage): void {
  console.log(`Assistant [${message.stopReason}]: ${message.content}`);
}

export async function runDemo(): Promise<AgentState> {
  const inputs = ["hello", "does this lesson have tools?"];
  const state = createInitialState();
  const provider = new DemoProvider();

  for (const text of inputs) {
    console.log(`User: ${text}`);
    const message = await runOneTurn(state, provider, text);
    printAssistant(message);
  }

  console.log(`Messages: ${state.messages.length}`);
  return state;
}

async function runRepl(): Promise<void> {
  const rl = createInterface({ input, output });
  const state = createInitialState();
  const provider = new DemoProvider();

  console.log("s01 Agent Loop. Type exit to quit.");

  while (true) {
    const text = (await rl.question("You > ")).trim();
    if (!text) {
      continue;
    }
    if (text === "exit" || text === "quit") {
      break;
    }

    const message = await runOneTurn(state, provider, text);
    printAssistant(message);
  }

  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--demo")) {
    await runDemo();
  } else {
    await runRepl();
  }
}
