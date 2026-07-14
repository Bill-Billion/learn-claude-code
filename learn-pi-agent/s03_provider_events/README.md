# s03 · Provider Events

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the official `AssistantMessageEvent` stream from `@earendil-works/pi-ai`, before the agent runtime adds its own lifecycle events.

```text
provider bytes -> pi-ai events -> partial message -> final AssistantMessage
```

## The problem

`complete()` is convenient when a caller only needs the final `AssistantMessage`. A runtime also needs to observe work while it happens: text arriving, Tool Call arguments being assembled, a response completing, or a stream failing.

A callback for text alone is not enough. Text and Tool Calls can occupy different content blocks, blocks may be interleaved, and every consumer needs the same terminal message. The protocol must describe the whole Assistant Message, not only printable characters.

## The idea

Use the event protocol that `pi-ai` already exposes:

```text
start
  -> text_start / text_delta / text_end
  -> toolcall_start / toolcall_delta / toolcall_end
  -> done or error
```

Each incremental event carries `contentIndex` and a partial Assistant Message. `done.message` or `error.error` supplies the terminal message. UI rendering, logging, and the Agent Loop can consume the same stream for different purposes.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s03
```

To make both Tool Call events and text events likely in one request, run:

```bash
npm run s03 -- "Use read_file to read package.json, then explain its scripts in two sentences."
```

The exact deltas, Tool Call arguments, and answer can vary. The CLI writes `text_delta` values as they arrive, then returns the assembled final text. The stable contract is the ordered event family and the final Assistant Message, not a particular chunk boundary.

## How the code works

### 1. Consume the official stream

`collectAssistantStream()` calls `stream()` imported from `@earendil-works/pi-ai`:

```ts
for await (const event of streamModel(model, context, streamOptions)) {
  events.push(event);
  onEvent?.(event);
  if (event.type === "done") message = event.message;
  if (event.type === "error") message = event.error;
}
```

The lesson does not translate provider wire data itself. The installed `pi-ai` provider does that work and yields `AssistantMessageEvent` values.

### 2. Preserve events and the terminal message

`CollectedAssistantStream` returns three views of the same response:

```text
events      every AssistantMessageEvent in order
eventTypes  a compact list for inspection
message     the final AssistantMessage
```

If the async iterable ends without `done` or `error`, `collectAssistantStream()` throws. A stream without a terminal message cannot be treated as a completed model turn.

### 3. Keep content blocks addressable

Text and Tool Call deltas include `contentIndex`. Consumers must apply each delta to the matching content block rather than assuming all output is one string. The `partial` snapshot lets an observer render the Assistant Message as it currently stands.

### 4. Stream every model turn in the same loop

`runStreamingAgentLoop()` keeps the s02 Registry and model-tool-model behavior. The only change at the model boundary is that each turn now goes through `collectAssistantStream()`:

```ts
const streamed = await collectAssistantStream({
  model,
  context: { messages: state.messages, tools: runtime.tools },
  streamOptions,
  onEvent,
});
```

After the terminal Assistant Message arrives, the loop appends it, executes any Tool Calls through the Registry, appends Tool Results, and streams the next model turn. Events from all turns are returned in one ordered array.

### 5. Let consumers choose what to display

The CLI's `onEvent` prints only `text_delta`. Another consumer could record Tool Call deltas, render a progress view, or forward the full event object. `readTextBlocks()` extracts completed text blocks from the final message without becoming the streaming protocol itself.

## Try it yourself

1. In `runLiveCli()`, log `event.type` inside `onEvent`. Run a direct question and list the event order around one text block.
2. Run the one-shot file request and watch for `toolcall_start`, one or more `toolcall_delta` events, and `toolcall_end` before the second model turn.
3. Log `contentIndex` for each text and Tool Call event. Confirm that consumers can distinguish blocks without depending on arrival timing or chunk size.

## Wiring into the main line

| Boundary | s02 | s03 |
| --- | --- | --- |
| Model call | `complete()` inside s01 loop | `pi-ai` `stream()` via `collectAssistantStream()` |
| Provider output | Final Assistant Message | Ordered `AssistantMessageEvent[]` plus final message |
| Tool boundary | Registry | Same Registry |
| Loop entry | `runToolRegistryAgentLoop()` | `runStreamingAgentLoop()` |
| Consumer hook | Final result only | `onEvent(event)` during every model turn |

## Against the Pi source

`AssistantMessageEvent`, `Context`, `stream()`, and the terminal message semantics come directly from `@earendil-works/pi-ai` 0.79.1. s03 adds collection and the surrounding course loop; it does not define a second provider protocol.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s04 · Evented Tool Loop](../s04_evented_tool_loop/) wraps these provider events with Agent, Turn, Message, and Tool Execution lifecycle events.
