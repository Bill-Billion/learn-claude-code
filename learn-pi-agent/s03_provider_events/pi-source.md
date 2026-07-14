# s03 against the Pi 0.79.1 source

s03 consumes the actual `AssistantMessageEvent` stream exported by `@earendil-works/pi-ai` 0.79.1.

```text
stream(model, context)
  -> AssistantMessageEventStream
  -> AssistantMessageEvent
  -> done.message or error.error
```

## Corresponding files

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts)
- [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/README.md)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)

## The mapping

| s03 | Pi 0.79.1 |
| --- | --- |
| `AssistantMessageEvent` import | the same event union in `packages/ai/src/types.ts` |
| `streamModel()` import | `stream()` in `packages/ai/src/stream.ts` |
| `collectAssistantStream()` | `for await` consumption of `AssistantMessageEventStream` plus terminal-message collection |
| `event.type`, `contentIndex`, `partial` | the official event fields used without translation |
| `done.message` / `error.error` | the official terminal Assistant Message fields |
| `runStreamingAgentLoop()` | the course Agent Loop around the official stream, Registry, and Tool Results |
| `onEvent` | a small consumer callback layered over the same event objects |

s03 does not define a model-facing Provider Event protocol of its own. The live path imports and consumes the package's official types and Stream directly.

## Provider events versus agent events

`pi-ai` events describe one Assistant Message being built:

```text
start
text_* / thinking_* / toolcall_*
done or error
```

`pi-agent-core` wraps that stream in a wider lifecycle for an Agent run, a Turn, Messages, and Tool Execution. s04 reconstructs that outer layer. Keeping the two event families separate is the main source-level boundary in this lesson.

## What s03 adds and simplifies

`collectAssistantStream()` stores events in an array, forwards each one to an optional callback, and remembers the final message. Pi's `AssistantMessageEventStream` also exposes a final result through its Stream abstraction; the course keeps collection explicit so the protocol remains visible.

The lesson CLI displays only text deltas. It does not build a terminal UI, render thinking blocks, display usage, or expose provider-specific wire events. Tool execution still belongs to the course loop rather than `pi-ai`.

## Suggested reading order

1. Read `AssistantMessageEvent` and `AssistantMessage` in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts).
2. Read [`packages/ai/src/utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/event-stream.ts) to see async iteration and final-result storage.
3. Read `stream()` and `complete()` in [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts). The difference explains why s01 could await one message while s03 can observe every event.
4. Then inspect the Provider-to-Agent event conversion in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts), which becomes the subject of s04.
