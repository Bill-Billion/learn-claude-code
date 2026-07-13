# s14 Against the Pi Source

s14 corresponds to Pi's OpenAI Chat Completions provider boundary. The course snapshot remains pinned to `@earendil-works/pi-ai` 0.79.1 at commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`.

## Relevant Files

- [`packages/ai/src/providers/openai-completions.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/openai-completions.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/harness/agent-harness.ts)
- [`packages/coding-agent/docs/custom-provider.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/custom-provider.md)

## What to Find

In `openai-completions.ts`, follow four responsibilities rather than looking for a class with the same name as this lesson:

1. context and tool definitions converted into Chat Completions request messages;
2. streaming response deltas converted into Pi `AssistantMessageEvent` values;
3. tool-call ids, names, and argument strings accumulated into complete calls;
4. provider/model compatibility handled before normalized events leave `pi-ai`.

Then follow the normalized stream through `stream.ts` and `event-stream.ts` into `agent-loop.ts`. The provider does not execute a coding tool. It only produces the same model-facing message and event types that every other Pi provider must produce. Tool validation, hook dispatch, execution, and tool-result insertion stay in the agent layer.

## Mapping

| s14 | Pi |
| --- | --- |
| `createOpenAICompatibleProvider()` | the OpenAI Chat Completions streaming provider |
| `createChatCompletionRequest()` | Pi's context/message/tool conversion before the provider call |
| `readSseData()` | transport parsing performed by the OpenAI client/stream boundary |
| tool accumulator keyed by `index` | streamed tool-call assembly in the completions provider |
| `ProviderEvent` output | Pi's normalized `AssistantMessageEvent` stream |
| `OpenAIProviderError` | the provider/stream error path before agent execution |
| `createLiveHarnessRuntime()` | provider selection wired into the existing harness/session assembly |

## Deliberate Differences

Real Pi's provider supports a much larger compatibility surface: different model families, system/developer-role behavior, reasoning formats, images, usage and cost accounting, context overflow detection, provider-specific fields, and SDK-level abort/error behavior. s14 keeps only the text and function-call path needed to expose the protocol boundary.

s14 also parses SSE directly with Node streams so byte framing remains visible to the learner. Pi uses maintained provider/client integrations and compatibility code because production support is a different problem from demonstrating the invariant.

The confined `read_course_file` tool is course code, not a Pi provider feature. It exists only to make the live model -> tool -> result -> model loop observable without giving the capstone arbitrary filesystem or shell access.

## Suggested Reading Order

Start with the request and stream conversion in [`openai-completions.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/openai-completions.ts). Keep [`types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts) open beside it so every provider-specific delta can be compared with the normalized event it produces.

Next read [`event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts) and [`stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts). Finish in [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts), where normalized events become assistant messages and tool calls enter the execution path.
