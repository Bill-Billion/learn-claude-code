import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../s04_evented_tool_loop/code.ts";
import type { AgentMessage } from "../s06_turn_state/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import { createFileSystemResourceSource } from "../s08_context_resources/code.ts";
import {
  loadMiniExtensions,
  runExtensionTurn,
  type RunExtensionTurnOptions,
} from "../s09_extension_runtime/code.ts";
import { createCourseToolRegistry } from "../s02_tool_schema/code.ts";
import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";

export type MiniRuntimeMessage = AgentMessage;
export type MiniRuntimeEvent = AgentEvent;

export type MiniRuntimeState = {
  sessionId: string;
  turns: number;
  messageCount: number;
  lastAssistantText?: string;
};

export type MiniRunResult = {
  sessionId: string;
  runId: string;
  finalText: string;
  events: MiniRuntimeEvent[];
  messages: MiniRuntimeMessage[];
};

export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
}

export type MiniCoreRuntimeOptions = Omit<RunExtensionTurnOptions, "prompt" | "onEvent">;

export type MiniRpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "get_state" };

export type MiniRpcPromptSuccess = {
  id?: string;
  type: "response";
  command: "prompt";
  success: true;
  data: MiniRunResult;
};

export type MiniRpcStateSuccess = {
  id?: string;
  type: "response";
  command: "get_state";
  success: true;
  data: MiniRuntimeState;
};

export type MiniRpcFailure = {
  id?: string;
  type: "response";
  command: string;
  success: false;
  error: string;
};

export type MiniRpcResponse = MiniRpcPromptSuccess | MiniRpcStateSuccess | MiniRpcFailure;
export type MiniRpcPromptResponse = MiniRpcPromptSuccess | MiniRpcFailure;

export class MiniCoreRuntime implements MiniRuntime {
  private readonly options: MiniCoreRuntimeOptions;
  private readonly runs: MiniRunResult[] = [];
  private readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: MiniRuntimeEvent) => void>();
  private messages: AgentMessage[] = [];
  private sessionId = "";
  private promptCount = 0;

  private constructor(options: MiniCoreRuntimeOptions) {
    this.options = options;
  }

  static async create(options: MiniCoreRuntimeOptions): Promise<MiniCoreRuntime> {
    const runtime = new MiniCoreRuntime(options);
    await runtime.refreshSessionState();
    runtime.promptCount = countUserMessages(runtime.messages);
    return runtime;
  }

  async prompt(prompt: string): Promise<MiniRunResult> {
    this.promptCount += 1;
    this.prompts.push(prompt);
    const promptNumber = this.promptCount;
    const events: AgentEvent[] = [];
    let turn: Awaited<ReturnType<typeof runExtensionTurn>>;
    try {
      turn = await runExtensionTurn({
        ...this.options,
        prompt,
        onEvent: async (event) => {
          const snapshot = structuredClone(event);
          events.push(snapshot);
          for (const listener of this.listeners) listener(structuredClone(snapshot));
        },
      });
    } catch (error) {
      try {
        await this.refreshSessionState();
      } catch {
        // Preserve the provider, tool-loop, or observer error that ended the prompt.
      }
      throw error;
    }
    await this.refreshSessionState();
    const runId = `${this.sessionId}:${promptNumber}`;
    const finalText = readAssistantText(turn.finalMessage);
    const result: MiniRunResult = {
      sessionId: this.sessionId,
      runId,
      finalText,
      events,
      messages: this.getMessages(),
    };
    this.runs.push(cloneRunResult(result));
    return cloneRunResult(result);
  }

  getState(): MiniRuntimeState {
    const lastAssistantText = readLastAssistantText(this.messages);
    return {
      sessionId: this.sessionId,
      turns: this.promptCount,
      messageCount: this.messages.length,
      ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
    };
  }

  getMessages(): MiniRuntimeMessage[] {
    return this.messages.map((message) => structuredClone(message));
  }

  getPrompts(): string[] {
    return [...this.prompts];
  }

  getRuns(): MiniRunResult[] {
    return this.runs.map(cloneRunResult);
  }

  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async refreshSessionState(): Promise<void> {
    const metadata = await this.options.session.getMetadata();
    const context = await this.options.session.buildContext();
    this.sessionId = metadata.id;
    this.messages = context.messages.map((message) => structuredClone(message));
  }
}

export function createMiniCoreRuntime(options: MiniCoreRuntimeOptions): Promise<MiniCoreRuntime> {
  return MiniCoreRuntime.create(options);
}

export async function runPrintMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  return (await runtime.prompt(prompt)).finalText;
}

export async function runJsonMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function runRpcMode(
  runtime: MiniRuntime,
  command: Extract<MiniRpcCommand, { type: "prompt" }>,
): Promise<MiniRpcPromptResponse>;
export function runRpcMode(
  runtime: MiniRuntime,
  command: Extract<MiniRpcCommand, { type: "get_state" }>,
): Promise<Extract<MiniRpcResponse, { command: "get_state"; success: true }>>;
export function runRpcMode(runtime: MiniRuntime, command: MiniRpcCommand): Promise<MiniRpcResponse>;
export async function runRpcMode(runtime: MiniRuntime, command: MiniRpcCommand): Promise<MiniRpcResponse> {
  switch (command.type) {
    case "prompt": {
      try {
        return {
          id: command.id,
          type: "response",
          command: "prompt",
          success: true,
          data: await runtime.prompt(command.message),
        };
      } catch (error) {
        return {
          id: command.id,
          type: "response",
          command: "prompt",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "get_state":
      return {
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: runtime.getState(),
      };
    default:
      return {
        id: (command as { id?: string }).id,
        type: "response",
        command: (command as { type?: string }).type ?? "unknown",
        success: false,
        error: "Unknown RPC command",
      };
  }
}

export function createSdkSession(runtime: MiniRuntime): {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
} {
  return {
    prompt: (prompt) => runtime.prompt(prompt),
    getState: () => runtime.getState(),
    subscribe: (listener) => runtime.subscribe(listener),
  };
}

export async function runInteractiveMode(runtime: MiniRuntime, prompts: string[]): Promise<string[]> {
  const transcript: string[] = [];
  for (const prompt of prompts) {
    transcript.push(`user> ${prompt}`);
    transcript.push(`assistant> ${(await runtime.prompt(prompt)).finalText}`);
  }
  return transcript;
}

function readAssistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function readLastAssistantText(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return readAssistantText(message);
  }
  return undefined;
}

function countUserMessages(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function cloneRunResult(result: MiniRunResult): MiniRunResult {
  return structuredClone(result);
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const cwd = process.cwd();
  const core = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: createFileSystemResourceSource(),
    cwd,
    agentDir: process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
    session: createSessionTree({ cwd }),
    model: runtime.model,
    registry: createCourseToolRegistry(cwd),
    activeToolNames: ["read_file"],
    streamOptions: runtime.streamOptions,
  });
  await runPromptCli("s10 Runtime Modes", (prompt) => runPrintMode(core, prompt));
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
