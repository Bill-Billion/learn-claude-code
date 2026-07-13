# s03 · Provider Events

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s02](../s02_tool_schema/README.md) · [Contents](../README.md) · [s04 →](../s04_evented_tool_loop/README.md)

> In one sentence: instead of waiting for the model to finish a whole string, the provider turns generation into a stream of events that always ends with done or error.
>
> Where this sits in Pi: the `AssistantMessageEvent` stream in `@earendil-works/pi-ai` — the output surface core exposes to the layers above.

→ Events have a full lifecycle: start opens the stream, text_* / toolcall_* each walk through their own start / delta / end, and done or error always closes things out
→ Every event carries a complete partial snapshot, so consumers can stay stateless — any single event is enough to render the current picture
→ Content blocks are not guaranteed to be contiguous: block 0 can get interrupted mid-stream by block 1, and only contentIndex can stitch them back together
→ `ProviderContext` hands the provider the s02 tool contracts along with the systemPrompt; what streams out of the toolcall events is a call intent, not an execution result

---

## The problem

In s01, `provider.complete()` looks like an ordinary function: messages in, assistant message out. Fine for a first lesson, but it's not how Pi works — the model doesn't think up the whole answer in one go, it generates token by token, and if you wait for all of it before returning, the terminal just stares at a blank screen.

What Pi's `pi-ai` gives the layers above is an event stream. Model start, text deltas, tool argument deltas, stop reason — each becomes an event. The same stream has at least three kinds of consumers: the terminal UI renders as bytes arrive, RPC mode writes the same events out as JSONL, and agent-core picks up tool calls once the assistant message completes. Only by switching the output surface from "a return value" to "a stream of events" can those three coexist.

s03 looks at provider events only. No tools get executed.

## The idea

Give the provider a new interface: `stream(context)` returns `AsyncIterable<ProviderEvent>`. Events are layered by role:

| Event | When it fires | What it carries |
|------|------------|--------|
| `start` | stream opens | `partial` |
| `text_start` / `text_delta` / `text_end` | lifecycle of one text block | `contentIndex`, the delta or final text, `partial` |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | lifecycle of one tool call block | `contentIndex`, the delta or final call, `partial` |
| `done` | normal ending | `reason` + the complete `message` |
| `error` | abnormal ending | `reason` + an error `message` |

There's a real design trade-off here: every event carries a complete `partial` — a snapshot of the assistant message so far. It looks wasteful at first; the delta already has the increment, so why ship the full thing too? Because it lets consumers stay stateless: the UI doesn't have to maintain its own "how much have I assembled" buffer, and a consumer that joins mid-stream doesn't need to replay history — any single event is enough to render the current picture. The cost is one clone per event — that's why `cloneMessage()` exists: internally the provider keeps mutating the same partial object, and without a copy before each yield, the old snapshots consumers saved would get rewritten by later mutations.

How the stream ends is a hard contract: either `done` or `error`, no third way out. Consumers rely on that invariant to get the final result.

## Run it first

```sh
npm run session:s03
```

Output:

```text
Text events: start -> text_start -> text_delta -> text_delta -> text_delta -> text_end -> done
Text: Pi streams events.
Tool events: start -> toolcall_start -> toolcall_delta -> toolcall_end -> done
Stop reason: toolUse
Tool call: read {"path":"README.md"}
```

The first line is the full lifecycle of a text stream; the three `text_delta` events match the three chunks in the demo. The third line is a tool call stream: same skeleton, with `toolcall_*` swapped into the middle. Note the last two lines — the stream carries the intent and arguments of a `read` call, but no file was actually read.

## How the code works

**Step 1**: write out the full event type. The current implementation has 9 variants:

```ts
export type ProviderEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "error" | "aborted">; error: AssistantMessage };
```

The first 7 all carry `partial`; `done` and `error` carry the final version. `reason` gets narrowed with `Extract`: done can only be one of the three normal endings, error can only be error or aborted — every legal way for a stream to end is pinned down in a single union type.

**Step 2**: the provider's input also becomes a structured context:

```ts
export type ProviderContext = {
  messages: unknown[];
  tools: ToolDefinition[];
  systemPrompt?: string;
};
```

`tools` holds exactly the output of s02's `listToolDefinitions()`; the provider sees the contract, never the handler. `systemPrompt` is an optional pass-through field — this lesson's tests include one that guards it arriving at the provider untouched.

**Step 3**: the text-stream provider.

```ts
export function createTextProvider(chunks: string[]): EventProvider {
  return {
    async *stream() {
      const partial = createAssistantMessage();
      partial.content.push({ type: "text", text: "" });

      yield { type: "start", partial: cloneMessage(partial) };
      yield { type: "text_start", contentIndex: 0, partial: cloneMessage(partial) };

      for (const chunk of chunks) {
        const block = partial.content[0] as TextContent;
        block.text += chunk;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: chunk,
          partial: cloneMessage(partial),
        };
      }

      const text = (partial.content[0] as TextContent).text;
      yield { type: "text_end", contentIndex: 0, content: text, partial: cloneMessage(partial) };
      yield { type: "done", reason: "stop", message: cloneMessage(partial) };
    },
  };
}
```

The full lifecycle is all there: `start` opens, `text_start` announces block 0, the loop emits one `text_delta` per appended chunk, `text_end` delivers the finished block, and `done` closes. Every yield goes through `cloneMessage(partial)` — the snapshot isolation from "The idea" lands on that one line.

**Step 4**: the tool-call-stream provider. It starts by checking `context.tools` for the contract:

```ts
export function createToolCallProvider(name: string, args: Record<string, unknown>): EventProvider {
  return {
    async *stream(context) {
      if (!context.tools.some((tool) => tool.name === name)) {
        const error = createAssistantMessage();
        error.stopReason = "error";
        yield { type: "start", partial: cloneMessage(error) };
        yield { type: "error", reason: "error", error };
        return;
      }
```

If the tool isn't in the contract list, the stream goes straight to an error ending — and note that even on failure, the "there is always a closing event" contract holds. The second half is omitted here (full code in code.ts) and is structurally identical to the text stream: `toolcall_start` opens the block, `toolcall_delta` streams argument increments (the demo emits the whole `JSON.stringify(args)` in one shot; a real provider would slice that JSON into many pieces), `toolcall_end` delivers the complete `ToolCall { id, name, arguments }`, and `done` closes with `reason: "toolUse"`.

**Step 5**: the interleaved stream. Pi's docs warn explicitly: events for one content block are not guaranteed to arrive back to back. `createInterleavedProvider()` turns that sentence into a runnable example. The event order is:

```text
start
text_start  index=0
text_delta  index=0  "first "
text_start  index=1
text_delta  index=1  "second "
text_delta  index=0  "block"
text_end    index=0  "first block"
text_delta  index=1  "block"
text_end    index=1  "second block"
done
```

Block 0 gets halfway through, block 1 cuts in, then block 0 comes back to finish. A consumer that naively concatenates deltas in arrival order ends up with something like "first second blockblock". That's why every content event carries a `contentIndex` — assemble each block under its own index:

```text
0 -> first block
1 -> second block
```

**Step 6**: consumption. `collectProviderStream()` is just a `for await` loop: `text_delta` gets appended into a Map keyed by contentIndex, `toolcall_end` collects complete ToolCalls, `done` / `error` records the final message; `readTextBlocks()` then pulls the text blocks out of the final version. If the loop finishes without a message, it throws `Provider stream ended without done or error event` — the closing contract isn't just documentation, it's a checkable assertion, and a provider that never closes gets caught right here.

## Try it yourself

1. In `createTextProvider()`, change the `cloneMessage(partial)` in the `text_delta` yield to a bare `partial`, then add `console.log(JSON.stringify(textResult.events[2]))` (the first text_delta) to `runDemo()`. Before the change, that snapshot holds only "Pi "; after, it becomes the full "Pi streams events." — the early snapshot got rewritten by later mutations, which is exactly why every yield clones.
2. In the demo, change the tool name in `createToolCallProvider("read", ...)` to `"delete"`, which doesn't exist in the registry, and run `npm run session:s03`. The tool stream shrinks from five events to `start -> error`, and the stop reason becomes error — if the contract doesn't have it, the stream won't pretend the model called a tool that doesn't exist.
3. Add a section to `runDemo()`: collect a stream with `collectProviderStream(createInterleavedProvider(), { messages: [], tools: [] })` and print `textByIndex`. Then go into `createInterleavedProvider()`, swap the emission order of the two `text_delta`s for index=0 and index=1 (each along with the mutation line right before it), and rerun — as long as contentIndex is labeled correctly, both text blocks come out of the Map fully intact.

When you're done, run `npm run test:s03` to confirm the lesson's behavioral contracts still hold.

## Wiring into the main line

| Component | Previous lesson | This lesson |
| --- | --- | --- |
| Provider interface | s01's `complete()`: returns a whole assistant message in one shot | `stream(context)` returns `AsyncIterable<ProviderEvent>`, from start to done/error |
| Tool contract | `listToolDefinitions()` extracts the contract, but nobody receives it yet | packed into `ProviderContext.tools`; the provider uses it to emit `toolcall_*` events |
| toolCall | just one blunt signal, `stopReason: "toolUse"` | structured `{ id, name, arguments }`, taken from `toolcall_end` |
| systemPrompt | none | optional field on `ProviderContext`, passed through to the provider untouched |

## Against the Pi source

Finish this lesson, then read [pi-source.md](pi-source.md).

The mapping in one sentence: `ProviderEvent` corresponds to `AssistantMessageEvent` in pi-ai's `types.ts`; `EventProvider.stream()` corresponds to the `AssistantMessageEventStream` returned by `streamSimple()` — you can `for await` it, and it also stores the final result when done/error arrives, effectively building `collectProviderStream()` right into the stream object. Pi's event family also has `thinking_*` and more fields; the full list with per-item anchors is in pi-source.

## Next up

The event stream now shows complete toolCalls — name, arguments, id, all there — and the s02 registry has matching handlers waiting, but the two ends aren't connected yet.

[s04 Evented Tool Loop](../s04_evented_tool_loop/README.md): wire `toolcall_end` up to local tool execution — that's when `tool_execution_start`, `tool_execution_end`, and toolResult messages appear.
