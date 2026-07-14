# s05 against the Pi 0.79.1 source

s05 corresponds to the Tool Hook boundaries in `pi-agent-core`.

```text
tool_execution_start
  -> beforeToolCall
  -> execute Tool
  -> afterToolCall
  -> tool_execution_end
  -> Tool Result Message
```

## Corresponding files

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)

## The mapping

| s05 | Pi 0.79.1 |
| --- | --- |
| `ToolHooks.beforeToolCall` | `AgentLoopConfig.beforeToolCall` |
| `{ block: true, reason }` | Pi's `BeforeToolCallResult` blocking path |
| `BeforeToolCallResult.arguments` | a course extension for visible argument rewriting |
| `ToolHooks.afterToolCall` | `AgentLoopConfig.afterToolCall` |
| `{ content, isError, terminate }` | a teaching-sized subset of result finalization |
| `createHookExecutor()` | the policy around Pi's preparation and finalization boundaries |
| `runHookedToolLoop({ ... })` | the hooked path through Pi's `runAgentLoop()` |
| `RunEventedToolLoopResult.terminated` | the early-stop effect of Tool Results that request termination |
| all outcomes must terminate | Pi's mixed-batch rule: mixed batches continue normally |

Pi passes a full `AgentContext` to its Hooks, while the course exposes the current Message list. Pi's After Hook works with the Agent Tool Result before it becomes a Message; the course passes the wrapped `ToolResultMessage` and applies a smaller patch.

## Hook order and ownership

The important order is shared:

```text
validate and prepare call
beforeToolCall
  blocked -> error result, skip Handler
  allowed -> execute Handler
afterToolCall
final Tool Result
```

The Hook layer does not own Message order or lifecycle emission. Those responsibilities remain in the Agent Loop reconstructed in s04. This keeps policy composable around execution.

## Course-specific differences

`BeforeToolCallResult.arguments` is a deliberate course addition. It makes argument rewriting observable by constructing an effective Tool Call before `executeDefault()`. Do not read it as a field copied from Pi 0.79.1's `BeforeToolCallResult`.

The course also omits richer result details, `AbortSignal`, Tool progress, parallel execution, permission UI, and Project Trust. A product may implement permission or audit policy with Hooks, but those product surfaces are not built into the Agent Core Hook itself.

When a Before Hook blocks, the course creates an Error Tool Result and does not call the After Hook. If the course After Hook throws after execution, the already-produced content is preserved, a post-Hook failure note is appended, `isError` becomes true, and the Loop continues without retrying the Handler. This preservation is a course-specific recovery choice. Pi 0.79.1 differs: `finalizeExecutedToolCall()` replaces the executed result with a new Error Result containing the After Hook failure instead of retaining the original content. When After Hooks request termination for a batch, s04 ends before another Provider Turn only if every Tool outcome requests it.

## Suggested reading order

1. Read `BeforeToolCallResult`, `AfterToolCallResult`, and their Context types in [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts).
2. Read the Hook order and mixed-batch termination notes in [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md).
3. Follow Tool Call preparation in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts) to see where a blocked call becomes an Error Result.
4. Follow result finalization to see how After Hook patches and `terminate` are applied before Tool Result Message emission.
