import type { ToolDefinition } from "../s02_tool_schema/code.ts";
import { createDemoToolRegistry, listToolDefinitions } from "../s02_tool_schema/code.ts";

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type TextContent = {
  type: "text";
  text: string;
};

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  stopReason: StopReason;
  timestamp: number;
};

export type ProviderContext = {
  messages: unknown[];
  tools: ToolDefinition[];
  systemPrompt?: string;
};

export type ProviderEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "error" | "aborted">; error: AssistantMessage };

export type EventProvider = {
  stream(context: ProviderContext): AsyncIterable<ProviderEvent>;
};

export type CollectedProviderStream = {
  events: ProviderEvent[];
  eventTypes: string[];
  message: AssistantMessage;
  textByIndex: Map<number, string>;
  toolCalls: ToolCall[];
};

function createAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
  };
}

export function createTextProvider(chunks: string[]): EventProvider {
  return {
    async *stream() {
      const partial = createAssistantMessage();
      partial.content.push({ type: "text", text: "" });

      yield { type: "start", partial: cloneMessage(partial) };
      yield { type: "text_start", contentIndex: 0, partial: cloneMessage(partial) };

      for (const chunk of chunks) {
        const block = partial.content[0] as TextContent;
        block.text += chunk;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: chunk,
          partial: cloneMessage(partial),
        };
      }

      const text = (partial.content[0] as TextContent).text;
      yield { type: "text_end", contentIndex: 0, content: text, partial: cloneMessage(partial) };
      yield { type: "done", reason: "stop", message: cloneMessage(partial) };
    },
  };
}

export function createToolCallProvider(name: string, args: Record<string, unknown>): EventProvider {
  return {
    async *stream(context) {
      if (!context.tools.some((tool) => tool.name === name)) {
        const error = createAssistantMessage();
        error.stopReason = "error";
        yield { type: "start", partial: cloneMessage(error) };
        yield { type: "error", reason: "error", error };
        return;
      }

      const partial = createAssistantMessage();
      partial.stopReason = "toolUse";
      partial.content.push({ type: "toolCall", id: "call_1", name, arguments: {} });

      yield { type: "start", partial: cloneMessage(partial) };
      yield { type: "toolcall_start", contentIndex: 0, partial: cloneMessage(partial) };

      const block = partial.content[0] as ToolCall;
      block.arguments = { ...args };
      yield {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: JSON.stringify(args),
        partial: cloneMessage(partial),
      };
      yield {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { ...block, arguments: { ...block.arguments } },
        partial: cloneMessage(partial),
      };
      yield { type: "done", reason: "toolUse", message: cloneMessage(partial) };
    },
  };
}

export function createInterleavedProvider(): EventProvider {
  return {
    async *stream() {
      const partial = createAssistantMessage();
      partial.content.push({ type: "text", text: "" });
      partial.content.push({ type: "text", text: "" });

      yield { type: "start", partial: cloneMessage(partial) };
      yield { type: "text_start", contentIndex: 0, partial: cloneMessage(partial) };

      (partial.content[0] as TextContent).text += "first ";
      yield { type: "text_delta", contentIndex: 0, delta: "first ", partial: cloneMessage(partial) };

      yield { type: "text_start", contentIndex: 1, partial: cloneMessage(partial) };

      (partial.content[1] as TextContent).text += "second ";
      yield { type: "text_delta", contentIndex: 1, delta: "second ", partial: cloneMessage(partial) };

      (partial.content[0] as TextContent).text += "block";
      yield { type: "text_delta", contentIndex: 0, delta: "block", partial: cloneMessage(partial) };
      yield { type: "text_end", contentIndex: 0, content: "first block", partial: cloneMessage(partial) };

      (partial.content[1] as TextContent).text += "block";
      yield { type: "text_delta", contentIndex: 1, delta: "block", partial: cloneMessage(partial) };
      yield { type: "text_end", contentIndex: 1, content: "second block", partial: cloneMessage(partial) };

      yield { type: "done", reason: "stop", message: cloneMessage(partial) };
    },
  };
}

export async function collectProviderStream(
  provider: EventProvider,
  context: ProviderContext,
): Promise<CollectedProviderStream> {
  const events: ProviderEvent[] = [];
  const textByIndex = new Map<number, string>();
  const toolCalls: ToolCall[] = [];
  let message: AssistantMessage | undefined;

  for await (const event of provider.stream(context)) {
    events.push(event);

    if (event.type === "text_delta") {
      textByIndex.set(event.contentIndex, (textByIndex.get(event.contentIndex) ?? "") + event.delta);
    }
    if (event.type === "toolcall_end") {
      toolCalls.push(event.toolCall);
    }
    if (event.type === "done") {
      message = event.message;
    }
    if (event.type === "error") {
      message = event.error;
    }
  }

  if (!message) {
    throw new Error("Provider stream ended without done or error event");
  }

  return {
    events,
    eventTypes: events.map((event) => event.type),
    message,
    textByIndex,
    toolCalls,
  };
}

export function readTextBlocks(message: AssistantMessage): string[] {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text);
}

export async function runDemo(): Promise<void> {
  const textResult = await collectProviderStream(createTextProvider(["Pi ", "streams ", "events."]), {
    messages: [],
    tools: [],
  });
  console.log(`Text events: ${textResult.eventTypes.join(" -> ")}`);
  console.log(`Text: ${readTextBlocks(textResult.message).join("")}`);

  const registry = createDemoToolRegistry();
  const toolResult = await collectProviderStream(createToolCallProvider("read", { path: "README.md" }), {
    messages: [],
    tools: listToolDefinitions(registry),
  });
  console.log(`Tool events: ${toolResult.eventTypes.join(" -> ")}`);
  console.log(`Stop reason: ${toolResult.message.stopReason}`);
  console.log(`Tool call: ${toolResult.toolCalls[0]?.name} ${JSON.stringify(toolResult.toolCalls[0]?.arguments)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
