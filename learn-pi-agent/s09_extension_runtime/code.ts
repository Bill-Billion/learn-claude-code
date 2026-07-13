import {
  createDemoToolRegistry,
  createToolRegistry,
  type RegisteredTool,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import { createDemoSession, type MiniModel } from "../s06_turn_state/code.ts";
import {
  createContextResourceTurnState,
  type ContextResourceTurnState,
  type CreateContextResourceTurnStateOptions,
} from "../s08_context_resources/code.ts";

export type MiniCustomMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
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
  message?: MiniCustomMessage;
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

export type MiniExtensionAPI = {
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: MiniExtensionContext) => BeforeAgentStartResult | Promise<BeforeAgentStartResult | void> | void): void;
  on(event: "resources_discover", handler: (event: ResourcesDiscoverEvent, ctx: MiniExtensionContext) => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult | void> | void): void;
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: MiniExtensionContext) => ToolCallResult | Promise<ToolCallResult | void> | void): void;
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

export type ExtensionTurnState = ContextResourceTurnState & {
  beforeAgentStartMessages: MiniCustomMessage[];
};

type HandlerMap = {
  before_agent_start: Array<(event: BeforeAgentStartEvent, ctx: MiniExtensionContext) => BeforeAgentStartResult | Promise<BeforeAgentStartResult | void> | void>;
  resources_discover: Array<(event: ResourcesDiscoverEvent, ctx: MiniExtensionContext) => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult | void> | void>;
  tool_call: Array<(event: ToolCallEvent, ctx: MiniExtensionContext) => ToolCallResult | Promise<ToolCallResult | void> | void>;
};

type LoadedExtension = {
  path: string;
  handlers: HandlerMap;
  tools: RegisteredTool[];
  commands: MiniCommand[];
};

export async function loadMiniExtensions(sources: MiniExtensionSource[]): Promise<MiniExtensionRunner> {
  const extensions: LoadedExtension[] = [];

  for (const source of sources) {
    const extension: LoadedExtension = {
      path: source.path,
      handlers: {
        before_agent_start: [],
        resources_discover: [],
        tool_call: [],
      },
      tools: [],
      commands: [],
    };

    await source.factory(createExtensionApi(extension));
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
    return this.extensions.flatMap((extension) => extension.commands.map((command) => ({ ...command })));
  }

  async runCommand(name: string, args = ""): Promise<CommandRunResult> {
    const command = this.getCommands().find((candidate) => candidate.name === name);
    if (!command) {
      throw new Error(`Unknown command: ${name}`);
    }

    const ui = createMiniUi();
    await command.handler(args, createContext(ui, ""));
    return { notifications: [...ui.notifications] };
  }

  async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<{
    systemPrompt: string;
    messages: MiniCustomMessage[];
  }> {
    let currentSystemPrompt = event.systemPrompt;
    const messages: MiniCustomMessage[] = [];

    for (const extension of this.extensions) {
      for (const handler of extension.handlers.before_agent_start) {
        const ui = createMiniUi();
        const result = await handler(
          { ...event, systemPrompt: currentSystemPrompt },
          createContext(ui, currentSystemPrompt),
        );

        if (result?.message) {
          messages.push({ ...result.message });
        }
        if (result?.systemPrompt !== undefined) {
          currentSystemPrompt = result.systemPrompt;
        }
      }
    }

    return {
      systemPrompt: currentSystemPrompt,
      messages,
    };
  }

  async emitResourcesDiscover(cwd: string, reason: ResourcesDiscoverEvent["reason"]): Promise<DiscoveredResourcePaths> {
    const discovered: DiscoveredResourcePaths = {
      skillPaths: [],
      promptPaths: [],
      themePaths: [],
    };

    for (const extension of this.extensions) {
      for (const handler of extension.handlers.resources_discover) {
        const result = await handler({ cwd, reason }, createContext(createMiniUi(), ""));
        for (const path of result?.skillPaths ?? []) {
          discovered.skillPaths.push({ path, extensionPath: extension.path });
        }
        for (const path of result?.promptPaths ?? []) {
          discovered.promptPaths.push({ path, extensionPath: extension.path });
        }
        for (const path of result?.themePaths ?? []) {
          discovered.themePaths.push({ path, extensionPath: extension.path });
        }
      }
    }

    return discovered;
  }

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
    for (const extension of this.extensions) {
      for (const handler of extension.handlers.tool_call) {
        const result = await handler(event, createContext(createMiniUi(), ""));
        if (result?.block) {
          return { block: true, reason: result.reason };
        }
      }
    }

    return undefined;
  }
}

export function mergeExtensionTools(baseRegistry: ToolRegistry, runner: MiniExtensionRunner): ToolRegistry {
  return createToolRegistry([...baseRegistry.tools.map(cloneTool), ...runner.getTools()]);
}

export async function createExtensionTurnState(
  options: Omit<CreateContextResourceTurnStateOptions, "registry"> & {
    runner: MiniExtensionRunner;
    registry: ToolRegistry;
    prompt?: string;
  },
): Promise<ExtensionTurnState> {
  const discovered = await options.runner.emitResourcesDiscover(options.cwd, "startup");
  const registry = mergeExtensionTools(options.registry, options.runner);
  const turnState = await createContextResourceTurnState({
    ...options,
    registry,
    skillFiles: [...(options.skillFiles ?? []), ...discovered.skillPaths.map((entry) => entry.path)],
    promptTemplateFiles: [...(options.promptTemplateFiles ?? []), ...discovered.promptPaths.map((entry) => entry.path)],
  });
  const beforeAgentStart = await options.runner.emitBeforeAgentStart({
    prompt: options.prompt ?? "",
    systemPrompt: turnState.systemPrompt,
    systemPromptOptions: { cwd: options.cwd },
  });

  return {
    ...turnState,
    systemPrompt: beforeAgentStart.systemPrompt,
    beforeAgentStartMessages: beforeAgentStart.messages,
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
    notify(message: string) {
      this.notifications.push(message);
    },
  };
}

function createContext(ui: MiniUi, systemPrompt: string): MiniExtensionContext {
  return {
    ui,
    getSystemPrompt() {
      return systemPrompt;
    },
  };
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
    commands: extension.commands.map((command) => ({ ...command })),
  };
}

function cloneTool(tool: RegisteredTool): RegisteredTool {
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...tool.parameters.properties },
      required: tool.parameters.required ? [...tool.parameters.required] : undefined,
    },
  };
}

export async function runDemo(): Promise<void> {
  const runner = await loadMiniExtensions([
    {
      path: "review-helper.ts",
      factory(pi) {
        pi.registerTool({
          name: "note",
          label: "note",
          description: "Write a short note.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
          handler(input) {
            return { toolName: "note", content: `note: ${String(input.text)}` };
          },
        });

        pi.registerCommand("hello", {
          description: "Show a greeting.",
          handler(args, ctx) {
            ctx.ui.notify(`hello ${args || "world"}`);
          },
        });

        pi.on("before_agent_start", (event) => {
          return { systemPrompt: `${event.systemPrompt}\nExtension note: keep answers short.` };
        });

        pi.on("tool_call", (event) => {
          if (event.toolName === "bash" && String(event.input.command).includes("rm -rf")) {
            return { block: true, reason: "Dangerous shell command" };
          }
        });
      },
    },
  ]);

  const turnState = await createExtensionTurnState({
    runner,
    files: {
      "/work/pi/AGENTS.md": "Project rule: verify before reporting.",
    },
    cwd: "/work/pi",
    agentDir: "/home/me/.pi/agent",
    session: createDemoSession("demo-session", [{ role: "user", content: "Use extension tools." }]),
    model: { provider: "demo", id: "demo-model" } satisfies MiniModel,
    registry: createDemoToolRegistry(),
  });
  const commandResult = await runner.runCommand("hello", "Pi");
  const blocked = await runner.emitToolCall({ toolName: "bash", input: { command: "rm -rf tmp" } });

  console.log(`Tools: ${turnState.activeTools.map((tool) => tool.name).join(", ")}`);
  console.log(`Command notification: ${commandResult.notifications.join(", ")}`);
  console.log(`System prompt has extension note: ${turnState.systemPrompt.includes("Extension note")}`);
  console.log(`Blocked bash: ${blocked?.reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
