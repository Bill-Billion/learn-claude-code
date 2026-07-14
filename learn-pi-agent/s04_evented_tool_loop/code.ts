import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage as PiToolResultMessage,
  UserMessage,
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
import { collectAssistantStream, readTextBlocks } from "../s03_provider_events/code.ts";

export type ToolResultMessage = PiToolResultMessage;
export type LoopMessage = Message;

export type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; turn: number; message: Message }
  | { type: "message_update"; turn: number; message: AssistantMessage; providerEvent: AssistantMessageEvent }
  | { type: "message_end"; turn: number; message: Message }
  | { type: "tool_execution_start"; turn: number; toolCall: ToolCall }
  | { type: "tool_execution_end"; turn: number; toolCall: ToolCall; result: ToolResultMessage };

export type ToolExecutionContext = {
  turn: number;
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  messages: Message[];
  executeDefault(toolCall?: ToolCall): Promise<ToolResultMessage>;
};

export type ToolExecutionOutcome = {
  message: ToolResultMessage;
  terminate?: boolean;
};

export type ToolCallExecutor = (
  context: ToolExecutionContext,
) => Promise<ToolExecutionOutcome> | ToolExecutionOutcome;

export type RunEventedToolLoopOptions = {
  model: Model<Api>;
  prompt: string;
  registry: ToolRegistry;
  state?: AgentState;
  userMessage?: UserMessage;
  systemPrompt?: string;
  streamOptions?: ProviderStreamOptions;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  executeToolCall?: ToolCallExecutor;
};

export type RunEventedToolLoopResult = {
  state: AgentState;
  events: AgentEvent[];
  eventTypes: AgentEvent["type"][];
  toolResults: ToolResultMessage[];
  finalMessage: AssistantMessage;
  terminated: boolean;
};

export async function runEventedToolLoop(
  options: RunEventedToolLoopOptions,
): Promise<RunEventedToolLoopResult> {
  const maxTurns = options.maxTurns ?? 8;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive safe integer");
  }

  const state = options.state ?? createInitialState();
  const runtime = createRegistryToolRuntime(options.registry);
  const events: AgentEvent[] = [];
  const toolResults: ToolResultMessage[] = [];
  const runStartIndex = state.messages.length;
  let lifecycleClosed = false;
  let observerFailed = false;

  const emit = async (event: AgentEvent, notifyObserver = true): Promise<void> => {
    events.push(event);
    if (!notifyObserver) return;
    try {
      await options.onEvent?.(event);
    } catch (error) {
      observerFailed = true;
      throw error;
    }
  };
  const closeLifecycle = async (notifyObserver = true): Promise<void> => {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    await emit({
      type: "agent_end",
      messages: structuredClone(state.messages.slice(runStartIndex)),
    }, notifyObserver);
  };

  state.messages.push(options.userMessage ?? createUserMessage(options.prompt));

  try {
    await emit({ type: "agent_start", prompt: options.prompt });
    for (let turn = 1; turn <= maxTurns; turn++) {
      await emit({ type: "turn_start", turn });
      const streamed = await collectAssistantStream({
        model: options.model,
        context: {
          systemPrompt: options.systemPrompt,
          messages: state.messages,
          tools: runtime.tools,
        },
        streamOptions: options.streamOptions,
        async onEvent(providerEvent) {
          if (providerEvent.type === "start") {
            await emit({ type: "message_start", turn, message: providerEvent.partial });
          } else if (providerEvent.type !== "done" && providerEvent.type !== "error") {
            await emit({
              type: "message_update",
              turn,
              message: providerEvent.partial,
              providerEvent,
            });
          }
        },
      });
      const assistantMessage = streamed.message;
      state.messages.push(assistantMessage);
      await emit({ type: "message_end", turn, message: assistantMessage });

      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        await emit({ type: "turn_end", turn, message: assistantMessage, toolResults: [] });
        throw new Error(assistantMessage.errorMessage ?? `Model stopped with ${assistantMessage.stopReason}`);
      }

      const toolCalls = assistantMessage.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      const turnResults: ToolResultMessage[] = [];
      const outcomes: ToolExecutionOutcome[] = [];

      for (const toolCall of toolCalls) {
        await emit({ type: "tool_execution_start", turn, toolCall });
        const executeDefault = (override = toolCall) => runtime.execute(override);
        const outcome = options.executeToolCall
          ? await options.executeToolCall({
              turn,
              assistantMessage,
              toolCall,
              messages: state.messages,
              executeDefault,
            })
          : { message: await executeDefault() };
        state.messages.push(outcome.message);
        toolResults.push(outcome.message);
        turnResults.push(outcome.message);
        outcomes.push(outcome);
        await emit({ type: "tool_execution_end", turn, toolCall, result: outcome.message });
        await emit({ type: "message_start", turn, message: outcome.message });
        await emit({ type: "message_end", turn, message: outcome.message });
      }

      await emit({ type: "turn_end", turn, message: assistantMessage, toolResults: turnResults });

      if (toolCalls.length === 0) {
        await closeLifecycle();
        return {
          state,
          events,
          eventTypes: events.map((event) => event.type),
          toolResults,
          finalMessage: assistantMessage,
          terminated: false,
        };
      }

      if (outcomes.every((outcome) => outcome.terminate === true)) {
        await closeLifecycle();
        return {
          state,
          events,
          eventTypes: events.map((event) => event.type),
          toolResults,
          finalMessage: assistantMessage,
          terminated: true,
        };
      }
    }

    throw new Error(`Agent exceeded the maximum of ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}`);
  } catch (error) {
    try {
      await closeLifecycle(!observerFailed);
    } catch {
      // Preserve the error that ended the run rather than replacing it with observer cleanup failure.
    }
    throw error;
  }
}

export function readTextBlocksFromLastAssistant(messages: Message[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return readTextBlocks(message);
    }
  }
  return [];
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const state = createInitialState();
  const registry = createCourseToolRegistry(process.cwd());
  await runPromptCli("s04 Evented Tool Loop", async (prompt) => {
    const result = await runEventedToolLoop({ ...runtime, prompt, state, registry });
    return readTextBlocks(result.finalMessage).join("");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
