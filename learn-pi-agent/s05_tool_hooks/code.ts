import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import { createInitialState, type AgentState } from "../s01_agent_loop/code.ts";
import {
  createCourseToolRegistry,
  validateRegistryToolCall,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import { readTextBlocks } from "../s03_provider_events/code.ts";
import {
  runEventedToolLoop,
  type AgentEvent,
  type RunEventedToolLoopResult,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
} from "../s04_evented_tool_loop/code.ts";

export type BeforeToolCallResult = {
  block?: boolean;
  reason?: string;
  arguments?: Record<string, unknown>;
};

export type AfterToolCallResult = {
  content?: ToolResultMessage["content"];
  isError?: boolean;
  terminate?: boolean;
};

export type HookContext = {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  messages: Message[];
};

export type AfterHookContext = HookContext & {
  result: ToolResultMessage;
  isError: boolean;
};

export type ToolHooks = {
  beforeToolCall?: (
    context: HookContext,
  ) => BeforeToolCallResult | Promise<BeforeToolCallResult | void> | void;
  afterToolCall?: (
    context: AfterHookContext,
  ) => AfterToolCallResult | Promise<AfterToolCallResult | void> | void;
};

export type RunHookedToolLoopOptions = {
  model: Model<Api>;
  prompt: string;
  registry: ToolRegistry;
  hooks?: ToolHooks;
  state?: AgentState;
  userMessage?: UserMessage;
  systemPrompt?: string;
  streamOptions?: ProviderStreamOptions;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
};

export type HookedToolLoopResult = RunEventedToolLoopResult & {
  messages: Message[];
};

export async function runHookedToolLoop(
  options: RunHookedToolLoopOptions,
): Promise<HookedToolLoopResult> {
  const { hooks = {}, ...eventedOptions } = options;
  const result = await runEventedToolLoop({
    ...eventedOptions,
    executeToolCall: createHookExecutor(options.registry, hooks),
  });
  return { ...result, messages: result.state.messages };
}

function createHookExecutor(registry: ToolRegistry, hooks: ToolHooks) {
  return async (context: ToolExecutionContext): Promise<ToolExecutionOutcome> => {
    let validatedArgs: Record<string, unknown>;
    try {
      validatedArgs = validateRegistryToolCall(registry, context.toolCall);
    } catch (error) {
      return { message: createErrorToolResult(context.toolCall, error) };
    }

    let before: BeforeToolCallResult | void;
    try {
      before = await hooks.beforeToolCall?.({
        assistantMessage: context.assistantMessage,
        toolCall: context.toolCall,
        args: validatedArgs,
        messages: context.messages,
      });
    } catch (error) {
      return {
        message: createErrorToolResult(
          context.toolCall,
          `Pre-tool hook failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }

    if (before?.block) {
      return {
        message: createToolResultMessage(
          context.toolCall,
          before.reason || "Tool execution was blocked",
          true,
        ),
      };
    }

    let effectiveArgs = validatedArgs;
    if (before?.arguments) {
      try {
        effectiveArgs = validateRegistryToolCall(registry, {
          ...context.toolCall,
          arguments: before.arguments,
        });
      } catch (error) {
        return { message: createErrorToolResult(context.toolCall, error) };
      }
    }
    const effectiveToolCall: ToolCall = { ...context.toolCall, arguments: effectiveArgs };

    const message = await context.executeDefault(effectiveToolCall);
    return applyAfterToolCallHook(hooks, {
      assistantMessage: context.assistantMessage,
      toolCall: effectiveToolCall,
      args: effectiveToolCall.arguments,
      messages: context.messages,
    }, message);
  };
}

async function applyAfterToolCallHook(
  hooks: ToolHooks,
  context: HookContext,
  message: ToolResultMessage,
): Promise<ToolExecutionOutcome> {
  try {
    const after = await hooks.afterToolCall?.({
      ...context,
      result: message,
      isError: message.isError,
    });
    return {
      message: after
        ? {
            ...message,
            content: after.content ?? message.content,
            isError: after.isError ?? message.isError,
          }
        : message,
      terminate: after?.terminate,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      message: {
        ...message,
        content: [
          ...message.content,
          { type: "text", text: `Post-tool hook failed after the tool executed: ${detail}` },
        ],
        isError: true,
      },
    };
  }
}

function createErrorToolResult(toolCall: ToolCall, error: unknown): ToolResultMessage {
  return createToolResultMessage(
    toolCall,
    error instanceof Error ? error.message : String(error),
    true,
  );
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

export function readTextBlocksFromLastAssistant(messages: Message[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return readTextBlocks(message);
  }
  return [];
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const state = createInitialState();
  const registry = createCourseToolRegistry(process.cwd());
  await runPromptCli("s05 Tool Hooks", async (prompt) => {
    const result = await runHookedToolLoop({ ...runtime, prompt, state, registry });
    return readTextBlocks(result.finalMessage).join("");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
