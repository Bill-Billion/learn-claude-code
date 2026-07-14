# s04 · Evented Tool Loop

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the Agent, Turn, Message, and Tool Execution lifecycle wrapped around the official `pi-ai` provider stream.

```text
Agent lifecycle
  -> Turn lifecycle
     -> Message lifecycle
     -> Tool Execution lifecycle
```

## The problem

s03 exposes everything that happens while one Assistant Message is generated. An Agent run is wider than one provider response. It can contain several model turns, Tool Calls, Tool Results, errors, and a final answer.

If a runtime forwards only Provider Events, consumers cannot reliably answer broader questions: when did the Agent run begin and end, which events belong to one Turn, when did a Tool actually execute, and when was its Tool Result added as a Message?

## The idea

Keep the same model-tool-model loop and add a second event layer around it:

```text
agent_start
  turn_start
    message_start / message_update / message_end   assistant
    tool_execution_start / tool_execution_end
    message_start / message_end                    toolResult
  turn_end
  ... next turn ...
agent_end
```

Provider Events remain available inside `message_update`. Agent Events describe the larger runtime lifecycle without changing the Provider protocol.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s04
```

A one-shot request that exercises two model turns is:

```bash
npm run s04 -- "Use read_file to read README.md, then summarize the Learning Path section."
```

The final answer and the number of Provider deltas can vary. The stable behavior is the lifecycle nesting: one Agent run contains one or more Turns, Assistant and Tool Result Messages are delimited, and each completed default Tool execution has start and end events.

The CLI prints the final text. The returned `events` array and optional `onEvent` callback expose the lifecycle for another shell or observer.

## How the code works

### 1. Define events at the runtime level

`AgentEvent` separates four concerns:

```text
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_end
```

Events carry their relevant data: Turn numbers, partial or final Messages, Provider Events, Tool Calls, and Tool Results. Consumers no longer have to infer the runtime phase from raw text.

### 2. Open and close the Agent lifecycle once

`runEventedToolLoop()` appends the User Message, emits `agent_start`, and enters a `try` block. `closeLifecycle()` is idempotent, so normal completion, explicit termination, provider failure, and maximum-turn exhaustion all close with one `agent_end`.

### 3. Translate one provider stream into Message events

Each Turn calls s03's `collectAssistantStream()`. The callback maps the official events:

```ts
if (providerEvent.type === "start") {
  emit({ type: "message_start", turn, message: providerEvent.partial });
} else if (providerEvent.type !== "done" && providerEvent.type !== "error") {
  emit({
    type: "message_update",
    turn,
    message: providerEvent.partial,
    providerEvent,
  });
}
```

When collection finishes, the terminal Assistant Message is appended to state and emitted as `message_end`.

### 4. Give Tool execution its own lifecycle

On the default execution path, each Tool Call emits `tool_execution_start`, runs the Registry Handler, appends the Tool Result, and emits `tool_execution_end`. The loop then emits `message_start` and `message_end` for that Tool Result Message. An injected executor that throws is handled by the outer Agent lifecycle and therefore closes with `agent_end` before an execution-end event.

Multiple Tool Calls execute sequentially in Assistant Message order. Unknown tools and Handler failures remain error Tool Results, so the next model Turn can react to them.

### 5. End a Turn only after its results are recorded

`turn_end` includes the terminal Assistant Message and the Tool Results produced during that Turn. If there are no Tool Calls, the Agent ends normally. Otherwise, the Tool Results become context for the next Turn.

The optional `executeToolCall` boundary receives a `ToolExecutionContext` and an `executeDefault()` function. s05 uses this extension point to add policy around execution without rewriting the Loop.

## Try it yourself

1. Pass `onEvent: (event) => console.log(event.type)` from `runLiveCli()`. Run a direct question and a file-reading request, then compare their Turn counts.
2. Ask the model to read two named files. Confirm that each Tool Call has its own execution events and that Tool Results preserve the model's source order.
3. Temporarily set `maxTurns: 1` and request a file read. Confirm that the explicit limit error still leaves `agent_end` as the final lifecycle event.

## Wiring into the main line

| Boundary | s03 | s04 |
| --- | --- | --- |
| Provider events | Official `AssistantMessageEvent` | Preserved inside `message_update` |
| Runtime events | None | `AgentEvent` lifecycle |
| Loop entry | `runStreamingAgentLoop()` | `runEventedToolLoop()` |
| Tool execution | Registry Runtime | Same execution, wrapped in start/end events |
| Extension point | `onEvent` observes provider output | `onEvent` observes runtime; `executeToolCall` wraps execution |
| Completion | Final Assistant Message | Final message plus a closed Agent lifecycle |

## Against the Pi source

s04 reconstructs the main lifecycle shape of `pi-agent-core` around the same official `pi-ai` stream. The course event payloads are smaller, but Agent, Turn, Message, and Tool Execution remain distinct boundaries.

See [pi-source.md](pi-source.md) for the pinned Pi 0.79.1 mapping.

## Next up

[s05 · Tool Hooks](../s05_tool_hooks/) uses the execution extension point to add `beforeToolCall` and `afterToolCall` policy.
