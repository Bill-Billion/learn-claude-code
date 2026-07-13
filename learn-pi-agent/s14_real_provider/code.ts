import { realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from "../s02_tool_schema/code.ts";
import type {
  AssistantMessage,
  EventProvider,
  ProviderContext,
  ProviderEvent,
  StopReason,
  TextContent,
  ToolCall,
} from "../s03_provider_events/code.ts";
import { createIntegratedHarnessRuntime, type IntegratedHarnessRuntime } from "../s13_integrated_harness/code.ts";

export type OpenAICompatibleConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type OpenAICompatibleProviderOptions = Omit<OpenAICompatibleConfig, "baseUrl"> & {
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onError?: (error: OpenAIProviderError) => void;
  onDone?: (reason: Extract<StopReason, "stop" | "length" | "toolUse">) => void;
};

export type LiveSessionOptions = Pick<OpenAICompatibleProviderOptions, "fetch" | "signal" | "timeoutMs">;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SSE_EVENT_CHARS = 1_000_000;
const MAX_SSE_RESPONSE_BYTES = 4_000_000;
const MAX_ERROR_BODY_BYTES = 64_000;
const MAX_COURSE_FILE_BYTES = 50_000;
const MAX_TOOL_CALLS_PER_RESPONSE = 1;
const LIVE_MAX_TURNS = 4;
const DEFAULT_COURSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type OpenAIProviderErrorKind = "authentication" | "rate_limit" | "http" | "network" | "aborted" | "protocol";

export class OpenAIProviderError extends Error {
  readonly kind: OpenAIProviderErrorKind;
  readonly status?: number;

  constructor(kind: OpenAIProviderErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenAIProviderError";
    this.kind = kind;
    this.status = options.status;
  }
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type StreamToolCallDelta = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type ToolAccumulator = {
  contentIndex: number;
  id: string;
  name: string;
  argumentsText: string;
};

export function loadOpenAICompatibleConfig(
  env: Readonly<Record<string, string | undefined>>,
): OpenAICompatibleConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for s14. See .env.example, then export it or create learn-pi-agent/.env.");
  }
  const model = env.OPENAI_MODEL?.trim();
  if (!model) {
    throw new Error("OPENAI_MODEL is required for s14. See .env.example and set a model available from your provider.");
  }
  const baseUrl = env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  try {
    new URL(baseUrl);
  } catch (error) {
    throw new Error(`OPENAI_BASE_URL must be an absolute URL: ${baseUrl}`, { cause: error });
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model };
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): EventProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");

  return {
    async *stream(context: ProviderContext): AsyncIterable<ProviderEvent> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let requestSignal = options.signal;
      let started = false;
      try {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          throw new OpenAIProviderError("protocol", "Provider timeoutMs must be a positive safe integer");
        }
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        const request = createChatCompletionRequest(options.model, context);
        const response = await fetchImplementation(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(request),
          signal: requestSignal,
        });

        if (!response.ok) {
          throw await createHttpError(response);
        }
        if (!response.body) {
          throw new OpenAIProviderError("protocol", "Provider returned a streaming response without a body");
        }
        for await (const event of translateSseStream(response.body)) {
          if (event.type === "start") started = true;
          if (event.type === "done") {
            try {
              options.onDone?.(event.reason);
            } catch {
              // Observability callbacks must not create a third provider failure channel.
            }
          }
          yield event;
        }
      } catch (cause) {
        const error = cause instanceof OpenAIProviderError
          ? cause
          : classifyTransportError(cause, requestSignal, timeoutMs);
        try {
          options.onError?.(error);
        } catch {
          // Observability callbacks must not create a third provider failure channel.
        }
        const reason = error.kind === "aborted" ? "aborted" : "error";
        const errorMessage = createErrorMessage(reason, error.message);
        if (!started) {
          yield { type: "start", partial: cloneMessage(errorMessage) };
        }
        yield { type: "error", reason, error: cloneMessage(errorMessage) };
      }
    },
  };
}

function createChatCompletionRequest(model: string, context: ProviderContext): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  messages.push(...context.messages.map(toChatMessage));

  return {
    model,
    stream: true,
    messages,
    ...(context.tools.length === 0
      ? {}
      : { tools: context.tools.map(toChatTool), parallel_tool_calls: false }),
  };
}

function toChatTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new OpenAIProviderError("protocol", "ProviderContext contains a message without a supported role");
  }

  if (value.role === "user") {
    return { role: "user", content: requireStringContent(value) };
  }
  if (value.role === "custom") {
    const label = typeof value.customType === "string" ? `[${value.customType}]\n` : "";
    return { role: "user", content: `${label}${requireStringContent(value)}` };
  }
  if (value.role === "assistant") {
    if (typeof value.content === "string") {
      return { role: "assistant", content: value.content };
    }
    if (!Array.isArray(value.content)) {
      throw new OpenAIProviderError("protocol", "Assistant message content must be a string or content block array");
    }
    const text = value.content
      .filter((block): block is TextContent => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const toolCalls = value.content
      .filter((block): block is ToolCall => (
        isRecord(block)
          && block.type === "toolCall"
          && typeof block.id === "string"
          && typeof block.name === "string"
          && isRecord(block.arguments)
      ))
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.arguments) },
      }));
    return {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  }
  if (value.role === "toolResult") {
    if (typeof value.toolCallId !== "string" || !Array.isArray(value.content)) {
      throw new OpenAIProviderError("protocol", "Tool result must contain toolCallId and content blocks");
    }
    const content = value.content
      .filter((block): block is TextContent => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return { role: "tool", tool_call_id: value.toolCallId, content };
  }

  throw new OpenAIProviderError("protocol", `Unsupported message role: ${value.role}`);
}

function requireStringContent(value: Record<string, unknown>): string {
  if (typeof value.content !== "string") {
    throw new OpenAIProviderError("protocol", `${String(value.role)} message content must be a string`);
  }
  return value.content;
}

async function* translateSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<ProviderEvent> {
  const partial = createAssistantMessage();
  const toolCalls = new Map<number, ToolAccumulator>();
  let textIndex: number | undefined;
  let finishReason: string | undefined;
  let sawDone = false;

  yield { type: "start", partial: cloneMessage(partial) };

  for await (const data of readSseData(body)) {
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    if (finishReason !== undefined) {
      throw new OpenAIProviderError("protocol", "Provider sent content after finish_reason");
    }

    const chunk = parseSseJson(data);
    const choice = getFirstChoice(chunk);
    if (!choice) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};

    const textDeltas: string[] = [];
    for (const field of ["content", "refusal"] as const) {
      const value = delta[field];
      if (typeof value === "string") {
        if (value.length > 0) textDeltas.push(value);
      } else if (value !== undefined && value !== null) {
        throw new OpenAIProviderError("protocol", `Streaming delta.${field} must be a string or null`);
      }
    }
    for (const textDelta of textDeltas) {
      if (textIndex === undefined) {
        textIndex = partial.content.length;
        partial.content.push({ type: "text", text: "" });
        yield { type: "text_start", contentIndex: textIndex, partial: cloneMessage(partial) };
      }
      const block = partial.content[textIndex] as TextContent;
      block.text += textDelta;
      yield {
        type: "text_delta",
        contentIndex: textIndex,
        delta: textDelta,
        partial: cloneMessage(partial),
      };
    }

    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw new OpenAIProviderError("protocol", "Streaming delta.tool_calls must be an array");
      }
      for (const rawToolDelta of delta.tool_calls) {
        const event = appendToolCallDelta(rawToolDelta, partial, toolCalls);
        if (event.started) {
          yield { type: "toolcall_start", contentIndex: event.tool.contentIndex, partial: cloneMessage(partial) };
        }
        yield {
          type: "toolcall_delta",
          contentIndex: event.tool.contentIndex,
          delta: event.argumentsDelta,
          partial: cloneMessage(partial),
        };
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (typeof choice.finish_reason !== "string") {
        throw new OpenAIProviderError("protocol", "finish_reason must be a string or null");
      }
      finishReason = choice.finish_reason;
    }
  }

  if (!sawDone) {
    throw new OpenAIProviderError("protocol", "SSE stream ended before [DONE]");
  }
  if (finishReason === undefined) {
    throw new OpenAIProviderError("protocol", "SSE stream reached [DONE] without finish_reason");
  }

  const stopReason = mapFinishReason(finishReason, toolCalls.size);
  if (textIndex !== undefined) {
    const text = (partial.content[textIndex] as TextContent).text;
    yield { type: "text_end", contentIndex: textIndex, content: text, partial: cloneMessage(partial) };
  }
  for (const tool of toolCalls.values()) {
    const finalized = finalizeToolCall(tool);
    const block = partial.content[tool.contentIndex] as ToolCall;
    block.id = finalized.id;
    block.name = finalized.name;
    block.arguments = { ...finalized.arguments };
    yield {
      type: "toolcall_end",
      contentIndex: tool.contentIndex,
      toolCall: cloneToolCall(finalized),
      partial: cloneMessage(partial),
    };
  }
  partial.stopReason = stopReason;
  yield { type: "done", reason: stopReason, message: cloneMessage(partial) };
}

function appendToolCallDelta(
  value: unknown,
  partial: AssistantMessage,
  tools: Map<number, ToolAccumulator>,
): { tool: ToolAccumulator; started: boolean; argumentsDelta: string } {
  if (!isRecord(value) || !Number.isInteger(value.index) || Number(value.index) < 0) {
    throw new OpenAIProviderError("protocol", "Every tool-call delta must include a non-negative integer index");
  }
  const delta = value as StreamToolCallDelta;
  const index = Number(delta.index);
  let tool = tools.get(index);
  const started = tool === undefined;
  if (!tool) {
    if (tools.size >= MAX_TOOL_CALLS_PER_RESPONSE) {
      throw new OpenAIProviderError(
        "protocol",
        `The live capstone accepts at most ${MAX_TOOL_CALLS_PER_RESPONSE} tool call per response`,
      );
    }
    tool = { contentIndex: partial.content.length, id: "", name: "", argumentsText: "" };
    tools.set(index, tool);
    partial.content.push({ type: "toolCall", id: "", name: "", arguments: {} });
  }

  if (delta.id !== undefined) {
    if (typeof delta.id !== "string") throw new OpenAIProviderError("protocol", "Tool-call id delta must be a string");
    tool.id += delta.id;
  }
  const functionDelta = delta.function;
  let argumentsDelta = "";
  if (functionDelta !== undefined) {
    if (!isRecord(functionDelta)) throw new OpenAIProviderError("protocol", "Tool-call function delta must be an object");
    if (functionDelta.name !== undefined) {
      if (typeof functionDelta.name !== "string") throw new OpenAIProviderError("protocol", "Tool name delta must be a string");
      tool.name += functionDelta.name;
    }
    if (functionDelta.arguments !== undefined) {
      if (typeof functionDelta.arguments !== "string") throw new OpenAIProviderError("protocol", "Tool arguments delta must be a string");
      argumentsDelta = functionDelta.arguments;
      tool.argumentsText += argumentsDelta;
    }
  }

  const block = partial.content[tool.contentIndex] as ToolCall;
  block.id = tool.id;
  block.name = tool.name;
  return { tool, started, argumentsDelta };
}

function finalizeToolCall(tool: ToolAccumulator): ToolCall {
  if (!tool.id || !tool.name) {
    throw new OpenAIProviderError("protocol", "Tool call ended without a complete id and function name");
  }
  let argumentsValue: unknown = {};
  if (tool.argumentsText.trim()) {
    try {
      argumentsValue = JSON.parse(tool.argumentsText);
    } catch (error) {
      throw new OpenAIProviderError("protocol", `Invalid JSON arguments for tool ${tool.name}`, { cause: error });
    }
  }
  if (!isRecord(argumentsValue)) {
    throw new OpenAIProviderError("protocol", `Arguments for tool ${tool.name} must decode to a JSON object`);
  }
  return { type: "toolCall", id: tool.id, name: tool.name, arguments: argumentsValue };
}

function mapFinishReason(reason: string, toolCallCount: number): Extract<StopReason, "stop" | "length" | "toolUse"> {
  if (reason === "tool_calls") {
    if (toolCallCount === 0) {
      throw new OpenAIProviderError("protocol", "finish_reason was tool_calls but no tool call was received");
    }
    return "toolUse";
  }
  if (toolCallCount > 0) {
    throw new OpenAIProviderError("protocol", `finish_reason ${reason} cannot finalize a tool call`);
  }
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") {
    throw new OpenAIProviderError("protocol", "Provider stopped because content was filtered (finish_reason: content_filter)");
  }
  throw new OpenAIProviderError("protocol", `Unsupported finish_reason: ${reason}`);
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  let reachedEnd = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      responseBytes += value.byteLength;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        throw new OpenAIProviderError("protocol", `SSE response exceeded ${MAX_SSE_RESPONSE_BYTES.toLocaleString("en-US")} bytes`);
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findEventBoundary(buffer);
      while (boundary) {
        const record = buffer.slice(0, boundary.index);
        if (record.length > MAX_SSE_EVENT_CHARS) {
          throw new OpenAIProviderError("protocol", `SSE event exceeded ${MAX_SSE_EVENT_CHARS.toLocaleString("en-US")} characters`);
        }
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = readDataField(record);
        if (data !== undefined) yield data;
        boundary = findEventBoundary(buffer);
      }
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        throw new OpenAIProviderError("protocol", `SSE event exceeded ${MAX_SSE_EVENT_CHARS.toLocaleString("en-US")} characters`);
      }
    }
    buffer += decoder.decode();
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // The original provider result is more useful than a cleanup failure.
      }
    }
    reader.releaseLock();
  }

  if (buffer.trim()) {
    throw new OpenAIProviderError("protocol", "SSE stream ended with an incomplete event");
  }
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function readDataField(record: string): string | undefined {
  const data = record
    .split(/\r?\n/)
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length === 0 ? undefined : data.join("\n");
}

function parseSseJson(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) throw new Error("event is not an object");
    return parsed;
  } catch (error) {
    throw new OpenAIProviderError("protocol", `Malformed SSE JSON: ${shorten(data)}`, { cause: error });
  }
}

function getFirstChoice(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(chunk.choices)) {
    if (isRecord(chunk.error) && typeof chunk.error.message === "string") {
      throw new OpenAIProviderError("protocol", `Provider stream error: ${chunk.error.message}`);
    }
    throw new OpenAIProviderError("protocol", "Streaming chunk must contain a choices array");
  }
  if (chunk.choices.length === 0) return undefined;
  const choice = chunk.choices[0];
  if (!isRecord(choice)) throw new OpenAIProviderError("protocol", "Streaming choice must be an object");
  return choice;
}

async function createHttpError(response: Response): Promise<OpenAIProviderError> {
  let detail = response.statusText || "request rejected";
  try {
    const text = await readLimitedResponseText(response, MAX_ERROR_BODY_BYTES);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        detail = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
          ? parsed.error.message
          : shorten(text);
      } catch {
        detail = shorten(text);
      }
    }
  } catch {
    // The status is still actionable even if the error body cannot be read.
  }

  if (response.status === 401 || response.status === 403) {
    return new OpenAIProviderError("authentication", `Authentication failed (HTTP ${response.status}): ${detail}`, { status: response.status });
  }
  if (response.status === 429) {
    return new OpenAIProviderError("rate_limit", `Rate limited (HTTP 429): ${detail}`, { status: response.status });
  }
  return new OpenAIProviderError("http", `Provider request failed (HTTP ${response.status}): ${detail}`, { status: response.status });
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let reachedEnd = false;

  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      const remaining = maxBytes - bytes;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      bytes += accepted.byteLength;
      text += decoder.decode(accepted, { stream: bytes < maxBytes });
      if (accepted.byteLength < value.byteLength) break;
    }
    if (reachedEnd) text += decoder.decode();
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // The HTTP status still explains the provider failure.
      }
    }
    reader.releaseLock();
  }
  return text;
}

function classifyTransportError(error: unknown, signal: AbortSignal | undefined, timeoutMs?: number): OpenAIProviderError {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
    const timedOut = signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError";
    const message = timedOut && timeoutMs !== undefined
      ? `Provider request timed out after ${timeoutMs} ms`
      : "Provider request was aborted";
    return new OpenAIProviderError("aborted", message, { cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new OpenAIProviderError("network", `Provider network error: ${detail}`, { cause: error });
}

function createAssistantMessage(): AssistantMessage {
  return { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() };
}

function createErrorMessage(reason: Extract<StopReason, "error" | "aborted">, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message }],
    stopReason: reason,
    timestamp: Date.now(),
  };
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => block.type === "toolCall" ? cloneToolCall(block) : { ...block }),
  };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return { ...toolCall, arguments: { ...toolCall.arguments } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shorten(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

export async function createLiveHarnessRuntime(
  config: OpenAICompatibleProviderOptions,
  courseRoot = DEFAULT_COURSE_ROOT,
): Promise<IntegratedHarnessRuntime> {
  const provider = createOpenAICompatibleProvider(config);
  const registry = createLiveToolRegistry(courseRoot);
  const systemPath = path.join(courseRoot, "AGENTS.md");
  return createIntegratedHarnessRuntime({
    files: {
      [systemPath]: [
        "You are the live-model capstone for a course about agent harnesses.",
        "Use read_course_file whenever the learner asks about a course file; do not invent file contents.",
        "After a tool result, answer the learner's original question and briefly name the file you used.",
      ].join("\n"),
    },
    cwd: courseRoot,
    agentDir: path.join(courseRoot, ".pi-agent"),
    provider,
    baseRegistry: registry,
    model: { provider: "openai-compatible", id: config.model },
    trust: { trustOverride: true },
    maxTurns: LIVE_MAX_TURNS,
  });
}

function createLiveToolRegistry(courseRoot: string): ToolRegistry {
  const resolvedRoot = path.resolve(courseRoot);
  return createToolRegistry([
    {
      name: "read_course_file",
      label: "read_course_file",
      description: "Read a UTF-8 text file inside the learn-pi-agent course directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Course-relative path, for example README.md or s01_agent_loop/README.md." },
        },
        required: ["path"],
      },
      async handler(input) {
        if (typeof input.path !== "string") {
          throw new Error("read_course_file path must be a string");
        }
        const requested = input.path;
        const target = path.resolve(resolvedRoot, requested);
        const lexicalRelative = path.relative(resolvedRoot, target);
        if (!requested || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
          throw new Error("read_course_file only accepts paths inside learn-pi-agent");
        }
        let realRoot: string;
        let realTarget: string;
        try {
          [realRoot, realTarget] = await Promise.all([realpath(resolvedRoot), realpath(target)]);
        } catch {
          throw new Error(`read_course_file could not read ${requested}`);
        }
        const realRelative = path.relative(realRoot, realTarget);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
          throw new Error("read_course_file only accepts paths inside learn-pi-agent");
        }
        if (realRelative.split(path.sep).some((segment) => segment.startsWith("."))) {
          throw new Error("read_course_file does not read hidden files such as .env");
        }
        let metadata;
        try {
          metadata = await stat(realTarget);
        } catch {
          throw new Error(`read_course_file could not read ${requested}`);
        }
        if (!metadata.isFile()) {
          throw new Error("read_course_file only reads regular files");
        }
        if (metadata.size > MAX_COURSE_FILE_BYTES) {
          throw new Error(`read_course_file refuses files larger than ${MAX_COURSE_FILE_BYTES.toLocaleString("en-US")} bytes`);
        }

        let handle;
        try {
          handle = await open(realTarget, "r");
        } catch {
          throw new Error(`read_course_file could not read ${requested}`);
        }
        try {
          let openedMetadata;
          try {
            openedMetadata = await handle.stat();
          } catch {
            throw new Error(`read_course_file could not read ${requested}`);
          }
          if (!openedMetadata.isFile()) {
            throw new Error("read_course_file only reads regular files");
          }
          if (openedMetadata.size > MAX_COURSE_FILE_BYTES) {
            throw new Error(`read_course_file refuses files larger than ${MAX_COURSE_FILE_BYTES.toLocaleString("en-US")} bytes`);
          }

          const buffer = Buffer.alloc(openedMetadata.size);
          let bytesReadTotal = 0;
          try {
            while (bytesReadTotal < buffer.length) {
              const { bytesRead } = await handle.read(
                buffer,
                bytesReadTotal,
                buffer.length - bytesReadTotal,
                bytesReadTotal,
              );
              if (bytesRead === 0) break;
              bytesReadTotal += bytesRead;
            }
          } catch {
            throw new Error(`read_course_file could not read ${requested}`);
          }
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesReadTotal));
          } catch {
            throw new Error("read_course_file only reads valid UTF-8 text files");
          }
          return { toolName: "read_course_file", content };
        } finally {
          await handle.close();
        }
      },
    },
  ]);
}

export async function runLiveSession(
  question: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LiveSessionOptions = {},
): Promise<string> {
  if (!question.trim()) {
    throw new Error('Pass a question, for example: npm run session:s14 -- "Read README.md and summarize the course"');
  }
  const config = loadOpenAICompatibleConfig(env);
  let providerError: OpenAIProviderError | undefined;
  let lastStopReason: Extract<StopReason, "stop" | "length" | "toolUse"> | undefined;
  const runtime = await createLiveHarnessRuntime({
    ...config,
    ...options,
    onError(error) {
      providerError = error;
    },
    onDone(reason) {
      lastStopReason = reason;
    },
  });
  const result = await runtime.prompt(question.trim());
  if (providerError) throw providerError;
  if (lastStopReason === "toolUse") {
    throw new Error(`Agent reached the ${LIVE_MAX_TURNS}-turn limit while the model was still requesting a tool`);
  }
  return result.finalText;
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const question = process.argv.slice(2).join(" ");
    console.log(await runLiveSession(question));
  } catch (error) {
    console.error(`s14 live session failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
