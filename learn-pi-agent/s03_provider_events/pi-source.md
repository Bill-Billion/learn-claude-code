# Pi source cross-reference for s03

s03 covers only the provider event stream in `pi-ai`.

```text
provider stream
  -> AssistantMessageEvent
  -> partial AssistantMessage
  -> done.message
```

## Relevant files

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/README.md)

Exact anchors:

```text
types.ts:257-263       ToolCall
types.ts:280           StopReason
types.ts:288-301       AssistantMessage
types.ts:338-348       Tool / Context
types.ts:350-370       AssistantMessageEvent
stream.ts:40-75        stream / complete / streamSimple / completeSimple
event-stream.ts:69-87  AssistantMessageEventStream
README.md:374-393      complete event reference and contentIndex warning
```

## How things map

| s03 | Pi |
| --- | --- |
| `ProviderEvent` | `AssistantMessageEvent` |
| `EventProvider.stream()` | the `AssistantMessageEventStream` returned by `streamSimple()` |
| `AssistantMessage.content` | Pi's `AssistantMessage.content` |
| `ToolCall` | Pi's `ToolCall` |
| `contentIndex` | the content block index in Pi's events |
| `collectProviderStream()` | consuming events with `for await ... of stream` |
| `done.message` | the final result of `AssistantMessageEventStream.result()` |

## What this lesson deliberately skips

The s03 code does not implement any of these:

```text
api / provider / model / usage fields
thinking_start / thinking_delta / thinking_end
image content
protocol translation for real providers
validateToolCall()
tool execution and toolResult messages
```

None of this is an oversight. The goal of s03 is to get you reading the provider event stream first. Tool execution starts in s04.

## Suggested reading order

Start with `AssistantMessageEvent` in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts). That section is the most important piece of source for this lesson.

Then read [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts). `AssistantMessageEventStream` does two things: it lets the caller consume events with `for await`, and it stores the final assistant message when `done` or `error` arrives.

Finally, [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts). `completeSimple()` is really just grabbing the stream and awaiting `result()`.
