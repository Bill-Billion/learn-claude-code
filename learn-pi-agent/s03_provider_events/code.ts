import {
  stream as streamModel,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type ToolCall as PiToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import {
  createInitialState,
  createUserMessage,
  type AgentState,
} from "../s01_agent_loop/code.ts";
import {
  createCourseToolRegistry,
  createRegistryToolRuntime,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";

export type CollectAssistantStreamOptions = {
  model: Model<Api>;
  context: Context;
  streamOptions?: ProviderStreamOptions;
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
};

export type CollectedAssistantStream = {
  events: AssistantMessageEvent[];
  eventTypes: AssistantMessageEvent["type"][];
  message: PiAssistantMessage;
};

export async function collectAssistantStream(
  options: CollectAssistantStreamOptions,
): Promise<CollectedAssistantStream> {
  const events: AssistantMessageEvent[] = [];
  let message: PiAssistantMessage | undefined;

  for await (const event of streamModel(options.model, options.context, options.streamOptions)) {
    events.push(event);
    await options.onEvent?.(event);
    if (event.type === "done") message = event.message;
    if (event.type === "error") message = event.error;
  }

  if (!message) {
    throw new Error("Model stream ended without a final assistant message");
  }
  return { events, eventTypes: events.map((event) => event.type), message };
}

export type RunStreamingAgentLoopOptions = {
  model: Model<Api>;
  prompt: string;
  registry: ToolRegistry;
  state?: AgentState;
  systemPrompt?: string;
  streamOptions?: ProviderStreamOptions;
  maxTurns?: number;
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
};

export type RunStreamingAgentLoopResult = {
  state: AgentState;
  finalMessage: PiAssistantMessage;
  toolResults: ToolResultMessage[];
  events: AssistantMessageEvent[];
};

export async function runStreamingAgentLoop(
  options: RunStreamingAgentLoopOptions,
): Promise<RunStreamingAgentLoopResult> {
  const maxTurns = options.maxTurns ?? 8;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive safe integer");
  }

  const state = options.state ?? createInitialState();
  const runtime = createRegistryToolRuntime(options.registry);
  const toolResults: ToolResultMessage[] = [];
  const events: AssistantMessageEvent[] = [];
  state.messages.push(createUserMessage(options.prompt));

  for (let turn = 0; turn < maxTurns; turn++) {
    const streamed = await collectAssistantStream({
      model: options.model,
      context: {
        systemPrompt: options.systemPrompt,
        messages: state.messages,
        tools: runtime.tools,
      },
      streamOptions: options.streamOptions,
      async onEvent(event) {
        events.push(event);
        await options.onEvent?.(event);
      },
    });
    const assistantMessage = streamed.message;
    state.messages.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      throw new Error(assistantMessage.errorMessage ?? `Model stopped with ${assistantMessage.stopReason}`);
    }

    const toolCalls = assistantMessage.content.filter(
      (block): block is PiToolCall => block.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      return { state, finalMessage: assistantMessage, toolResults, events };
    }
    for (const toolCall of toolCalls) {
      const result = await runtime.execute(toolCall);
      state.messages.push(result);
      toolResults.push(result);
    }
  }

  throw new Error(`Agent exceeded the maximum of ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}`);
}

export function readTextBlocks(message: PiAssistantMessage): string[] {
  return message.content
    .filter((block): block is Extract<PiAssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text);
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const state = createInitialState();
  const registry = createCourseToolRegistry(process.cwd());
  await runPromptCli("s03 Provider Events", async (prompt) => {
    await runStreamingAgentLoop({
      ...runtime,
      prompt,
      state,
      registry,
      onEvent(event) {
        if (event.type === "text_delta") process.stdout.write(event.delta);
      },
    });
    process.stdout.write("\n");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
