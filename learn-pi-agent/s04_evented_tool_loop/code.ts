import {
  dispatchTool,
  createDemoToolRegistry,
  listToolDefinitions,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import {
  type AssistantMessage,
  type EventProvider,
  type ProviderContext,
  type ProviderEvent,
  type TextContent,
  type ToolCall,
  createTextProvider,
  createToolCallProvider,
  readTextBlocks,
} from "../s03_provider_events/code.ts";

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
};

export type LoopMessage = AssistantMessage | ToolResultMessage;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: LoopMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: LoopMessage }
  | { type: "message_update"; message: AssistantMessage; providerEvent: ProviderEvent }
  | { type: "message_end"; message: LoopMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage; isError: boolean };

export type RunEventedToolLoopResult = {
  messages: LoopMessage[];
  events: AgentEvent[];
  eventTypes: string[];
  toolResults: ToolResultMessage[];
};

export type ToolLoopProviderOptions = {
  toolName: string;
  args: Record<string, unknown>;
  finalText: string;
  allowUnknownTool?: boolean;
};

export function createToolLoopProvider(options: ToolLoopProviderOptions): EventProvider {
  return {
    stream(context: ProviderContext) {
      const hasToolResult = context.messages.some((message) => {
        return typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult";
      });

      if (hasToolResult) {
        return createTextProvider([options.finalText]).stream(context);
      }

      if (options.allowUnknownTool) {
        return streamUnknownToolCall(options.toolName, options.args);
      }

      return createToolCallProvider(options.toolName, options.args).stream(context);
    },
  };
}

export type ToolCallSpec = {
  toolName: string;
  args: Record<string, unknown>;
};

export function createMultiToolCallProvider(calls: ToolCallSpec[], finalText: string): EventProvider {
  return {
    stream(context: ProviderContext) {
      const hasToolResult = context.messages.some((message) => {
        return typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult";
      });

      if (hasToolResult) {
        return createTextProvider([finalText]).stream(context);
      }

      return streamToolCallBatch(calls);
    },
  };
}

async function* streamToolCallBatch(calls: ToolCallSpec[]): AsyncIterable<ProviderEvent> {
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.map((call, index) => ({
      type: "toolCall",
      id: `call_${index + 1}`,
      name: call.toolName,
      arguments: {},
    })),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };

  yield { type: "start", partial: cloneAssistantMessage(message) };

  for (let index = 0; index < calls.length; index++) {
    yield { type: "toolcall_start", contentIndex: index, partial: cloneAssistantMessage(message) };

    const block = message.content[index] as ToolCall;
    block.arguments = { ...calls[index]!.args };
    yield {
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(calls[index]!.args),
      partial: cloneAssistantMessage(message),
    };
    yield {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: cloneToolCall(block),
      partial: cloneAssistantMessage(message),
    };
  }

  yield { type: "done", reason: "toolUse", message: cloneAssistantMessage(message) };
}

async function* streamUnknownToolCall(name: string, args: Record<string, unknown>): AsyncIterable<ProviderEvent> {
  const now = Date.now();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name, arguments: {} }],
    stopReason: "toolUse",
    timestamp: now,
  };

  yield { type: "start", partial: cloneAssistantMessage(message) };
  yield { type: "toolcall_start", contentIndex: 0, partial: cloneAssistantMessage(message) };

  const block = message.content[0] as ToolCall;
  block.arguments = { ...args };
  yield {
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(args),
    partial: cloneAssistantMessage(message),
  };
  yield {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: cloneToolCall(block),
    partial: cloneAssistantMessage(message),
  };
  yield { type: "done", reason: "toolUse", message: cloneAssistantMessage(message) };
}

export async function runEventedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  options: { maxTurns?: number } = {},
): Promise<RunEventedToolLoopResult> {
  const maxTurns = options.maxTurns ?? 4;
  const messages: LoopMessage[] = [];
  const events: AgentEvent[] = [];
  const allToolResults: ToolResultMessage[] = [];

  const emit = (event: AgentEvent) => events.push(event);
  emit({ type: "agent_start" });

  for (let turn = 0; turn < maxTurns; turn++) {
    emit({ type: "turn_start" });
    const assistantMessage = await streamAssistant(provider, registry, messages, emit);
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
    const turnToolResults: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
      const result = await executeToolCall(registry, toolCall, emit);
      messages.push(result);
      turnToolResults.push(result);
      allToolResults.push(result);
    }

    emit({ type: "turn_end", message: assistantMessage, toolResults: turnToolResults });

    if (toolCalls.length === 0) {
      break;
    }
  }

  emit({ type: "agent_end", messages });

  return {
    messages,
    events,
    eventTypes: events.map((event) => event.type),
    toolResults: allToolResults,
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

async function executeToolCall(
  registry: ToolRegistry,
  toolCall: ToolCall,
  emit: (event: AgentEvent) => void,
): Promise<ToolResultMessage> {
  emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });

  let message: ToolResultMessage;
  try {
    const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
    message = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: result.content }],
      isError: false,
      timestamp: Date.now(),
    };
  } catch (error) {
    message = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
      timestamp: Date.now(),
    };
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

  return message;
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "toolCall") return cloneToolCall(block);
      return { ...block };
    }),
  };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    arguments: { ...toolCall.arguments },
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
  const result = await runEventedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "I saw the tool result.",
    }),
    createDemoToolRegistry(),
  );

  console.log(`Events: ${result.eventTypes.join(" -> ")}`);
  console.log(`Messages: ${result.messages.map((message) => message.role).join(" -> ")}`);
  console.log(`Tool result: ${result.toolResults[0]?.content[0]?.text}`);
  console.log(`Final text: ${readTextBlocksFromLastAssistant(result.messages).join("")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
