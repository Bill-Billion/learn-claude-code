# s04 · Evented Tool Loop

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s03](../s03_provider_events/README.md) · [Contents](../README.md) · [s05 →](../s05_tool_hooks/README.md)

> In one sentence: the assistant emits a toolCall, agent-core runs the tool locally, wraps the result into a toolResult message appended to the context, and feeds that into the next provider call.
>
> Where this sits in Pi: `agent-loop.ts` in `@earendil-works/pi-agent-core`, the main tool execution path.

→ `tool_execution_end` fires before the toolResult's `message_start` — "the tool finished running" and "the result becomes a message" are two separate, ordered steps
→ An unknown tool doesn't break the loop: the error becomes a toolResult with `isError: true`, and the model decides on its own next turn what to try instead
→ With multiple toolCalls in one batch, toolResults strictly follow their order of appearance in the assistant message — Pi guarantees this even under parallel execution
→ The loop's exit condition is "no toolCalls this turn"; maxTurns is only a defensive backstop

---

## The problem

s02 covered only tool contracts, s03 only the provider event stream. Each line works on its own, but no tool has actually run even once: the model knows which tools are available and can stream out a call intent character by character, yet the signal s01 left dangling — `stopReason=toolUse` gets recorded into the message and that's it — still has no receiver.

Picking it up means answering three questions: who executes the tool, when does it run, and how does the result get back into the conversation so the model can keep going. This lesson puts a loop in the middle, and the two lines meet there: s02's contracts land as execution, and s03's event stream grows into the agent's lifecycle.

## The idea

When the provider emits `toolcall_end`, the assistant message already contains a complete tool call. agent-core then does three things:

```text
emit tool_execution_start
run the local tool
emit tool_execution_end
```

The execution result doesn't become the final answer directly. It first becomes a `toolResult` message, gets appended to the context, and then goes into the next provider call. Real models work the same way: only after seeing the tool result does the model know what to say next.

Put that process in a loop and you get this lesson's `runEventedToolLoop()`: each turn streams a full assistant message, picks out all the toolCalls, runs them one by one appending results into messages; whichever turn produces zero toolCalls is where the loop ends.

Events also move up a layer. s03's provider events only describe "how one assistant message grows"; this lesson wraps them into agent events:

| Provider event (s03) | Wrapped as agent event (this lesson) |
|------|------|
| `start` | `message_start` |
| `text_*` / `toolcall_*` | `message_update` (original event attached on the `providerEvent` field) |
| `done` / `error` | `message_end` |

On top of that layer come `agent_start/end`, `turn_start/end`, and `tool_execution_start/end`, which fence off the boundary of one turn in Pi:

```text
assistant response
  + tool executions
  + toolResult messages
```

## Run it first

```sh
npm run session:s04
```

The output looks like this:

```text
Events: agent_start -> turn_start -> message_start -> message_update -> message_update -> message_update -> message_end -> tool_execution_start -> tool_execution_end -> message_start -> message_end -> turn_end -> turn_start -> message_start -> message_update -> message_update -> message_update -> message_end -> turn_end -> agent_end
Messages: assistant -> toolResult -> assistant
Tool result: read: README.md
Final text: I saw the tool result.
```

There are two `turn_start`s in the event chain. In the first turn the assistant called `read`, so `message_end` is followed by `tool_execution_start -> tool_execution_end`, and then another `message_start -> message_end` pair — those are the events the toolResult emits as a message in its own right. Note the order: `tool_execution_end` first, the toolResult's `message_start` second. The tool execution lifecycle and the message lifecycle are two separate groups of events, and Pi pins their ordering down.

In the second turn the assistant sees the toolResult, produces the final text, emits no more toolCalls, and the loop ends there.

One more thing worth spelling out: there is no user in `Messages`. This mini loop starts from an empty context, with a fake provider emitting the toolCall directly; Pi's `runAgentLoop()` receives prompts and emits events for the prompt message in the first turn. The details of the difference are in [pi-source.md](pi-source.md).

## How the code works

Four steps.

**Step 1**: the loop skeleton. This function is the core of the lesson and worth pasting in full:

```ts
export async function runEventedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  options: { maxTurns?: number } = {},
): Promise<RunEventedToolLoopResult> {
  const maxTurns = options.maxTurns ?? 4;
  const messages: LoopMessage[] = [];
  const events: AgentEvent[] = [];
  const allToolResults: ToolResultMessage[] = [];

  const emit = (event: AgentEvent) => events.push(event);
  emit({ type: "agent_start" });

  for (let turn = 0; turn < maxTurns; turn++) {
    emit({ type: "turn_start" });
    const assistantMessage = await streamAssistant(provider, registry, messages, emit);
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
    const turnToolResults: ToolResultMessage[] = [];

    for (const toolCall of toolCalls) {
      const result = await executeToolCall(registry, toolCall, emit);
      messages.push(result);
      turnToolResults.push(result);
      allToolResults.push(result);
    }

    emit({ type: "turn_end", message: assistantMessage, toolResults: turnToolResults });

    if (toolCalls.length === 0) {
      break;
    }
  }

  emit({ type: "agent_end", messages });

  return {
    messages,
    events,
    eventTypes: events.map((event) => event.type),
    toolResults: allToolResults,
  };
}
```

The exit condition sits at the bottom of the loop: only `break` when the turn had no toolCalls. `maxTurns` defaults to 4 and is just a backstop — the fake provider won't run away, but a real model could in theory chain tool calls forever; Pi converges naturally on "are there any more toolCalls" and has no such cap, so the mini adds one simple line of defense.

The inner `for...of` executes toolCalls in the order they appear in the assistant content, and toolResults enter messages in that same order. That's not incidental: Pi explicitly promises toolResult messages keep assistant source order, even in parallel execution mode. `code.test.ts` has a test guarding exactly this invariant.

**Step 2**: `streamAssistant()` wraps s03's provider events into agent events. Three branches: `start` becomes `message_start`, the mid-stream increments become `message_update`, and `done` or `error` becomes `message_end`. The middle branch looks like this:

```ts
if (isAssistantUpdate(event)) {
  emit({
    type: "message_update",
    message: cloneAssistantMessage(event.partial),
    providerEvent: event,
  });
  continue;
}
```

The original provider event isn't thrown away — it rides along on the `providerEvent` field. Upper layers that want coarse granularity just count `message_update`s; those that want fine granularity crack open the delta inside.

**Step 3**: `executeToolCall()` actually runs the tool, reconnecting to s02's `dispatchTool()`:

```ts
let message: ToolResultMessage;
try {
  const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: result.content }],
    isError: false,
    timestamp: Date.now(),
  };
} catch (error) {
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    timestamp: Date.now(),
  };
}
```

The provider never sees the handler, but agent-core can find and run one by `toolCall.name` — s02's rule of "contract goes to the model, implementation stays local" finally lands for real right here. The `catch` branch matters just as much: unknown tools and throwing handlers don't interrupt the loop; the error text gets wrapped into a toolResult with `isError: true`, so the model sees what failed next turn and can try a different approach.

The function emits `tool_execution_start` at the top, and at the end emits three events in a fixed order — first announce that execution finished, then let the toolResult take the stage as a message:

```ts
emit({
  type: "tool_execution_end",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  result: message,
  isError: message.isError,
});
emit({ type: "message_start", message });
emit({ type: "message_end", message });
```

**Step 4**: the fake provider. `createToolLoopProvider()` makes exactly one decision:

```ts
const hasToolResult = context.messages.some((message) => {
  return typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult";
});

if (hasToolResult) {
  return createTextProvider([options.finalText]).stream(context);
}
```

If the context has no toolResult yet, emit the tool call first; once it does, produce the final text. Next to it sits `createMultiToolCallProvider(calls, finalText)`, which can pack multiple toolCalls into one assistant message to reproduce the "batch of tools" scenario — "Try it yourself" uses it.

## Try it yourself

Open `s04_evented_tool_loop/code.ts`, edit `runDemo()`, and rerun `npm run session:s04`:

1. Pass `{ maxTurns: 1 }` as the third argument to `runEventedToolLoop()`. `Messages` stops at `assistant -> toolResult` and `Final text` comes out empty — after the first turn's tool execution, the backstop cap cut the follow-up turn right off. Change it to 2 and the behavior comes back.
2. Swap the provider for a multi-tool batch and watch the message order:

   ```ts
   const result = await runEventedToolLoop(
     createMultiToolCallProvider(
       [
         { toolName: "read", args: { path: "README.md" } },
         { toolName: "bash", args: { command: "ls" } },
       ],
       "I saw both results.",
     ),
     createDemoToolRegistry(),
   );
   ```

   `Messages` becomes `assistant -> toolResult -> toolResult -> assistant`, with the two toolResults in the same order as the toolCalls in the assistant content. Swap the two tools in the array and the toolResult order follows — that's the source order invariant.
3. Construct an unknown tool: `createToolLoopProvider({ toolName: "missing", args: {}, finalText: "I can see the error.", allowUnknownTool: true })`. `Tool result` becomes `Unknown tool: missing`, but `Final text` still shows up — the error entered the context, and the loop never broke.

When you're done, run `npm run test:s04` to confirm the lesson's behavioral contracts still hold.

## Wiring into the main line

| Component | Previous lesson | This lesson |
| --- | --- | --- |
| Provider | streams one round of events and stops — only demonstrates how one assistant message grows | called repeatedly inside a loop, receiving the full messages each turn |
| Tools | schema and handler registered, nobody calls them | `dispatchTool()` actually executes by toolCall.name |
| Messages | two roles: user / assistant | toolResult joins: `LoopMessage` holds both assistant and toolResult |
| Events | provider level: `text_delta`, `toolcall_end`… | agent level: `turn_*`, `tool_execution_*`; provider events wrapped inside `message_update` |

## Against the Pi source

Finish this lesson, then read [pi-source.md](pi-source.md).

The mapping in one sentence: `runEventedToolLoop()` corresponds to the main tool path of `runLoop()` in Pi's `agent-loop.ts`, `streamAssistant()` corresponds to `streamAssistantResponse()`, and `executeToolCall()` is the teaching-sized `executeToolCallsSequential()`. Pi's real loop also carries prompts, parallel execution, argument validation, and hooks — hooks are next lesson's topic; the remaining differences are listed in pi-source.md.

## Next up

Right now every toolCall gets executed unconditionally. Reading a sensitive file, running a dangerous command, stamping results for audit — the loop has no insertion point for any of those judgments yet.

[s05 Tool Hooks](../s05_tool_hooks/README.md): Pi leaves one hook before and one after tool execution; interception, rewriting, and early stops all plug in there.
