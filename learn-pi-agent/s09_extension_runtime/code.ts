import { homedir } from "node:os";
import { join } from "node:path";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import {
  createCourseToolRegistry,
  extendToolRegistry,
  listToolDefinitions,
  type RegisteredTool,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import type { ToolHooks } from "../s05_tool_hooks/code.ts";
import {
  createMiniHarness,
  runHarnessTurn,
  type CustomMessage,
  type MiniResources,
  type RunHarnessTurnResult,
} from "../s06_turn_state/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import {
  createFileSystemResourceSource,
  prepareContextResources,
  type ContextResources,
  type CreateContextResourceTurnStateOptions,
} from "../s08_context_resources/code.ts";

export type ExtensionCustomMessage = Omit<CustomMessage, "role" | "timestamp"> & {
  timestamp?: number;
};

export type BeforeAgentStartEvent = {
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: {
    cwd: string;
    [key: string]: unknown;
  };
};

export type BeforeAgentStartResult = {
  systemPrompt?: string;
  message?: ExtensionCustomMessage;
};

export type ResourcesDiscoverEvent = {
  cwd: string;
  reason: "startup" | "reload";
};

export type ResourcesDiscoverResult = {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
};

export type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

export type ToolCallResult = {
  block?: boolean;
  reason?: string;
};

export type MiniUi = {
  notifications: string[];
  notify(message: string): void;
};

export type MiniExtensionContext = {
  ui: MiniUi;
  getSystemPrompt(): string;
};

export type MiniCommand = {
  name: string;
  description?: string;
  handler(args: string, ctx: MiniExtensionContext): Promise<void> | void;
};

type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx: MiniExtensionContext,
) => BeforeAgentStartResult | Promise<BeforeAgentStartResult | void> | void;

type ResourcesDiscoverHandler = (
  event: ResourcesDiscoverEvent,
  ctx: MiniExtensionContext,
) => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult | void> | void;

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: MiniExtensionContext,
) => ToolCallResult | Promise<ToolCallResult | void> | void;

export type MiniExtensionAPI = {
  on(event: "before_agent_start", handler: BeforeAgentStartHandler): void;
  on(event: "resources_discover", handler: ResourcesDiscoverHandler): void;
  on(event: "tool_call", handler: ToolCallHandler): void;
  registerTool(tool: RegisteredTool): void;
  registerCommand(name: string, command: Omit<MiniCommand, "name">): void;
};

export type MiniExtensionFactory = (pi: MiniExtensionAPI) => void | Promise<void>;

export type MiniExtensionSource = {
  path: string;
  factory: MiniExtensionFactory;
};

export type DiscoveredResourcePaths = {
  skillPaths: Array<{ path: string; extensionPath: string }>;
  promptPaths: Array<{ path: string; extensionPath: string }>;
  themePaths: Array<{ path: string; extensionPath: string }>;
};

export type CommandRunResult = {
  notifications: string[];
};

export type CreateExtensionTurnStateOptions = Omit<CreateContextResourceTurnStateOptions, "registry"> & {
  runner: MiniExtensionRunner;
  registry: ToolRegistry;
  prompt?: string;
};

export type ExtensionTurnState = Awaited<ReturnType<ReturnType<typeof createMiniHarness>["createTurnState"]>> & {
  contextFiles: ContextResources["contextFiles"];
  contextResources: ContextResources;
  discoveredResources: DiscoveredResourcePaths;
  beforeAgentStartMessages: CustomMessage[];
};

export type RunExtensionTurnOptions = CreateExtensionTurnStateOptions & {
  prompt: string;
  hooks?: ToolHooks;
  maxTurns?: number;
  onEvent?: Parameters<typeof runHarnessTurn>[0]["onEvent"];
};

export type RunExtensionTurnResult = RunHarnessTurnResult & {
  contextResources: ContextResources;
  discoveredResources: DiscoveredResourcePaths;
  beforeAgentStartMessages: CustomMessage[];
};

type HandlerMap = {
  before_agent_start: BeforeAgentStartHandler[];
  resources_discover: ResourcesDiscoverHandler[];
  tool_call: ToolCallHandler[];
};

type LoadedExtension = {
  path: string;
  handlers: HandlerMap;
  tools: RegisteredTool[];
  commands: MiniCommand[];
};

type PreparedExtensionTurn = {
  registry: ToolRegistry;
  contextResources: ContextResources;
  harnessResources: MiniResources;
  systemPrompt: string;
  discoveredResources: DiscoveredResourcePaths;
  beforeAgentStartMessages: CustomMessage[];
};

export async function loadMiniExtensions(sources: MiniExtensionSource[]): Promise<MiniExtensionRunner> {
  const extensions: LoadedExtension[] = [];
  const toolNames = new Set<string>();
  const commandNames = new Set<string>();

  for (const source of sources) {
    const extension = createEmptyExtension(source.path);
    await source.factory(createExtensionApi(extension));
    for (const tool of extension.tools) {
      if (toolNames.has(tool.name)) throw new Error(`Duplicate extension tool: ${tool.name}`);
      toolNames.add(tool.name);
    }
    for (const command of extension.commands) {
      if (commandNames.has(command.name)) throw new Error(`Duplicate extension command: ${command.name}`);
      commandNames.add(command.name);
    }
    extensions.push(extension);
  }

  return new MiniExtensionRunner(extensions);
}

export class MiniExtensionRunner {
  private readonly extensions: LoadedExtension[];

  constructor(extensions: LoadedExtension[]) {
    this.extensions = extensions.map(cloneExtension);
  }

  getTools(): RegisteredTool[] {
    return this.extensions.flatMap((extension) => extension.tools.map(cloneTool));
  }

  getCommands(): MiniCommand[] {
    return this.extensions.flatMap((extension) => extension.commands.map(cloneCommand));
  }

  async runCommand(name: string, args = ""): Promise<CommandRunResult> {
    const command = this.getCommands().find((candidate) => candidate.name === name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    const ui = createMiniUi();
    await command.handler(args, createContext(ui, ""));
    return { notifications: [...ui.notifications] };
  }

  async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<{
    systemPrompt: string;
    messages: CustomMessage[];
  }> {
    let currentSystemPrompt = event.systemPrompt;
    const messages: CustomMessage[] = [];

    for (const extension of this.extensions) {
      for (const handler of extension.handlers.before_agent_start) {
        const result = await handler(
          { ...event, systemPrompt: currentSystemPrompt },
          createContext(createMiniUi(), currentSystemPrompt),
        );
        if (result?.message) messages.push(materializeCustomMessage(result.message));
        if (result?.systemPrompt !== undefined) currentSystemPrompt = result.systemPrompt;
      }
    }
    return { systemPrompt: currentSystemPrompt, messages };
  }

  async emitResourcesDiscover(
    cwd: string,
    reason: ResourcesDiscoverEvent["reason"],
  ): Promise<DiscoveredResourcePaths> {
    const discovered: DiscoveredResourcePaths = {
      skillPaths: [],
      promptPaths: [],
      themePaths: [],
    };
    for (const extension of this.extensions) {
      for (const handler of extension.handlers.resources_discover) {
        const result = await handler({ cwd, reason }, createContext(createMiniUi(), ""));
        appendDiscovered(discovered.skillPaths, result?.skillPaths, extension.path);
        appendDiscovered(discovered.promptPaths, result?.promptPaths, extension.path);
        appendDiscovered(discovered.themePaths, result?.themePaths, extension.path);
      }
    }
    return discovered;
  }

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
    for (const extension of this.extensions) {
      for (const handler of extension.handlers.tool_call) {
        const result = await handler(cloneData(event), createContext(createMiniUi(), ""));
        if (result?.block) return { block: true, reason: result.reason };
      }
    }
    return undefined;
  }
}

export function mergeExtensionTools(baseRegistry: ToolRegistry, runner: MiniExtensionRunner): ToolRegistry {
  const baseNames = new Set(listToolDefinitions(baseRegistry).map((tool) => tool.name));
  for (const tool of runner.getTools()) {
    if (baseNames.has(tool.name)) {
      throw new Error(`Extension tool conflicts with existing tool: ${tool.name}`);
    }
  }
  return extendToolRegistry(baseRegistry, runner.getTools());
}

export function createExtensionToolHooks(runner: MiniExtensionRunner): ToolHooks {
  return {
    async beforeToolCall(context) {
      const result = await runner.emitToolCall({
        toolName: context.toolCall.name,
        input: cloneData(context.args),
      });
      return result?.block
        ? { block: true, reason: result.reason || "Tool execution was blocked by an extension" }
        : undefined;
    },
  };
}

export async function createExtensionTurnState(
  options: CreateExtensionTurnStateOptions,
): Promise<ExtensionTurnState> {
  const prepared = await prepareExtensionTurn(options);
  await persistBeforeAgentStartMessages(options, prepared.beforeAgentStartMessages);
  const turnState = await createPreparedHarness(options, prepared).createTurnState();
  return {
    ...turnState,
    contextFiles: cloneData(prepared.contextResources.contextFiles),
    contextResources: cloneData(prepared.contextResources),
    discoveredResources: cloneData(prepared.discoveredResources),
    beforeAgentStartMessages: prepared.beforeAgentStartMessages.map((message) => cloneData(message)),
  };
}

export async function runExtensionTurn(
  options: RunExtensionTurnOptions,
): Promise<RunExtensionTurnResult> {
  validateMaxTurns(options.maxTurns);
  const prepared = await prepareExtensionTurn(options);
  await persistBeforeAgentStartMessages(options, prepared.beforeAgentStartMessages);
  const result = await runHarnessTurn({
    session: options.session,
    model: options.model,
    registry: prepared.registry,
    activeToolNames: options.activeToolNames,
    resources: prepared.harnessResources,
    systemPrompt: prepared.systemPrompt,
    streamOptions: options.streamOptions,
    transformContext: options.transformContext,
    prompt: options.prompt,
    hooks: combineToolHooks(createExtensionToolHooks(options.runner), options.hooks),
    maxTurns: options.maxTurns,
    onEvent: options.onEvent,
  });
  return {
    ...result,
    contextResources: cloneData(prepared.contextResources),
    discoveredResources: cloneData(prepared.discoveredResources),
    beforeAgentStartMessages: prepared.beforeAgentStartMessages.map((message) => cloneData(message)),
  };
}

async function prepareExtensionTurn(
  options: CreateExtensionTurnStateOptions,
): Promise<PreparedExtensionTurn> {
  const discoveredResources = await options.runner.emitResourcesDiscover(options.cwd, "startup");
  const registry = mergeExtensionTools(options.registry, options.runner);
  const resourceOptions = {
    ...options,
    registry,
    skillFiles: [
      ...(options.skillFiles ?? []),
      ...discoveredResources.skillPaths.map((entry) => entry.path),
    ],
    promptTemplateFiles: [
      ...(options.promptTemplateFiles ?? []),
      ...discoveredResources.promptPaths.map((entry) => entry.path),
    ],
  };
  const preparedResources = await prepareContextResources(resourceOptions);
  const baseTurnState = await createMiniHarness({
    session: options.session,
    model: options.model,
    registry,
    activeToolNames: options.activeToolNames,
    resources: preparedResources.harnessResources,
    systemPrompt: preparedResources.systemPrompt,
    streamOptions: options.streamOptions,
    transformContext: options.transformContext,
  }).createTurnState();
  const before = await options.runner.emitBeforeAgentStart({
    prompt: options.prompt ?? "",
    systemPrompt: baseTurnState.systemPrompt,
    systemPromptOptions: { cwd: options.cwd },
  });
  return {
    registry,
    contextResources: preparedResources.contextResources,
    harnessResources: preparedResources.harnessResources,
    systemPrompt: before.systemPrompt,
    discoveredResources,
    beforeAgentStartMessages: before.messages,
  };
}

function createPreparedHarness(
  options: CreateExtensionTurnStateOptions,
  prepared: PreparedExtensionTurn,
) {
  return createMiniHarness({
    session: options.session,
    model: options.model,
    registry: prepared.registry,
    activeToolNames: options.activeToolNames,
    resources: prepared.harnessResources,
    systemPrompt: prepared.systemPrompt,
    streamOptions: options.streamOptions,
    transformContext: options.transformContext,
  });
}

async function persistBeforeAgentStartMessages(
  options: CreateExtensionTurnStateOptions,
  messages: CustomMessage[],
): Promise<void> {
  for (const message of messages) await options.session.appendMessage(message);
}

function combineToolHooks(extensionHooks: ToolHooks, callerHooks?: ToolHooks): ToolHooks {
  return {
    async beforeToolCall(context) {
      const callerResult = await callerHooks?.beforeToolCall?.(context);
      if (callerResult?.block) return callerResult;
      const effectiveArgs = callerResult?.arguments ?? context.args;
      const extensionResult = await extensionHooks.beforeToolCall?.({
        ...context,
        args: effectiveArgs,
        toolCall: callerResult?.arguments
          ? { ...context.toolCall, arguments: effectiveArgs }
          : context.toolCall,
      });
      if (extensionResult?.block) return extensionResult;
      return callerResult;
    },
    afterToolCall: callerHooks?.afterToolCall,
  };
}

function createEmptyExtension(path: string): LoadedExtension {
  return {
    path,
    handlers: { before_agent_start: [], resources_discover: [], tool_call: [] },
    tools: [],
    commands: [],
  };
}

function createExtensionApi(extension: LoadedExtension): MiniExtensionAPI {
  return {
    on(event, handler) {
      extension.handlers[event].push(handler as never);
    },
    registerTool(tool) {
      extension.tools.push(cloneTool(tool));
    },
    registerCommand(name, command) {
      extension.commands.push({ name, ...command });
    },
  };
}

function createMiniUi(): MiniUi {
  return {
    notifications: [],
    notify(message) {
      this.notifications.push(message);
    },
  };
}

function createContext(ui: MiniUi, systemPrompt: string): MiniExtensionContext {
  return { ui, getSystemPrompt: () => systemPrompt };
}

function cloneExtension(extension: LoadedExtension): LoadedExtension {
  return {
    path: extension.path,
    handlers: {
      before_agent_start: [...extension.handlers.before_agent_start],
      resources_discover: [...extension.handlers.resources_discover],
      tool_call: [...extension.handlers.tool_call],
    },
    tools: extension.tools.map(cloneTool),
    commands: extension.commands.map(cloneCommand),
  };
}

function cloneTool(tool: RegisteredTool): RegisteredTool {
  return { ...tool, parameters: cloneData(tool.parameters) };
}

function cloneCommand(command: MiniCommand): MiniCommand {
  return { ...command };
}

function materializeCustomMessage(message: ExtensionCustomMessage): CustomMessage {
  return {
    ...cloneData(message),
    role: "custom",
    timestamp: message.timestamp ?? Date.now(),
  };
}

function appendDiscovered(
  target: Array<{ path: string; extensionPath: string }>,
  paths: string[] | undefined,
  extensionPath: string,
): void {
  for (const path of paths ?? []) target.push({ path, extensionPath });
}

function validateMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error("maxTurns must be a positive safe integer");
  }
}

function cloneData<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing) return existing as T;
  const clone: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
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
  const cwd = process.cwd();
  const runner = await loadMiniExtensions([{
    path: "built-in-note-extension",
    factory(pi) {
      pi.registerTool({
        name: "note",
        description: "Record a short note in the tool result.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Note text" } },
          required: ["text"],
        },
        handler(input) {
          return { toolName: "note", content: `note: ${String(input.text)}` };
        },
      });
    },
  }]);
  const session = createSessionTree({ cwd });
  const source = createFileSystemResourceSource();
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  await runPromptCli("s09 Extension Runtime", async (prompt) => {
    const result = await runExtensionTurn({
      runner,
      source,
      cwd,
      agentDir,
      session,
      model: runtime.model,
      registry: createCourseToolRegistry(cwd),
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
