# Pi source cross-reference for s04

s04 corresponds to the main tool execution path in `pi-agent-core`.

```text
assistant message with toolCall
  -> execute tool
  -> toolResult message
  -> next provider turn
```

## Relevant files

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)

Exact anchors:

```text
agent-loop.ts:192-218  stream assistant, find tool calls, append tool results, emit turn_end
agent-loop.ts:275-367  streamAssistantResponse()
agent-loop.ts:373-388  executeToolCalls()
agent-loop.ts:395-449  executeToolCallsSequential()
agent-loop.ts:562-626  prepareToolCall()
agent-loop.ts:628-663  executePreparedToolCall()
agent-loop.ts:717-742  tool_execution_end and toolResult message events
types.ts:403-418       AgentEvent
ai/types.ts:303-311    ToolResultMessage
```

## How things map

| s04 | Pi |
| --- | --- |
| `runEventedToolLoop()` | the minimal tool path of `runAgentLoop()` / `runLoop()` |
| `streamAssistant()` | `streamAssistantResponse()` |
| `AgentEvent` | Pi's `AgentEvent` |
| `executeToolCall()` | the teaching-sized `executeToolCallsSequential()` |
| `ToolResultMessage` | Pi's `ToolResultMessage` |
| `tool_execution_start/end` | Pi's tool execution lifecycle events |
| `message_start/end(toolResult)` | Pi's `emitToolResultMessage()` |

## What this lesson deliberately skips

s04 does sequential execution only. Real Pi also includes:

```text
user / prompt messages: Pi's runAgentLoop() receives prompts and emits
  message_start/end for the prompt message in the first turn; the s04 loop
  starts from an empty context, which no real provider would accept
parallel tool execution
per-tool executionMode
TypeBox argument validation
prepareArguments
AbortSignal
tool_execution_update
beforeToolCall / afterToolCall
terminate=true stopping further provider turns early
steering / follow-up message queue
maxTurns: the mini uses maxTurns=4 as a backstop; Pi converges naturally
  on hasMoreToolCalls and has no such cap
```

One rename to watch for: the mini's `message_update` event carries a field named `providerEvent`; Pi's field in the same position is called `assistantMessageEvent` (`agent/src/types.ts:413`).

All of this gets unpacked in later lessons. s04 answers only one question: once the assistant emits a toolCall, how does the result get back into messages.

## Suggested reading order

Enter through `agentLoop()` (line 31) and `runAgentLoop()` (line 95) in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/agent-loop.ts), then land on lines 192-218 — that stretch is the body of the tool loop inside `runLoop()`.

Then read lines 275-367. This is where `pi-ai`'s provider events get converted into agent events.

Finally, lines 395-449 and 717-742. That's where you can see how Pi executes tools, emits `tool_execution_end`, and wraps the execution result into a `toolResult` message.
