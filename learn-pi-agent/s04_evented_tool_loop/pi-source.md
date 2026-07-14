# s04 against the Pi 0.79.1 source

s04 wraps the official `pi-ai` Assistant Message stream in the main lifecycle boundaries used by `pi-agent-core`.

```text
agent -> turn -> assistant message -> tool execution -> toolResult message
```

## Corresponding files

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

## The mapping

| s04 | Pi 0.79.1 |
| --- | --- |
| `runEventedToolLoop()` | the main Tool Call path through `runAgentLoop()` / `runLoop()` |
| s03 `collectAssistantStream()` | the stream consumed inside Pi's `streamAssistantResponse()` |
| `AgentEvent` | a teaching-sized subset of Pi's `AgentEvent` union |
| `message_update.providerEvent` | Pi's Agent Event field named `assistantMessageEvent` |
| `createRegistryToolRuntime().execute()` | the prepare, validate, and execute path under `executeToolCalls()` |
| `ToolExecutionContext.executeDefault()` | an explicit course seam around default execution |
| `tool_execution_start/end` | Pi's Tool Execution lifecycle events |
| Tool Result `message_start/end` | Pi's Tool Result Message emission |
| `turn_end` | Pi's completed Turn after Tool Results are recorded |

The course uses Pi's `Message`, `AssistantMessageEvent`, `ToolCall`, and `ToolResultMessage` types directly. Its outer `AgentEvent` type is local because the lesson is reconstructing the Agent Runtime layer.

## Event ownership

The two event families have different owners:

```text
pi-ai
  start, text_*, thinking_*, toolcall_*, done, error

pi-agent-core
  agent_*, turn_*, message_*, tool_execution_*
```

s04 keeps the first family inside `message_update` and emits the second family around the complete Loop. This mirrors the source boundary instead of flattening every event into one list of unrelated strings.

## What s04 simplifies

The course executes Tool Calls sequentially and preserves their source order. Pi also supports per-tool execution modes, parallel execution, Tool progress updates, argument preparation, abort signals, steering messages, and follow-up queues.

The course adds an eight-Turn backstop. Pi's loop instead decides whether to continue from its Tool Call and queue state. The course also carries the User Message in state and `agent_start.prompt`, while Pi's full event sequence can emit lifecycle events for prompt Messages.

`ToolCallExecutor` and `executeDefault()` are small course interfaces used to add s05 Hooks. They map to the preparation and finalization boundaries in Pi rather than to one identically named Pi type.

## Suggested reading order

1. Read `AgentEvent` in [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts).
2. Enter through `runAgentLoop()` and `runLoop()` in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts).
3. Follow `streamAssistantResponse()` to see Provider Events become Message lifecycle events.
4. Follow `executeToolCalls()` through sequential execution and Tool Result emission.
5. Stop at the `beforeToolCall` and `afterToolCall` boundaries; s05 handles them next.
