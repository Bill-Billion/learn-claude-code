import {
  createToolRegistry,
  dispatchTool,
  listToolDefinitions,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import {
  type AssistantMessage,
  type EventProvider,
  type ProviderEvent,
  type TextContent,
  type ToolCall,
  readTextBlocks,
} from "../s03_provider_events/code.ts";
import {
  type AgentEvent,
  createToolLoopProvider,
  type ToolResultMessage,
} from "../s04_evented_tool_loop/code.ts";

export type BeforeToolCallResult = {
  block?: boolean;
  reason?: string;
};

export type AfterToolCallResult = {
  content?: TextContent[];
  isError?: boolean;
  terminate?: boolean;
};

export type HookContext = {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  messages: LoopMessage[];
};

export type AfterHookContext = HookContext & {
  result: ToolResultMessage;
  isError: boolean;
};

export type ToolHooks = {
  beforeToolCall?: (context: HookContext) => BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;
  afterToolCall?: (context: AfterHookContext) => AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;
};

export type LoopMessage = AssistantMessage | ToolResultMessage;

export type HookedToolLoopResult = {
  messages: LoopMessage[];
  events: AgentEvent[];
  eventTypes: string[];
  toolResults: ToolResultMessage[];
  terminated: boolean;
};

export type HookedToolLoopOptions = {
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
};

export type CountingToolRegistry = ToolRegistry & {
  calls: number;
};

type FinalizedToolCall = {
  message: ToolResultMessage;
  terminate: boolean;
};

export function createCountingReadRegistry(): CountingToolRegistry {
  let calls = 0;
  const registry = createToolRegistry([
    {
      name: "read",
      label: "read",
      description: "Read a file by path. The s05 demo records that the handler ran.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to read.",
          },
        },
        required: ["path"],
      },
      handler(input) {
        calls += 1;
        return {
          toolName: "read",
          content: `read: ${String(input.path)}`,
        };
      },
    },
  ]) as CountingToolRegistry;

  Object.defineProperty(registry, "calls", {
    enumerable: true,
    get() {
      return calls;
    },
  });

  return registry;
}

export async function runHookedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  hooks: ToolHooks = {},
  options: HookedToolLoopOptions = {},
): Promise<HookedToolLoopResult> {
  const maxTurns = options.maxTurns ?? 4;
  const messages: LoopMessage[] = [];
  const events: AgentEvent[] = [];
  const allToolResults: ToolResultMessage[] = [];
  let terminated = false;

  const emit = (event: AgentEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };
  emit({ type: "agent_start" });

  for (let turn = 0; turn < maxTurns; turn++) {
    emit({ type: "turn_start" });
    const assistantMessage = await streamAssistant(provider, registry, messages, emit);
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
    const turnToolResults: ToolResultMessage[] = [];
    // Pi only stops early when EVERY finalized tool result in the batch sets
    // terminate; mixed batches continue normally.
    let shouldTerminateTurn = toolCalls.length > 0;

    for (const toolCall of toolCalls) {
      const finalized = await executeToolCallWithHooks(registry, assistantMessage, toolCall, messages, hooks, emit);
      messages.push(finalized.message);
      turnToolResults.push(finalized.message);
      allToolResults.push(finalized.message);
      shouldTerminateTurn = shouldTerminateTurn && finalized.terminate;
    }

    emit({ type: "turn_end", message: assistantMessage, toolResults: turnToolResults });

    if (toolCalls.length === 0) {
      break;
    }
    if (shouldTerminateTurn) {
      terminated = true;
      break;
    }
  }

  emit({ type: "agent_end", messages });

  return {
    messages,
    events,
    eventTypes: events.map((event) => event.type),
    toolResults: allToolResults,
    terminated,
  };
}

async function streamAssistant(
  provider: EventProvider,
  registry: ToolRegistry,
  messages: LoopMessage[],
  emit: (event: AgentEvent) => void,
): Promise<AssistantMessage> {
  let finalMessage: AssistantMessage | undefined;
  let started = false;

  for await (const event of provider.stream({
    messages,
    tools: listToolDefinitions(registry),
  })) {
    if (event.type === "start") {
      started = true;
      emit({ type: "message_start", message: cloneAssistantMessage(event.partial) });
      continue;
    }

    if (isAssistantUpdate(event)) {
      emit({
        type: "message_update",
        message: cloneAssistantMessage(event.partial),
        providerEvent: event,
      });
      continue;
    }

    if (event.type === "done") {
      finalMessage = event.message;
      if (!started) {
        emit({ type: "message_start", message: cloneAssistantMessage(finalMessage) });
      }
      emit({ type: "message_end", message: finalMessage });
      continue;
    }

    if (event.type === "error") {
      finalMessage = event.error;
      if (!started) {
        emit({ type: "message_start", message: cloneAssistantMessage(finalMessage) });
      }
      emit({ type: "message_end", message: finalMessage });
    }
  }

  if (!finalMessage) {
    throw new Error("Provider stream ended without a final assistant message");
  }

  return finalMessage;
}

function isAssistantUpdate(event: ProviderEvent): event is Extract<
  ProviderEvent,
  { type: "text_start" | "text_delta" | "text_end" | "toolcall_start" | "toolcall_delta" | "toolcall_end" }
> {
  return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

async function executeToolCallWithHooks(
  registry: ToolRegistry,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  messages: LoopMessage[],
  hooks: ToolHooks,
  emit: (event: AgentEvent) => void,
): Promise<FinalizedToolCall> {
  emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });

  const hookContext: HookContext = {
    assistantMessage,
    toolCall,
    args: toolCall.arguments,
    messages,
  };

  const beforeResult = await hooks.beforeToolCall?.(hookContext);
  let message: ToolResultMessage;
  let terminate = false;

  if (beforeResult?.block) {
    message = createToolResultMessage(toolCall, beforeResult.reason || "Tool execution was blocked", true);
  } else {
    message = await runLocalTool(registry, toolCall);
    const afterResult = await hooks.afterToolCall?.({
      ...hookContext,
      result: message,
      isError: message.isError,
    });

    if (afterResult) {
      message = {
        ...message,
        content: afterResult.content ?? message.content,
        isError: afterResult.isError ?? message.isError,
      };
      terminate = afterResult.terminate ?? false;
    }
  }

  emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: message,
    isError: message.isError,
  });
  emit({ type: "message_start", message });
  emit({ type: "message_end", message });

  return { message, terminate };
}

async function runLocalTool(registry: ToolRegistry, toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
    return createToolResultMessage(toolCall, result.content, false);
  } catch (error) {
    return createToolResultMessage(toolCall, error instanceof Error ? error.message : String(error), true);
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

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "toolCall") {
        return { ...block, arguments: { ...block.arguments } };
      }
      return { ...block };
    }),
  };
}

export function readTextBlocksFromLastAssistant(messages: LoopMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return readTextBlocks(message);
    }
  }
  return [];
}

export async function runDemo(): Promise<void> {
  const blocked = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "secret.txt" },
      finalText: "I saw the block.",
    }),
    createCountingReadRegistry(),
    {
      beforeToolCall() {
        return { block: true, reason: "read is disabled in this lesson" };
      },
    },
  );

  console.log(`Blocked result: ${blocked.toolResults[0]?.content[0]?.text}`);

  const patched = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "I saw the patched result.",
    }),
    createCountingReadRegistry(),
    {
      afterToolCall({ result }) {
        return {
          content: [{ type: "text", text: `audited: ${result.content[0]?.text}` }],
        };
      },
    },
  );

  console.log(`Patched result: ${patched.toolResults[0]?.content[0]?.text}`);

  const terminated = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "this should not be emitted",
    }),
    createCountingReadRegistry(),
    {
      afterToolCall() {
        return { terminate: true };
      },
    },
  );

  console.log(`Terminated: ${terminated.terminated}`);
  console.log(`Messages: ${terminated.messages.map((message) => message.role).join(" -> ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
