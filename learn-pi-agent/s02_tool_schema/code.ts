import {
  validateToolCall,
  type Api,
  type Model,
  type ProviderStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import {
  createInitialState,
  createReadFileToolRuntime,
  readAssistantText,
  readFileTool,
  runAgentLoop,
  type AgentState,
  type RunAgentLoopResult,
  type ToolRuntime,
} from "../s01_agent_loop/code.ts";

export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  [key: string]: unknown;
};

export type ToolParameters = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
};

export type ToolResult = {
  toolName: string;
  content: string;
};

export type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

export type RegisteredTool = ToolDefinition & {
  label?: string;
  handler: ToolHandler;
};

declare const toolRegistryBrand: unique symbol;

export type ToolRegistry = {
  readonly [toolRegistryBrand]: true;
};

type RegistryEntry = {
  schema: Tool;
  handler: ToolHandler;
  label?: string;
};

const registryEntries = new WeakMap<ToolRegistry, Map<string, RegistryEntry>>();

export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  return createRegistryFromEntries(tools.map(toRegistryEntry));
}

export function listToolDefinitions(registry: ToolRegistry): Tool[] {
  return Array.from(getRegistryEntries(registry).values(), ({ schema }) => cloneTool(schema));
}

export function selectToolRegistry(registry: ToolRegistry, toolNames: string[]): ToolRegistry {
  const source = getRegistryEntries(registry);
  const selected: RegistryEntry[] = [];
  const seen = new Set<string>();

  for (const name of toolNames) {
    if (seen.has(name)) throw new Error(`Duplicate tool: ${name}`);
    seen.add(name);
    const entry = source.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    selected.push(entry);
  }

  return createRegistryFromEntries(selected);
}

export function extendToolRegistry(registry: ToolRegistry, tools: RegisteredTool[]): ToolRegistry {
  const entries = [...getRegistryEntries(registry).values()];
  return createRegistryFromEntries([...entries, ...tools.map(toRegistryEntry)]);
}

export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const entry = getRegistryEntries(registry).get(name);
  if (!entry) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const toolCall: ToolCall = {
    type: "toolCall",
    id: "direct_dispatch",
    name,
    arguments: input,
  };
  const validatedInput = validateRegistryToolCall(registry, toolCall);
  return entry.handler(validatedInput);
}

export function validateRegistryToolCall(
  registry: ToolRegistry,
  toolCall: ToolCall,
): Record<string, unknown> {
  const entry = getRegistryEntries(registry).get(toolCall.name);
  if (!entry) throw new Error(`Unknown tool: ${toolCall.name}`);
  return validateToolCall([entry.schema], toolCall) as Record<string, unknown>;
}

export function createRegistryToolRuntime(registry: ToolRegistry): ToolRuntime {
  return {
    tools: listToolDefinitions(registry),
    async execute(toolCall) {
      try {
        const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
        return createToolResultMessage(toolCall, result.content, false);
      } catch (error) {
        return createToolResultMessage(
          toolCall,
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  };
}

export function createCourseToolRegistry(courseRoot: string): ToolRegistry {
  const inlineRuntime = createReadFileToolRuntime(courseRoot);
  return createToolRegistry([{
    ...readFileTool,
    parameters: readFileTool.parameters as unknown as ToolParameters,
    label: "read_file",
    async handler(input) {
      const result = await inlineRuntime.execute({
        type: "toolCall",
        id: "registry_read_file",
        name: "read_file",
        arguments: input,
      });
      const content = result.content[0];
      return {
        toolName: "read_file",
        content: content?.type === "text" ? content.text : "",
      };
    },
  }]);
}

export type RunToolRegistryAgentLoopOptions = {
  model: Model<Api>;
  prompt: string;
  registry: ToolRegistry;
  state?: AgentState;
  systemPrompt?: string;
  streamOptions?: ProviderStreamOptions;
  maxTurns?: number;
};

export function runToolRegistryAgentLoop(
  options: RunToolRegistryAgentLoopOptions,
): Promise<RunAgentLoopResult> {
  const { registry, ...agentOptions } = options;
  return runAgentLoop({
    ...agentOptions,
    toolRuntime: createRegistryToolRuntime(registry),
  });
}

function getRegistryEntries(registry: ToolRegistry): Map<string, RegistryEntry> {
  const entries = registryEntries.get(registry);
  if (!entries) {
    throw new Error("Tool registry was not created by createToolRegistry");
  }
  return entries;
}

function toPiTool(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: cloneParameters(tool.parameters) as Tool["parameters"],
  };
}

function toRegistryEntry(tool: RegisteredTool): RegistryEntry {
  return {
    schema: toPiTool(tool),
    handler: tool.handler,
    label: tool.label,
  };
}

function createRegistryFromEntries(sourceEntries: RegistryEntry[]): ToolRegistry {
  const entries = new Map<string, RegistryEntry>();
  for (const source of sourceEntries) {
    if (entries.has(source.schema.name)) {
      throw new Error(`Duplicate tool: ${source.schema.name}`);
    }
    entries.set(source.schema.name, {
      schema: cloneTool(source.schema),
      handler: source.handler,
      label: source.label,
    });
  }

  const registry = {} as ToolRegistry;
  registryEntries.set(registry, entries);
  return registry;
}

function cloneTool(tool: Tool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: cloneParameters(tool.parameters),
  };
}

function cloneParameters<T>(parameters: T): T {
  return structuredClone(parameters);
}

function createToolResultMessage(
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const state = createInitialState();
  const registry = createCourseToolRegistry(process.cwd());
  await runPromptCli("s02 Tool Registry", async (prompt) => {
    const result = await runToolRegistryAgentLoop({
      ...runtime,
      prompt,
      state,
      registry,
    });
    return readAssistantText(result.finalMessage);
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
