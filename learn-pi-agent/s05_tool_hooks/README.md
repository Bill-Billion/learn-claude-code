# s05 · Tool Hooks

English · [中文](README.zh.md) · [日本語](README.ja.md)

[← s04](../s04_evented_tool_loop/README.md) · [Contents](../README.md) · [s06 →](../s06_turn_state/README.md)

> In one sentence: the tool execution path has two hooks — beforeToolCall decides whether this call runs at all, afterToolCall decides what shape the result takes when it enters the context.
>
> Where this sits in Pi: `AgentLoopConfig.beforeToolCall / afterToolCall` in `@earendil-works/pi-agent-core`.

→ block is not a silent skip: the handler doesn't run, but the model still receives a toolResult with `isError: true` and can change course next turn
→ terminate has every semantics: the loop only truly stops when every result in a toolCall batch asks for an early stop; mixed batches proceed to the next turn as usual
→ The mini and Pi genuinely differ on afterToolCall: Pi hands over an execution result that isn't a message yet, the mini hands over the `ToolResultMessage` directly
→ Permissions, auditing, dangerous-command interception all plug in at these two points — Pi doesn't hard-code any of those judgments into the kernel

---

## The problem

s04's loop executes any toolCall it gets, without hesitation. Use it for real and you immediately hit three situations.

Some calls shouldn't run at all. Reading a sensitive path, say, or running a dangerous command.

Some results need a touch-up before the model sees them. Adding an audit stamp, stripping fields that shouldn't be exposed, or reclassifying a success as an error.

And some tools should end the run once they finish. `notify_done`, for example, has already delivered the result to an external system — having the model tack on a summary afterward is pointless.

What these three judgments share: they all depend heavily on which tool, what arguments, and what came out — they vary by scenario and don't belong hard-coded in the loop kernel. Pi's approach is to leave two sockets on the execution path and push the judgment outside.

## The idea

Two hooks sit at fixed points on the tool execution path:

```text
tool_execution_start
  -> beforeToolCall     before the handler runs
  -> local handler
  -> afterToolCall      after the handler finishes, before toolResult events fire
  -> tool_execution_end
  -> toolResult message
```

| Socket | When | What it can do |
|------|------|---------|
| `beforeToolCall` | before the handler runs | return `{ block: true, reason }`: the handler doesn't run, reason becomes an error toolResult |
| `afterToolCall` | after the handler finishes | patch `content` / `isError`; return `terminate: true` to ask for a stop once done |

Neither hook changes the event structure. A blocked call still gets its `tool_execution_start/end` and the toolResult's message events — an outside observer still sees one complete execution record, just with the result marked as an error.

## Run it first

```sh
npm run session:s05
```

The output looks like this:

```text
Blocked result: read is disabled in this lesson
Patched result: audited: read: README.md
Terminated: true
Messages: assistant -> toolResult
```

The demo runs three scenarios back to back.

The first line is pre-execution interception: `beforeToolCall` returns block, the handler never ran (the registry's call counter is still 0), but the toolResult the model receives spells out the reason.

The second line is post-execution rewriting: the handler runs normally and produces `read: README.md`, `afterToolCall` prepends `audited: `, and it's the patched version that enters the context.

The last two lines are the early stop: `afterToolCall` returns `terminate: true`, messages stop at `assistant -> toolResult`, and there is no second assistant message — the automatic follow-up turn got skipped.

## How the code works

Four steps.

**Step 1**: the hook types. What each hook can return is spelled out in full in the signatures:

```ts
export type BeforeToolCallResult = {
  block?: boolean;
  reason?: string;
};

export type AfterToolCallResult = {
  content?: TextContent[];
  isError?: boolean;
  terminate?: boolean;
};
```

Every field is optional, and a hook can also just return `undefined` to mean "no intervention" — a hook that returns nothing is the same as no hook at all. The context a hook receives is worth a look too:

```ts
export type HookContext = {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  messages: LoopMessage[];
};

export type AfterHookContext = HookContext & {
  result: ToolResultMessage;
  isError: boolean;
};
```

Judging by tool name, by arguments, even by the current conversation history — the material is all right here.

**Step 2**: the execution path. The trunk of `executeToolCallWithHooks()` is one if/else:

```ts
const beforeResult = await hooks.beforeToolCall?.(hookContext);
let message: ToolResultMessage;
let terminate = false;

if (beforeResult?.block) {
  message = createToolResultMessage(toolCall, beforeResult.reason || "Tool execution was blocked", true);
} else {
  message = await runLocalTool(registry, toolCall);
  const afterResult = await hooks.afterToolCall?.({
    ...hookContext,
    result: message,
    isError: message.isError,
  });

  if (afterResult) {
    message = {
      ...message,
      content: afterResult.content ?? message.content,
      isError: afterResult.isError ?? message.isError,
    };
    terminate = afterResult.terminate ?? false;
  }
}
```

In the block branch the handler is never invoked, yet a toolResult with `isError: true` still comes out. Pi thinks the same way: the tool didn't execute, but the model sees an error result and can try something else next turn.

In the else branch, the `result` handed to `afterToolCall` is the already-wrapped `ToolResultMessage` — a simplification the mini makes to shave off one type. Pi, at the same spot, hands over an `AgentToolResult`: an execution result that hasn't become a message yet, wrapped into a message by Pi only after patching. Don't let the mini's shortcut throw you off when reading Pi's source; the difference is recorded in [pi-source.md](pi-source.md).

Patching is per-field: `afterResult.content ?? message.content` — any field the hook doesn't mention stays as-is. Real Pi also supports patching `details`; s05 skips that for now.

**Step 3**: terminate's batch semantics. This is the easiest spot in the lesson to get wrong by assumption. The loop collects it like this:

```ts
// Pi only stops early when EVERY finalized tool result in the batch sets
// terminate; mixed batches continue normally.
let shouldTerminateTurn = toolCalls.length > 0;

for (const toolCall of toolCalls) {
  const finalized = await executeToolCallWithHooks(registry, assistantMessage, toolCall, messages, hooks, emit);
  messages.push(finalized.message);
  turnToolResults.push(finalized.message);
  allToolResults.push(finalized.message);
  shouldTerminateTurn = shouldTerminateTurn && finalized.terminate;
}
```

`shouldTerminateTurn` starts from "this batch is non-empty" and each result's terminate gets ANDed on. In other words, a single tool saying "stop after me" doesn't count: only when every result in a batch of toolCalls asks to terminate does the loop exit early; mixed batches (some want to stop, some don't) proceed into the next turn as usual. In Pi's own words: "The loop only stops early when every finalized tool result in that batch sets `terminate: true`. Mixed batches continue normally." (`agent/README.md:113`)

The exit gains one more break compared to s04:

```ts
if (toolCalls.length === 0) {
  break;
}
if (shouldTerminateTurn) {
  terminated = true;
  break;
}
```

The demo has just one toolCall, so that one asking to terminate makes it the whole batch — hence `Terminated: true`.

**Step 4**: how hooks get installed. `runHookedToolLoop()` takes one more parameter than the s04 loop:

```ts
export async function runHookedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  hooks: ToolHooks = {},
  options: HookedToolLoopOptions = {},
): Promise<HookedToolLoopResult> {
```

The demo's first scenario passes exactly a minimal hook object:

```ts
beforeToolCall() {
  return { block: true, reason: "read is disabled in this lesson" };
},
```

Pass no hooks and it is the s04 loop — behavior identical.

## Try it yourself

Open `s05_tool_hooks/code.ts`, edit `runDemo()`, and rerun `npm run session:s05`. The first two experiments need multi-tool batches: add `createDemoToolRegistry` (from s02) and `createMultiToolCallProvider` (from s04) to the imports at the top of the file — `code.test.ts` uses them exactly that way.

1. Write a beforeToolCall that blocks only `bash`, not `read`:

   ```ts
   const selective = await runHookedToolLoop(
     createMultiToolCallProvider(
       [
         { toolName: "read", args: { path: "README.md" } },
         { toolName: "bash", args: { command: "ls" } },
       ],
       "I saw the mixed results.",
     ),
     createDemoToolRegistry(),
     {
       beforeToolCall({ toolCall }) {
         return toolCall.name === "bash" ? { block: true, reason: "bash is disabled" } : undefined;
       },
     },
   );

   console.log(selective.toolResults.map((result) => `${result.toolName}: ${result.isError}`));
   ```

   read runs normally, bash gets blocked into an error toolResult, both enter the context, and the loop proceeds to the final text as usual. Per-tool tiered permissions in real setups have exactly this shape.
2. Verify the every semantics with your own hands. Same two-tool batch, but swap the hook for one that returns terminate only for read:

   ```ts
   afterToolCall({ toolCall }) {
     return toolCall.name === "read" ? { terminate: true } : undefined;
   },
   ```

   `terminated` is false and the final text still appears — half a batch's terminate doesn't count. Now delete the condition so every call returns `{ terminate: true }`: `terminated` flips to true, and messages stop at `assistant -> toolResult -> toolResult`.
3. In the demo's second scenario, add an `isError: true` to the patch (keep the content line). After the run, the body of `Patched result` is unchanged, but printing `patched.toolResults[0]?.isError` gives true — contrast with the first scenario: block is "never ran, reported as an error"; this is "ran, then the result got reclassified as an error", with the handler's real output still sitting in the body.

When you're done, run `npm run test:s05` to confirm the lesson's behavioral contracts still hold.

## Wiring into the main line

| Component | Previous lesson | This lesson |
| --- | --- | --- |
| Tool execution | `executeToolCall()`: runs the toolCall the moment it gets one | `executeToolCallWithHooks()`: asks beforeToolCall first, then decides whether to run |
| toolResult | handler output (or error) becomes the message as-is | afterToolCall can patch content / isError before it's finalized |
| Loop exit | only checks whether this turn had toolCalls | one more rule: a batch whose results all ask to terminate stops early |
| Loop entry | `runEventedToolLoop(provider, registry, options)` | `runHookedToolLoop(provider, registry, hooks, options)`, and the result gains `terminated` |

## Against the Pi source

Finish this lesson, then read [pi-source.md](pi-source.md).

The mapping in one sentence: the mini's if/else splits into two functions in Pi — `prepareToolCall()` handles `beforeToolCall` (on block, fabricate an error result and skip execution), `finalizeExecutedToolCall()` handles `afterToolCall` (per-field patching); the every semantics is literally an `every()` inside `shouldTerminateToolBatch()`. The hook context field differences and the boundary between `AgentToolResult` and message are all recorded in pi-source.md.

## Next up

Hooks govern the life and death of a single tool call. Step back one level: before a turn's request even starts, the agent still has a pile of things to settle — which tools the model sees this turn, what the system prompt is, which resources are available.

[s06 Turn State](../s06_turn_state/README.md): before each turn's request, Pi first takes a state snapshot from the session, the tool table, resources, and model config.
