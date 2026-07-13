# s01 against the Pi source

s01 keeps only the minimal shape of Pi's agent loop:

```text
user input
  ↓
messages
  ↓
provider
  ↓
assistant message
  ↓
stopReason
```

## Corresponding files

- [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

## The mapping

| s01 | Pi |
| --- | --- |
| `AgentState.messages` | `AgentContext.messages` |
| `Provider.complete()` | the provider stream inside `streamAssistantResponse()` |
| `runOneTurn()` | the minimal path of `runAgentLoop()` plus `runLoop()` |
| `AssistantMessage.stopReason` | Pi's `AssistantMessage.stopReason` |
| `toolUse` recorded but not executed | Pi proceeds into `executeToolCalls()` |

## What we're skipping for now

Pi's `agent-loop.ts` also handles all of this:

```text
EventStream
transformContext()
convertToLlm()
streaming delta
tool execution
beforeToolCall / afterToolCall
steering messages
follow-up messages
shouldStopAfterTurn()
```

None of that belongs to s01. s01 confirms exactly one thing: the agent loop is not a mysterious structure — it is, first of all, a piece of control flow around messages and stopReason.

Pi's `StopReason` is defined in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts). There, `stop` means a normal finish, and `toolUse` means the assistant message contains tool calls. s01 keeps both values but executes no tools.

## Suggested reading order

Start with the `prompt() Event Sequence` in [`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/README.md).

Then look at these spots in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts):

```text
agentLoop()
runAgentLoop()
runLoop()
streamAssistantResponse()
```

When you hit the provider event stream, feel free to jump ahead to s03. When you hit tool execution, stop — that's s04.
