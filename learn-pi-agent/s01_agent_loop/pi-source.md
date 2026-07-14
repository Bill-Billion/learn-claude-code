# s01 against the Pi 0.79.1 source

s01 uses `@earendil-works/pi-ai` directly and adds the smallest teaching version of Pi's model-tool loop around it.

```text
user -> complete() -> toolCall -> execute -> toolResult -> complete()
```

## Corresponding files

- [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)

## The mapping

| s01 | Pi 0.79.1 |
| --- | --- |
| `complete()` imported from `pi-ai` | `complete()` in `packages/ai/src/stream.ts` |
| `Message`, `ToolCall`, `ToolResultMessage` | the same public types in `packages/ai/src/types.ts` |
| `validateToolCall()` | the same validation entry in `packages/ai/src/utils/validation.ts` |
| `AgentState.messages` | the message history inside `AgentContext` |
| `runAgentLoop()` | the minimal model-tool path through Pi's `runAgentLoop()` / `runLoop()` |
| `readFileTool` | a teaching-sized model-visible `Tool`, conceptually matching the coding-agent read tool |
| `createReadFileToolRuntime()` | the local execution side of an `AgentTool` |

The important boundary is already real: s01 sends Pi `Message[]` and `Tool[]` through Pi's `complete()` function. The course owns only the surrounding loop and its deliberately small file tool.

## What s01 simplifies

Pi's agent loop also provides lifecycle events, context transformation, custom message conversion, steering and follow-up queues, abort handling, tool progress, hooks, and parallel tool execution. Those concerns are separated into later lessons.

s01 makes these narrower choices:

```text
one read-only tool
sequential tool calls
eight model turns as a backstop
course-root file access with hidden-path, symlink, size, and UTF-8 checks
complete() rather than exposing the provider event stream
```

The safety policy around `read_file` belongs to this course implementation; it is not presented as a full copy of Pi's coding-agent read tool.

## Suggested reading order

1. Read `Tool`, `ToolCall`, `ToolResultMessage`, `Message`, and `AssistantMessage` in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts).
2. Read `complete()` in [`packages/ai/src/stream.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/stream.ts).
3. Follow `runAgentLoop()` into `runLoop()` in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts), concentrating on the assistant message, tool calls, tool results, and next turn.
4. Compare the public schema and executable side of the read tool in [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts).

Provider events become visible in s03; agent lifecycle events are added in s04.
