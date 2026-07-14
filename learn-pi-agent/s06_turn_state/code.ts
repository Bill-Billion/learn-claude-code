import {
  type Api,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
} from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import { createInitialState, createUserMessage } from "../s01_agent_loop/code.ts";
import {
  createCourseToolRegistry,
  listToolDefinitions,
  selectToolRegistry,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import {
  runHookedToolLoop,
  type HookedToolLoopResult,
  type RunHookedToolLoopOptions,
  type ToolHooks,
} from "../s05_tool_hooks/code.ts";

export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n";
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n";

export type BashExecutionMessage = {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
};

export type CustomMessage = {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
};

export type BranchSummaryMessage = {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
};

export type CompactionSummaryMessage = {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
};

export type AgentMessage =
  | Message
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

export type MiniSkill = {
  name: string;
  description: string;
};

export type MiniPromptTemplate = {
  name: string;
  description?: string;
  content: string;
};

export type MiniResources = {
  skills?: MiniSkill[];
  promptTemplates?: MiniPromptTemplate[];
};

export type MiniStreamOptions = ProviderStreamOptions;

export type MiniSession<TMessage = AgentMessage> = {
  messages: TMessage[];
  appendMessage(message: AgentMessage): unknown | Promise<unknown>;
  buildContext(): { messages: TMessage[] } | Promise<{ messages: TMessage[] }>;
  getMetadata(): { id: string } | Promise<{ id: string }>;
};

export type TransformContext = (
  messages: AgentMessage[],
) => AgentMessage[] | Promise<AgentMessage[]>;

export type MiniSystemPrompt =
  | string
  | ((context: {
      session: MiniSession<AgentMessage>;
      model: Model<Api>;
      activeTools: Tool[];
      resources: MiniResources;
    }) => string | Promise<string>);

export type MiniHarnessOptions = {
  session: MiniSession<AgentMessage>;
  model: Model<Api>;
  registry: ToolRegistry;
  activeToolNames?: string[];
  resources?: MiniResources;
  systemPrompt?: MiniSystemPrompt;
  streamOptions?: MiniStreamOptions;
  transformContext?: TransformContext;
};

export type TurnState = {
  messages: AgentMessage[];
  resources: MiniResources;
  streamOptions: MiniStreamOptions;
  sessionId: string;
  systemPrompt: string;
  model: Model<Api>;
  tools: Tool[];
  activeTools: Tool[];
};

export type MiniHarness = {
  createTurnState(): Promise<TurnState>;
  createLlmContext(turnState?: TurnState): Promise<Context>;
};

export type RunHarnessTurnOptions = MiniHarnessOptions & {
  prompt: string;
  hooks?: ToolHooks;
  maxTurns?: number;
  onEvent?: RunHookedToolLoopOptions["onEvent"];
};

export type RunHarnessTurnResult = HookedToolLoopResult & {
  turnState: TurnState;
  llmContext: Context;
  addedMessages: Message[];
};

export function createMemorySession(
  id: string,
  initialMessages: AgentMessage[] = [],
): MiniSession<AgentMessage> {
  const messages = initialMessages.map(cloneAgentMessage);
  return {
    messages,
    appendMessage(message) {
      messages.push(cloneAgentMessage(message));
    },
    async buildContext() {
      return { messages: messages.map(cloneAgentMessage) };
    },
    async getMetadata() {
      return { id };
    },
  };
}

export function createMiniHarness(options: MiniHarnessOptions): MiniHarness {
  const tools = listToolDefinitions(options.registry).map(cloneTool);
  const activeToolNames = options.activeToolNames ? [...options.activeToolNames] : tools.map((tool) => tool.name);
  validateActiveToolNames(tools, activeToolNames);

  const resources = cloneResources(options.resources ?? {});
  const streamOptions = cloneStreamOptions(options.streamOptions);
  const systemPrompt = options.systemPrompt ?? "You are a helpful assistant.";

  const createTurnState = async (): Promise<TurnState> => {
    const context = await options.session.buildContext();
    const metadata = await options.session.getMetadata();
    const model = cloneData(options.model);
    const activeTools = activeToolNames.map((name) => tools.find((tool) => tool.name === name)!);
    const turnResources = cloneResources(resources);
    const resolvedSystemPrompt = typeof systemPrompt === "string"
      ? systemPrompt
      : await systemPrompt({
          session: options.session,
          model: cloneData(model),
          activeTools: activeTools.map(cloneTool),
          resources: cloneResources(turnResources),
        });

    return {
      messages: context.messages.map(cloneAgentMessage),
      resources: turnResources,
      streamOptions: cloneStreamOptions(streamOptions),
      sessionId: metadata.id,
      systemPrompt: resolvedSystemPrompt,
      model,
      tools: tools.map(cloneTool),
      activeTools: activeTools.map(cloneTool),
    };
  };

  return {
    createTurnState,
    async createLlmContext(turnState) {
      const currentTurnState = turnState ?? await createTurnState();
      const sourceMessages = currentTurnState.messages.map(cloneAgentMessage);
      const transformed = options.transformContext
        ? await options.transformContext(sourceMessages)
        : sourceMessages;
      return {
        systemPrompt: currentTurnState.systemPrompt,
        messages: convertToLlm(transformed),
        tools: currentTurnState.activeTools.map(cloneTool),
      };
    },
  };
}

export async function runHarnessTurn(options: RunHarnessTurnOptions): Promise<RunHarnessTurnResult> {
  validateMaxTurns(options.maxTurns);
  const appendMessage = requireMessageSink(options.session);
  const harness = createMiniHarness(options);
  const turnState = await harness.createTurnState();
  const llmContext = await harness.createLlmContext(turnState);
  const initialMessages = llmContext.messages;
  const state = createInitialState(initialMessages);
  const activeRegistry = selectActiveRegistry(options.registry, turnState.activeTools);
  const promptMessage = createUserMessage(options.prompt);
  const addedMessages: Message[] = [promptMessage];
  await appendMessage(promptMessage);
  const result = await runHookedToolLoop({
    model: turnState.model,
    prompt: options.prompt,
    registry: activeRegistry,
    state,
    userMessage: promptMessage,
    systemPrompt: turnState.systemPrompt,
    streamOptions: turnState.streamOptions,
    hooks: options.hooks,
    maxTurns: options.maxTurns,
    async onEvent(event) {
      const message = event.type === "tool_execution_end"
        ? event.result
        : event.type === "message_end" && event.message.role === "assistant"
          ? event.message
          : undefined;
      if (message) {
        await appendMessage(message);
        addedMessages.push(cloneData(message));
      }
      await options.onEvent?.(event);
    },
  });
  return {
    ...result,
    turnState,
    llmContext,
    addedMessages: addedMessages.map((message) => cloneData(message)),
  };
}

function requireMessageSink(
  session: MiniSession<AgentMessage>,
): (message: AgentMessage) => Promise<void> {
  return async (message) => {
    await session.appendMessage(message);
  };
}

function validateMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error("maxTurns must be a positive safe integer");
  }
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    switch (message.role) {
      case "bashExecution":
        if (message.excludeFromContext) return [];
        return [{
          role: "user",
          content: [{ type: "text", text: bashExecutionToText(message) }],
          timestamp: message.timestamp,
        }];
      case "custom":
        return [{
          role: "user",
          content: typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : cloneData(message.content),
          timestamp: message.timestamp,
        }];
      case "branchSummary":
        return [{
          role: "user",
          content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary }],
          timestamp: message.timestamp,
        }];
      case "compactionSummary":
        return [{
          role: "user",
          content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + message.summary }],
          timestamp: message.timestamp,
        }];
      case "user":
      case "assistant":
      case "toolResult":
        return [cloneData(message)];
    }
  });
}

export function cloneAgentMessage<TMessage extends AgentMessage>(message: TMessage): TMessage {
  return cloneData(message);
}

export function listActiveToolNames(tools: Tool[]): string {
  return tools.map((tool) => tool.name).join(",");
}

function bashExecutionToText(message: BashExecutionMessage): string {
  let text = `Ran \`${message.command}\``;
  text += message.output ? `\n\`\`\`\n${message.output}\n\`\`\`` : "\n(no output)";
  if (message.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (message.exitCode !== undefined && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

function validateActiveToolNames(tools: Tool[], activeToolNames: string[]): void {
  const known = new Set(tools.map((tool) => tool.name));
  const seen = new Set<string>();
  for (const name of activeToolNames) {
    if (!known.has(name)) throw new Error(`Unknown active tool: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate active tool: ${name}`);
    seen.add(name);
  }
}

function selectActiveRegistry(registry: ToolRegistry, activeTools: Tool[]): ToolRegistry {
  return selectToolRegistry(registry, activeTools.map((tool) => tool.name));
}

function cloneResources(resources: MiniResources): MiniResources {
  return cloneData(resources);
}

function cloneStreamOptions(streamOptions: MiniStreamOptions = {}): MiniStreamOptions {
  return {
    ...streamOptions,
    headers: streamOptions.headers ? { ...streamOptions.headers } : undefined,
    metadata: streamOptions.metadata ? cloneData(streamOptions.metadata) : undefined,
  };
}

function cloneTool(tool: Tool): Tool {
  return cloneData(tool);
}

function cloneData<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing) return existing as T;

  const clone: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  seen.set(object, clone);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = cloneData(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const session = createMemorySession(`s06-${Date.now()}`);
  const registry = createCourseToolRegistry(process.cwd());

  await runPromptCli("s06 Agent Messages", async (prompt) => {
    const result = await runHarnessTurn({
      session,
      model: runtime.model,
      registry,
      streamOptions: runtime.streamOptions,
      prompt,
    });
    return result.finalMessage.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
