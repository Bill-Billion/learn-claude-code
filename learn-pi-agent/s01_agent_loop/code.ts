import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  Type,
  complete,
  validateToolCall,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";

const MAX_READ_BYTES = 64 * 1024;

const readFileParameters = Type.Object({
  path: Type.String({ description: "A file path relative to the course root." }),
}, { additionalProperties: false });

export const readFileTool: Tool<typeof readFileParameters> = {
  name: "read_file",
  description: "Read one UTF-8 text file inside the course root.",
  parameters: readFileParameters,
};

export type AgentState = {
  messages: Message[];
};

export type ToolRuntime = {
  tools: Tool[];
  execute(toolCall: ToolCall): Promise<ToolResultMessage>;
};

export type RunAgentLoopOptions = {
  model: Model<Api>;
  prompt: string;
  state?: AgentState;
  cwd?: string;
  systemPrompt?: string;
  streamOptions?: ProviderStreamOptions;
  maxTurns?: number;
  toolRuntime?: ToolRuntime;
};

export type RunAgentLoopResult = {
  state: AgentState;
  finalMessage: AssistantMessage;
  toolResults: ToolResultMessage[];
};

export function createInitialState(messages: Message[] = []): AgentState {
  return { messages: [...messages] };
}

export function createUserMessage(content: string): UserMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

export function createReadFileToolRuntime(courseRoot: string): ToolRuntime {
  return {
    tools: [readFileTool],
    async execute(toolCall) {
      const input = validateToolCall([readFileTool], toolCall) as { path: string };
      const text = await readSafeTextFile(courseRoot, input.path);
      return createToolResultMessage(toolCall, text, false);
    },
  };
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const maxTurns = options.maxTurns ?? 8;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive safe integer");
  }

  const state = options.state ?? createInitialState();
  const toolRuntime = options.toolRuntime ?? createReadFileToolRuntime(options.cwd ?? process.cwd());
  const toolResults: ToolResultMessage[] = [];
  state.messages.push(createUserMessage(options.prompt));

  for (let turn = 0; turn < maxTurns; turn++) {
    const assistantMessage = await complete(options.model, {
      systemPrompt: options.systemPrompt,
      messages: state.messages,
      tools: toolRuntime.tools,
    }, options.streamOptions);
    state.messages.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      throw new Error(assistantMessage.errorMessage ?? `Model stopped with ${assistantMessage.stopReason}`);
    }

    const toolCalls = assistantMessage.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      return { state, finalMessage: assistantMessage, toolResults };
    }

    for (const toolCall of toolCalls) {
      const result = await executeToolCallSafely(toolRuntime, toolCall);
      state.messages.push(result);
      toolResults.push(result);
    }
  }

  throw new Error(`Agent exceeded the maximum of ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}`);
}

export function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function executeToolCallSafely(runtime: ToolRuntime, toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    return await runtime.execute(toolCall);
  } catch (error) {
    return createToolResultMessage(
      toolCall,
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}

function createToolResultMessage(toolCall: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

async function readSafeTextFile(courseRoot: string, requestedPath: string): Promise<string> {
  const pathSegments = requestedPath.replace(/\\/g, "/").split("/");
  if (!requestedPath.trim()) {
    throw new Error("read_file path must not be empty");
  }
  if (pathSegments.some((segment) => segment.startsWith("."))) {
    throw new Error("read_file refuses hidden path segments");
  }

  const root = await realpath(courseRoot);
  const candidate = resolve(root, requestedPath);
  ensureInsideRoot(root, candidate);

  const resolvedFile = await realpath(candidate);
  ensureInsideRoot(root, resolvedFile);

  const fileInfo = await stat(resolvedFile);
  if (!fileInfo.isFile()) {
    throw new Error("read_file only accepts regular files");
  }
  if (fileInfo.size > MAX_READ_BYTES) {
    throw new Error(`read_file limit is ${MAX_READ_BYTES} bytes`);
  }

  const data = await readFile(resolvedFile);
  if (data.byteLength > MAX_READ_BYTES) {
    throw new Error(`read_file limit is ${MAX_READ_BYTES} bytes`);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("read_file only accepts valid UTF-8 text");
  }
}

function ensureInsideRoot(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error("read_file resolved outside the course root");
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const state = createInitialState();
  await runPromptCli("s01 Agent Loop", async (prompt) => {
    const result = await runAgentLoop({
      ...runtime,
      prompt,
      state,
      cwd: process.cwd(),
    });
    return readAssistantText(result.finalMessage);
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
