import { createDemoToolRegistry, createToolRegistry, type ToolRegistry } from "../s02_tool_schema/code.ts";
import {
  createTextProvider,
  readTextBlocks,
  type AssistantMessage,
  type EventProvider,
  type ProviderContext,
} from "../s03_provider_events/code.ts";
import type { ToolResultMessage } from "../s04_evented_tool_loop/code.ts";
import {
  readTextBlocksFromLastAssistant,
  runHookedToolLoop,
  type LoopMessage,
} from "../s05_tool_hooks/code.ts";
import type { MiniMessage, MiniModel, MiniSession } from "../s06_turn_state/code.ts";
import {
  createSessionTree,
  type SessionMessage,
  type SessionTree,
} from "../s07_session_tree/code.ts";
import {
  createExtensionTurnState,
  loadMiniExtensions,
  type MiniExtensionFactory,
  type MiniExtensionSource,
  type MiniExtensionRunner,
} from "../s09_extension_runtime/code.ts";
import type {
  MiniRunResult,
  MiniRuntime,
  MiniRuntimeEvent,
  MiniRuntimeMessage,
  MiniRuntimeState,
} from "../s10_runtime_modes/code.ts";
import {
  MiniTrustStore,
  loadProjectInputs,
  resolveProjectTrusted,
  type AppMode,
  type DefaultProjectTrust,
  type LoadedProjectInputs,
  type ProjectTrustExtensionDecision,
} from "../s11_trust_execution_env/code.ts";
import {
  discoverExtensionEntries,
  getEnabledPaths,
  resolvePiPackages,
  type PackageEntry,
  type ResolvedPackageResources,
} from "../s12_pi_package/code.ts";

const STORED_LOOP_MESSAGE_PREFIX = "mini-pi-loop-message:";

export type IntegratedTrustOptions = {
  mode?: AppMode;
  trustOverride?: boolean;
  defaultProjectTrust?: DefaultProjectTrust;
  promptDecision?: boolean;
  extensionDecision?: ProjectTrustExtensionDecision;
};

export type IntegratedHarnessOptions = {
  files: Record<string, string>;
  cwd: string;
  agentDir: string;
  provider: EventProvider;
  baseRegistry: ToolRegistry;
  model?: MiniModel;
  sessionTree?: SessionTree;
  userPackages?: PackageEntry[];
  projectPackages?: PackageEntry[];
  userExtensionPaths?: string[];
  extensionFactories?: Readonly<Record<string, MiniExtensionFactory>>;
  trustStore?: MiniTrustStore;
  trust?: IntegratedTrustOptions;
  maxTurns?: number;
};

type InitializedHarness = {
  projectInputs: LoadedProjectInputs;
  packageResources: ResolvedPackageResources;
  runner: MiniExtensionRunner;
};

export class IntegratedHarnessRuntime implements MiniRuntime {
  private readonly options: IntegratedHarnessOptions;
  private readonly initialized: InitializedHarness;
  private readonly sessionTree: SessionTree;
  private promptQueue: Promise<void> = Promise.resolve();
  private turns = 0;
  private lastAssistantText: string | undefined;

  constructor(options: IntegratedHarnessOptions, initialized: InitializedHarness) {
    this.options = options;
    this.initialized = initialized;
    this.sessionTree = options.sessionTree ?? createSessionTree({ cwd: options.cwd, id: "integrated-session" });
  }

  prompt(prompt: string): Promise<MiniRunResult> {
    const result = this.promptQueue.then(() => this.runPrompt(prompt));
    this.promptQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runPrompt(prompt: string): Promise<MiniRunResult> {
    const sessionId = this.sessionTree.getMetadata().id;
    const runId = `${sessionId}:${this.turns + 1}`;
    this.sessionTree.appendMessage({ role: "user", content: prompt });

    const session = createMiniSessionAdapter(this.sessionTree);
    const turnState = await createExtensionTurnState({
      runner: this.initialized.runner,
      files: this.options.files,
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      session,
      model: this.options.model ?? { provider: "demo", id: "integrated-model" },
      registry: this.options.baseRegistry,
      skillFiles: getEnabledPaths(this.initialized.packageResources.skills),
      promptTemplateFiles: dedupePaths([
        ...this.initialized.projectInputs.promptPaths,
        ...getEnabledPaths(this.initialized.packageResources.prompts),
      ]),
      prompt,
    });
    const registry = createToolRegistry(turnState.activeTools);
    const provider = createTurnProvider(this.options.provider, turnState.messages, turnState.beforeAgentStartMessages, turnState.systemPrompt);
    const loopResult = await runHookedToolLoop(
      provider,
      registry,
      {
        beforeToolCall: ({ toolCall, args }) => {
          return this.initialized.runner.emitToolCall({ toolName: toolCall.name, input: args });
        },
      },
      {
        maxTurns: this.options.maxTurns,
        onEvent: (event) => {
          if (event.type === "message_end") {
            this.sessionTree.appendMessage(encodeLoopMessage(event.message));
          }
        },
      },
    );

    const finalText = readTextBlocksFromLastAssistant(loopResult.messages).join("");
    this.turns += 1;
    this.lastAssistantText = finalText;
    const events = createRuntimeEvents(sessionId, runId, prompt, finalText);

    return {
      sessionId,
      runId,
      finalText,
      events: events.map((event) => ({ ...event })),
      messages: toRuntimeMessages(this.sessionTree.buildContext().messages),
    };
  }

  getState(): MiniRuntimeState {
    return {
      sessionId: this.sessionTree.getMetadata().id,
      turns: this.turns,
      messageCount: this.sessionTree.buildContext().messages.length,
      ...(this.lastAssistantText === undefined ? {} : { lastAssistantText: this.lastAssistantText }),
    };
  }
}

export async function createIntegratedHarnessRuntime(
  options: IntegratedHarnessOptions,
): Promise<IntegratedHarnessRuntime> {
  const trust = options.trust ?? {};
  const projectTrusted = await resolveProjectTrusted({
    files: options.files,
    cwd: options.cwd,
    mode: trust.mode ?? "print",
    trustStore: options.trustStore ?? new MiniTrustStore(),
    trustOverride: trust.trustOverride,
    defaultProjectTrust: trust.defaultProjectTrust,
    promptDecision: trust.promptDecision,
    extensionDecision: trust.extensionDecision,
  });
  const projectInputs = loadProjectInputs(options.files, options.cwd, projectTrusted);
  const directProjectEntries = new Set(
    projectTrusted ? discoverExtensionEntries(options.files, `${options.cwd}/.pi/extensions`) : [],
  );
  const packageResources = resolvePiPackages({
    files: options.files,
    userPackages: options.userPackages ?? [],
    projectPackages: options.projectPackages ?? [],
    projectTrusted,
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const extensionPaths = dedupePaths([
    ...(options.userExtensionPaths ?? []),
    ...projectInputs.extensionPaths.filter((path) => directProjectEntries.has(path)),
    ...getEnabledPaths(packageResources.extensions),
  ]);
  const sources = toExtensionSources(extensionPaths, options.extensionFactories ?? {});
  const runner = await loadMiniExtensions(sources);

  return new IntegratedHarnessRuntime(options, { projectInputs, packageResources, runner });
}

function toExtensionSources(
  paths: string[],
  factories: Readonly<Record<string, MiniExtensionFactory>>,
): MiniExtensionSource[] {
  return paths.map((path) => {
    const factory = factories[path];
    if (!factory) {
      throw new Error(`Missing extension factory: ${path}`);
    }
    return { path, factory };
  });
}

function createMiniSessionAdapter(sessionTree: SessionTree): MiniSession {
  const messages = sessionTree.buildContext().messages.map(toMiniMessage);
  return {
    messages: messages.map((message) => ({ ...message })),
    async buildContext() {
      return { messages: messages.map((message) => ({ ...message })) };
    },
    async getMetadata() {
      return { id: sessionTree.getMetadata().id };
    },
  };
}

function toMiniMessage(message: SessionMessage): MiniMessage {
  return { role: message.role, content: message.content };
}

function createTurnProvider(
  provider: EventProvider,
  sessionMessages: MiniMessage[],
  customMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }>,
  systemPrompt: string,
): EventProvider {
  const sessionPrefix = sessionMessages.map(decodeSessionMessage);
  const extensionMessages = customMessages.map((message) => ({ role: "custom", ...message }));

  return {
    stream(context: ProviderContext) {
      return provider.stream({
        ...context,
        messages: [...sessionPrefix, ...extensionMessages, ...context.messages],
        systemPrompt,
      });
    },
  };
}

function encodeLoopMessage(message: LoopMessage): SessionMessage {
  return {
    role: message.role,
    content: `${STORED_LOOP_MESSAGE_PREFIX}${JSON.stringify(message)}`,
  };
}

function decodeSessionMessage(message: MiniMessage): unknown {
  if (message.role === "user" || !message.content.startsWith(STORED_LOOP_MESSAGE_PREFIX)) {
    return { ...message };
  }

  try {
    return JSON.parse(message.content.slice(STORED_LOOP_MESSAGE_PREFIX.length)) as AssistantMessage | ToolResultMessage;
  } catch {
    return { ...message };
  }
}

function toRuntimeMessages(messages: SessionMessage[]): MiniRuntimeMessage[] {
  const result: MiniRuntimeMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role !== "assistant") continue;

    const decoded = decodeSessionMessage(message as MiniMessage);
    if (isAssistantMessage(decoded)) {
      const text = readTextBlocks(decoded).join("");
      if (text) result.push({ role: "assistant", content: text });
      continue;
    }
    result.push({ role: "assistant", content: message.content });
  }

  return result;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

function createRuntimeEvents(sessionId: string, runId: string, prompt: string, finalText: string): MiniRuntimeEvent[] {
  return [
    { type: "session", sessionId, runId },
    { type: "agent_start", sessionId, runId, prompt },
    { type: "message", sessionId, runId, role: "assistant", content: finalText },
    { type: "agent_end", sessionId, runId, finalText },
  ];
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

async function demo(): Promise<void> {
  const runtime = await createIntegratedHarnessRuntime({
    files: { "/demo/AGENTS.md": "Keep the integrated demo deterministic." },
    cwd: "/demo",
    agentDir: "/home/demo/.pi/agent",
    provider: createTextProvider(["Integrated harness ready."]),
    baseRegistry: createDemoToolRegistry(),
    sessionTree: createSessionTree({ id: "s13-demo", cwd: "/demo" }),
  });
  const result = await runtime.prompt("Show the composed runtime.");

  console.log(`Session: ${result.sessionId}`);
  console.log(`Final text: ${result.finalText}`);
  console.log(`Events: ${result.events.map((event) => event.type).join(" -> ")}`);
  console.log(`Stored messages: ${runtime.getState().messageCount}`);
}

if (process.argv.includes("--s13-demo")) {
  await demo();
}
