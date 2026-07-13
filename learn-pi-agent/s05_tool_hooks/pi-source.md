# Pi source cross-reference for s05

s05 corresponds to the tool hooks in `pi-agent-core`.

```text
tool_execution_start
  -> beforeToolCall
  -> execute tool
  -> afterToolCall
  -> tool_execution_end
  -> toolResult message
```

## Relevant files

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)

Exact anchors:

```text
types.ts:49-58        BeforeToolCallResult
types.ts:60-81        AfterToolCallResult
types.ts:83-108       hook context types
types.ts:256-262      beforeToolCall config entry (signature at line 262)
agent-loop.ts:562-626 prepareToolCall()
agent-loop.ts:665-708 finalizeExecutedToolCall()
agent/README.md:111-113 hook order and terminate behavior
agent/README.md:196-210 config examples
```

## How things map

| s05 | Pi |
| --- | --- |
| `ToolHooks.beforeToolCall` | `AgentLoopConfig.beforeToolCall` |
| `ToolHooks.afterToolCall` | `AgentLoopConfig.afterToolCall` |
| `{ block: true, reason }` | Pi's `BeforeToolCallResult` |
| `{ content, isError, terminate }` | a teaching-sized `AfterToolCallResult` |
| `runHookedToolLoop()` | the hooked tool path of `runAgentLoop()` |
| `terminated` | the `terminate` hint on Pi's tool result |
| early stop only when the whole batch terminates | the `every()` check at `agent-loop.ts:544-546` |

Two field-level differences: Pi's hook context passes `context: AgentContext` (`types.ts:92, 107`) where the mini uses `messages: LoopMessage[]`; and Pi's `afterToolCall` receives an `AgentToolResult` (not yet a message) where the mini hands over the wrapped `ToolResultMessage` directly.

## What this lesson deliberately skips

s05 does not implement any of these:

```text
TypeBox argument validation before beforeToolCall is invoked
AbortSignal
patching the details field
parallel tool execution
permission popup
project trust
```

The batch semantics of terminate the mini already matches Pi: the loop only stops early when every result in a batch of toolCalls asks to terminate, and mixed batches proceed to the next turn as usual (Pi `agent/README.md:113`, "Mixed batches continue normally").

These live at a different layer. Pi's `beforeToolCall` can be used for permissions or auditing, but a permission UI is not a built-in mechanism of agent-core. We come back to this boundary later, in Trust And Execution Env.

## Suggested reading order

Start with `BeforeToolCallResult` and `AfterToolCallResult` in [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts). They define what a hook can return.

Then read `prepareToolCall()` in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts). When `beforeToolCall` returns block, Pi creates an error result and skips the tool.

Finally, `finalizeExecutedToolCall()`. When `afterToolCall` returns a patch, Pi replaces the tool result field by field.
