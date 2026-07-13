import { createDemoToolRegistry, type RegisteredTool, type ToolRegistry } from "../s02_tool_schema/code.ts";

export type MiniMessage = {
  role: "user" | "assistant" | "toolResult";
  content: string;
};

export type MiniModel = {
  provider: string;
  id: string;
};

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

export type MiniStreamOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
};

export type MiniSession = {
  messages: MiniMessage[];
  buildContext(): Promise<{ messages: MiniMessage[] }>;
  getMetadata(): Promise<{ id: string }>;
};

export type MiniSystemPrompt =
  | string
  | ((context: {
      session: MiniSession;
      model: MiniModel;
      activeTools: RegisteredTool[];
      resources: MiniResources;
    }) => string | Promise<string>);

export type MiniHarnessOptions = {
  session: MiniSession;
  model: MiniModel;
  registry: ToolRegistry;
  activeToolNames?: string[];
  resources?: MiniResources;
  systemPrompt?: MiniSystemPrompt;
  streamOptions?: MiniStreamOptions;
};

export type TurnState = {
  messages: MiniMessage[];
  resources: MiniResources;
  streamOptions: MiniStreamOptions;
  sessionId: string;
  systemPrompt: string;
  model: MiniModel;
  tools: RegisteredTool[];
  activeTools: RegisteredTool[];
};

export type MiniHarness = {
  createTurnState(): Promise<TurnState>;
};

export function createDemoSession(id: string, initialMessages: MiniMessage[] = []): MiniSession {
  return {
    messages: initialMessages.map(cloneMessage),
    async buildContext() {
      return {
        messages: this.messages.map(cloneMessage),
      };
    },
    async getMetadata() {
      return { id };
    },
  };
}

export function createMiniHarness(options: MiniHarnessOptions): MiniHarness {
  const tools = options.registry.tools.map((tool) => ({ ...tool }));
  const activeToolNames = options.activeToolNames ? [...options.activeToolNames] : tools.map((tool) => tool.name);
  validateActiveToolNames(tools, activeToolNames);

  const resources = cloneResources(options.resources ?? {});
  const streamOptions = cloneStreamOptions(options.streamOptions);
  const systemPrompt = options.systemPrompt ?? "You are a helpful assistant.";

  return {
    async createTurnState() {
      const context = await options.session.buildContext();
      const metadata = await options.session.getMetadata();
      const activeTools = activeToolNames.map((name) => tools.find((tool) => tool.name === name)!);
      const turnResources = cloneResources(resources);
      const resolvedSystemPrompt =
        typeof systemPrompt === "string"
          ? systemPrompt
          : await systemPrompt({
              session: options.session,
              model: options.model,
              activeTools,
              resources: turnResources,
            });

      return {
        messages: context.messages.map(cloneMessage),
        resources: turnResources,
        streamOptions: cloneStreamOptions(streamOptions),
        sessionId: metadata.id,
        systemPrompt: resolvedSystemPrompt,
        model: { ...options.model },
        tools: tools.map((tool) => ({ ...tool })),
        activeTools: activeTools.map((tool) => ({ ...tool })),
      };
    },
  };
}

function validateActiveToolNames(tools: RegisteredTool[], activeToolNames: string[]): void {
  const known = new Set(tools.map((tool) => tool.name));
  const seen = new Set<string>();

  for (const name of activeToolNames) {
    if (!known.has(name)) {
      throw new Error(`Unknown active tool: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate active tool: ${name}`);
    }
    seen.add(name);
  }
}

function cloneMessage(message: MiniMessage): MiniMessage {
  return { ...message };
}

function cloneResources(resources: MiniResources): MiniResources {
  return {
    skills: resources.skills?.map((skill) => ({ ...skill })),
    promptTemplates: resources.promptTemplates?.map((template) => ({ ...template })),
  };
}

function cloneStreamOptions(streamOptions: MiniStreamOptions = {}): MiniStreamOptions {
  return {
    ...streamOptions,
    headers: streamOptions.headers ? { ...streamOptions.headers } : undefined,
    metadata: streamOptions.metadata ? { ...streamOptions.metadata } : undefined,
  };
}

export function listActiveToolNames(tools: RegisteredTool[]): string {
  return tools.map((tool) => tool.name).join(",");
}

export async function runDemo(): Promise<void> {
  const session = createDemoSession("demo-session", [{ role: "user", content: "hello" }]);
  const harness = createMiniHarness({
    session,
    model: { provider: "demo", id: "demo-model" },
    registry: createDemoToolRegistry(),
    activeToolNames: ["read"],
    resources: {
      skills: [{ name: "audit", description: "Review tool output." }],
      promptTemplates: [{ name: "fix", content: "Fix {target}" }],
    },
    streamOptions: {
      timeoutMs: 30,
      headers: { "x-demo": "one" },
    },
    systemPrompt({ activeTools, resources }) {
      return `tools=${listActiveToolNames(activeTools)} skills=${resources.skills?.map((skill) => skill.name).join(",")}`;
    },
  });

  const turnState = await harness.createTurnState();
  console.log(`Session: ${turnState.sessionId}`);
  console.log(`Messages: ${turnState.messages.length}`);
  console.log(`Active tools: ${listActiveToolNames(turnState.activeTools)}`);
  console.log(`System prompt: ${turnState.systemPrompt}`);
  console.log(`Timeout: ${turnState.streamOptions.timeoutMs}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
