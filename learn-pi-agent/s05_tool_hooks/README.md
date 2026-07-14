# s05 · Tool Hooks

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: `beforeToolCall` and `afterToolCall` policy around the Tool Execution boundary in `pi-agent-core`.

```text
Tool Call -> before hook -> Handler -> after hook -> Tool Result
```

## The problem

s04 makes Tool Execution observable, but observation alone cannot change behavior. A product may need to block an operation, rewrite approved arguments, annotate a result, mark a failure, or stop before another model Turn.

Putting every rule inside every Handler duplicates policy. Adding product-specific conditions directly to the Agent Loop makes the core hard to reuse. The execution boundary needs narrow extension points before and after the Handler.

## The idea

Wrap default execution with two optional Hooks:

```text
beforeToolCall
  -> block: return an error Tool Result without running the Handler
  -> arguments: replace the arguments used for validation and execution
  -> otherwise continue

executeDefault

afterToolCall
  -> patch content or isError
  -> request terminate
```

The Loop still owns Message order and lifecycle Events. Hooks can influence one Tool Call without becoming a second Agent Loop.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s05
```

A one-shot request through the Hook-capable Loop is:

```bash
npm run s05 -- "Use read_file to read package.json and report the pi-ai version."
```

The default CLI installs no policy Hooks, so this is the baseline path through the new interface. The answer and Tool Call details can vary. In the exercises below, you will add Hooks to the same `runHookedToolLoop()` call and observe how the Tool Result changes.

## How the code works

### 1. Keep Hook return values small

`beforeToolCall` can return:

```ts
{
  block?: boolean;
  reason?: string;
  arguments?: Record<string, unknown>;
}
```

`afterToolCall` can return:

```ts
{
  content?: ToolResultMessage["content"];
  isError?: boolean;
  terminate?: boolean;
}
```

Returning `undefined` means no change. A Hook does not mutate the Registry or Message history directly.

### 2. Pass useful execution context

Both Hooks receive the Assistant Message, Tool Call, effective arguments, and current Messages. The After Hook also receives the Tool Result and its `isError` value. That is enough to make a policy decision without exposing the Loop's local control variables.

### 3. Wrap s04's default executor

The primary entry point takes one options object:

```ts
await runHookedToolLoop({
  model,
  prompt,
  registry,
  hooks: { beforeToolCall, afterToolCall },
});
```

Internally, `createHookExecutor()` becomes s04's `executeToolCall` function. It runs the Before Hook, creates an effective Tool Call if arguments were replaced, and calls `context.executeDefault(effectiveToolCall)` only when execution is allowed.

### 4. Make blocking visible to the model

When the Before Hook returns `{ block: true }`, the Handler is not called. The Hook's `reason` becomes an error `ToolResultMessage`, which is appended and returned to the model through the normal lifecycle.

A blocked call does not run the After Hook because there is no Handler result to finalize.

### 5. Finalize the result after execution

After default execution, `afterToolCall` may replace `content`, change `isError`, or return `terminate: true`. The replacement stays a normal Tool Result Message, so s04 emits the same Tool Execution and Message Events around it.

If `afterToolCall` throws, the Handler has already run. `applyAfterToolCallHook()` preserves the executed Tool Result content, appends `Post-tool hook failed after the tool executed: ...`, marks the Result as an error, and lets the Loop continue. It never retries the Handler or repeats its side effect.

If a Turn contains several Tool Calls, the Loop stops early only when every execution outcome in that batch requests termination. A mixed batch continues to the next model Turn.

## Try it yourself

1. Add a `beforeToolCall` Hook in `runLiveCli()` that blocks `read_file` when `args.path === "README.md"`. Run a request for that file and confirm the model receives your reason instead of file content.
2. Return `{ arguments: { path: "package.json" } }` when the model asks for another path. Confirm that the Handler reads the rewritten path and the Tool Result keeps the original Tool Call ID.
3. Add an `afterToolCall` Hook that prefixes the text content with `audited:`. Then return `terminate: true` and compare the lifecycle with a normal follow-up model Turn.

## Wiring into the main line

| Boundary | s04 | s05 |
| --- | --- | --- |
| Loop entry | `runEventedToolLoop()` | `runHookedToolLoop({ ... })` |
| Default execution | Registry Runtime | `executeDefault()` inside Hook wrapper |
| Before policy | None | Block or replace arguments |
| After policy | None | Patch result or request termination |
| Lifecycle | Agent / Turn / Message / Tool | The same lifecycle, with finalized Tool Results |
| Model access | Real Provider path | The same Real Provider path |

## Against the Pi source

The Hook positions, blocking behavior, result finalization, and batch termination rule map to Pi 0.79.1. The lesson adds a small argument-rewrite field to make pre-execution transformation visible; Pi's exact Hook result types and richer context are documented in the source comparison.

See [pi-source.md](pi-source.md) for the pinned mapping.

## Next up

[s06 · Harness Turn State](../s06_turn_state/) collects Messages, Tools, Resources, Model configuration, and System Prompt into one explicit Turn snapshot.
