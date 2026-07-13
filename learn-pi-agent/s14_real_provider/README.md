# s14 · Real Provider

English | [中文](README.zh.md) | [日本語](README.ja.md)

[← s13](../s13_integrated_harness/README.md) | [Contents](../README.md)

> In one sentence: s14 translates OpenAI-compatible Chat Completions SSE into the `ProviderEvent` protocol from s03, then lets a real model drive the integrated s13 tool loop.
>
> Where this sits in Pi: the `pi-ai` provider layer, immediately before `pi-agent-core` consumes normalized assistant events.

→ Offline fixtures prove that the harness mechanics are deterministic; a live provider proves that the model can actually choose the next action
→ An SSE chunk is a transport fragment, not a semantic event: UTF-8 bytes, SSE records, JSON deltas, and tool arguments must be assembled at four different boundaries
→ Tool arguments are untrusted model output: do not execute until the complete string parses as a JSON object and the registry validates it

---

## The Problem

s01 through s13 deliberately use deterministic providers. That makes event order, tool execution, session storage, extension hooks, trust, and package resolution easy to learn and safe to test. It also leaves one important question unanswered: can the same interfaces survive a real model stream?

A real Chat Completions response does not arrive as one `AssistantMessage`. It arrives as arbitrarily split bytes containing SSE records. Each JSON record may carry a piece of text, a piece of a tool id, a piece of a function name, or a piece of the function's JSON arguments. A request can also fail before the body, while reading the body, or after a partial semantic response.

The wrong shortcut is to split every network chunk on `\n\n` and call `JSON.parse()` on each piece. Network chunks do not respect UTF-8 code points or SSE record boundaries. Even after SSE parsing, `tool_calls[].function.arguments` is still an incomplete string until the model finishes the call.

s14 therefore adds one narrow adapter. It does not change the loop, registry, session, or runtime contracts built earlier.

## The Idea

The outbound path converts the existing `ProviderContext`:

```text
systemPrompt             -> system message
user message             -> user message
assistant text/toolCall  -> assistant content/tool_calls
toolResult               -> tool message with tool_call_id
ToolDefinition           -> function tool schema
```

The inbound path reverses the transport layers in order:

```text
ReadableStream<Uint8Array>
  -> streaming TextDecoder
  -> complete SSE records
  -> JSON chat-completion chunks
  -> text/tool-call accumulators
  -> s03 ProviderEvent
  -> s05 tool loop
  -> s13 session + runtime
```

The adapter waits for both a supported `finish_reason` and the terminal `[DONE]` record before emitting `done`. That matters: a half-closed stream must never release a partial tool call for execution.

## Run It First

The tests are completely offline:

```bash
npm run test:s14
```

To run the live capstone, configure an OpenAI-compatible endpoint that supports streaming Chat Completions and function/tool calls:

```bash
cp .env.example .env
# Set OPENAI_API_KEY and OPENAI_MODEL.
# OPENAI_BASE_URL defaults to https://api.openai.com/v1.

npm run session:s14 -- "Read README.md and explain the course in three points"
```

The command loads `.env` through Node's `--env-file-if-exists` flag. It creates the integrated s13 runtime, exposes `read_course_file`, and prints the final model answer. That tool anchors its root to the `learn-pi-agent` module location rather than ambient `cwd`, resolves symlinks, rejects paths outside the course, and accepts only non-hidden, regular UTF-8 files no larger than 50,000 bytes.

No key is needed for any earlier lesson, `npm run test:s14`, or `npm run check`. Only `session:s14` sends a network request.

## How the Code Works

### 1. Configuration stays explicit

`loadOpenAICompatibleConfig()` requires `OPENAI_API_KEY` and `OPENAI_MODEL`. `OPENAI_BASE_URL` defaults to the official `/v1` base URL. Missing values fail before `fetch`, with an error that points back to `.env.example`.

The provider factory also accepts an injected `fetch` and `AbortSignal`. Production uses `globalThis.fetch`; tests use in-memory `Response` objects. Live requests have a 60-second default timeout. The adapter has no SDK and no production dependency.

### 2. Messages are translated by role

`createChatCompletionRequest()` does structured conversion, not JSON-shaped string replacement. Rich assistant blocks become an OpenAI-compatible assistant message:

```ts
{
  role: "assistant",
  content: null,
  tool_calls: [{
    id: "call_1",
    type: "function",
    function: { name: "read_course_file", arguments: "{\"path\":\"README.md\"}" },
  }],
}
```

The corresponding s04/s05 `toolResult` becomes a `tool` message carrying the same `tool_call_id`. That identity is what lets the model connect evidence to the action it requested. When tools are present, the request sets `parallel_tool_calls: false`; the adapter also enforces one tool call per response if a compatible endpoint ignores that request setting.

### 3. SSE parsing respects byte boundaries

`readSseData()` uses one streaming `TextDecoder` and keeps an unfinished text buffer between reads. It emits only complete SSE records. Comments and fields other than `data` do not become provider events; multiple `data:` lines in one record are joined according to SSE rules.

The test splits a Chinese UTF-8 response at one-, two-, and five-byte boundaries. Passing that test demonstrates that transport chunking cannot corrupt a code point or JSON document. A streamed `refusal` is mapped to visible text instead of becoming an empty successful answer.

### 4. Tool calls are accumulated by index

Chat Completions identifies a streamed tool call with an `index`. The first delta creates one s03 content block and emits `toolcall_start`. Later deltas append fragments of `id`, `function.name`, and `function.arguments` to the same accumulator. This capstone accepts one call per response; a second index turns the response into a protocol error before either tool executes.

Only at `finish_reason: "tool_calls"` does `finalizeToolCall()` parse the argument string. It requires a JSON object. The s02 registry then performs its own schema-level checks before invoking the handler. These are separate boundaries: JSON parsing answers “is this a complete object?”, while registry validation answers “is this valid input for this tool?”

### 5. Failures stay visible

`OpenAIProviderError.kind` separates:

| Kind | Example | Adapter behavior |
| --- | --- | --- |
| `authentication` | HTTP 401/403 | include status and provider message |
| `rate_limit` | HTTP 429 | report once; do not retry |
| `http` | any other non-2xx | include status and bounded response detail |
| `network` | connection or body-read failure | preserve the underlying message as the cause |
| `aborted` | `AbortSignal` / `AbortError` | stop with an explicit aborted error |
| `protocol` | malformed JSON, invalid deltas, missing finish or `[DONE]` | reject the incomplete assistant response |

Every failure is normalized into the terminal `ProviderEvent.error` defined in s03. That lets s05 close `message_end` and prevents any partial tool call from executing. The live CLI observes the same error, then exits non-zero after the harness lifecycle has closed; library consumers still receive one coherent event stream rather than a second throw-only channel.

Automatic retry is intentionally absent. A production retry policy needs idempotency, backoff, provider headers, cancellation, and observability. Hiding those decisions inside a first adapter would teach the wrong boundary.

The teaching adapter also puts finite bounds around remote input: one SSE event may hold at most 1,000,000 decoded characters, the full SSE response at most 4,000,000 bytes, and an HTTP error body at most 64,000 bytes. A timeout or limit violation becomes the same terminal error event, and an unfinished reader is cancelled. The live loop allows four model turns; if the fourth response still requests a tool, the CLI reports exhaustion and exits non-zero instead of printing an empty success. These are course-scale guardrails, not production capacity recommendations.

## The Real Tool Loop

The live command does not create a second agent implementation. It calls `createIntegratedHarnessRuntime()` from s13 with the real provider and one confined file-reading registry:

```text
user question
  -> real model requests read_course_file
  -> s14 emits toolcall events
  -> s05 validates and executes the tool
  -> s13 stores assistant + toolResult
  -> s14 converts both into the second API request
  -> real model answers from the file contents
```

That is the course's final acceptance test. The model is real, but the harness is still the one assembled lesson by lesson.

## Try It Yourself

1. Point `OPENAI_BASE_URL` at another compatible endpoint and choose one of its tool-capable models. Run the same question. If it fails, identify whether the difference is HTTP, SSE, message shape, or tool-call semantics.

2. Add a second confined tool such as `list_course_files`. Do not edit the provider or loop. If adding a tool requires either change, revisit the s02 boundary.

3. Pass an `AbortController.signal` to the provider and abort after the first `text_delta`. Confirm that no `done` event or tool execution follows.

4. Add a fixture containing two tool-call indexes even though the request disables parallel calls. Confirm that the adapter emits a protocol error, neither handler runs, and the harness makes no follow-up provider request.

When finished, run `npm run check`. It must remain offline.

## Wiring into the Main Line

| Concern | Reused from | s14 responsibility |
| --- | --- | --- |
| Tool definitions and validation | s02 | serialize the model-visible schema |
| Provider event contract | s03 | emit normalized text/tool events |
| Tool execution and results | s04/s05 | translate results back to API messages |
| Turn context | s06 | serialize system prompt, history, and active tools |
| Session and resources | s07/s08 | no new behavior |
| Extensions and policies | s09/s11 | no new behavior |
| Runtime and integration | s10/s13 | construct and prompt the same runtime |

s14 is a leaf adapter. Earlier chapters do not import it, and the default test path does not need credentials.

## Against the Pi Source

The mapping lives in [pi-source.md](pi-source.md). Start with Pi's OpenAI Chat Completions provider, then follow its normalized events into `agent-loop.ts`. Compare responsibilities, not line count: real Pi handles many model families, reasoning formats, usage, costs, images, and compatibility flags that this teaching adapter intentionally excludes.

The wire-level behavior follows the official [Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat) and [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling). In particular, streamed `tool_calls[index]` deltas are accumulated and their JSON arguments are validated before execution.

## What This Lesson Deliberately Skips

- Responses API and provider-specific APIs
- images, audio, reasoning blocks, and multimodal tool results
- token usage, pricing, and context-window accounting
- parallel retry, fallback models, backoff, and resume
- vendor compatibility flags for non-standard roles or fields
- TLS/proxy configuration and production secret management
- terminal token-by-token rendering

Those omissions are the boundary of the capstone, not claims that production providers are simple.

## Closing

s03 defined what the loop should receive. s13 proved that every harness mechanism composes around that contract. s14 finally shows where the abstraction earns its keep: the network protocol can change from in-memory fixtures to real SSE without rewriting the tool loop.

Offline reproducibility and real-model learning are not opposites. Keep the first as the foundation, and make the second an explicit, inspectable capstone.
