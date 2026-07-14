# s01 · Agent Loop

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the smallest useful path through `pi-ai` and the agent loop, from a user message to a model-selected tool call, a tool result, and the model's final response.

```text
model -> toolCall -> toolResult -> model
```

## The problem

A single model request can return text, but an agent must also handle a request to act. When the model emits a tool call, the application has to execute it, append the result to the message history, and call the model again. Returning the tool output directly to the user would skip the model's chance to interpret that evidence.

The first lesson therefore needs more than a chat wrapper. It needs a loop with an explicit state, a tool boundary, and a stopping rule.

## The idea

Keep one ordered `messages` array and repeat the same operation:

```text
append user message
  -> call model with messages + tools
  -> append assistant message
  -> no toolCall: return
  -> toolCall: execute it and append toolResult
  -> call model again
```

The model chooses whether to call `read_file`. The harness owns the file read, its safety checks, and the message that carries the result back.

## Run it first

Complete the `.env` setup in the [course guide](../README.md), then run this command from `learn-pi-agent/`:

```bash
npm run s01
```

With no argument, the command opens a prompt loop. A one-shot request is useful when you want to repeat the same observation:

```bash
npm run s01 -- "Use read_file to read package.json, then tell me the package name."
```

The exact answer and wording can change because the model chooses the tool call and final response. Follow the stable path instead: the first model turn requests `read_file`, the harness returns a `toolResult`, and the second model turn answers from that result.

## How the code works

### 1. Load a real `pi-ai` model

`runLiveCli()` calls `loadCourseModel()`. It reads `OPENAI_API_KEY` and builds an OpenAI-compatible `Model<"openai-completions">`. `OPENAI_MODEL` defaults to `gpt-4o-mini`, and `OPENAI_BASE_URL` defaults to the official OpenAI API.

### 2. Define one safe tool

`readFileTool` is a real `pi-ai` `Tool`. Its TypeBox schema is the public contract the model sees. `createReadFileToolRuntime()` keeps the executable file-reading handler on the harness side.

The handler accepts only regular UTF-8 files inside the course root. It rejects empty paths, hidden path segments, paths or symlinks that escape the root, non-files, and files larger than 64 KiB.

### 3. Keep the loop state explicit

`AgentState` owns the ordered `Message[]`. `runAgentLoop()` appends the user message before entering the model loop:

```ts
for (let turn = 0; turn < maxTurns; turn++) {
  const assistantMessage = await complete(model, {
    messages: state.messages,
    tools: toolRuntime.tools,
  }, streamOptions);
  state.messages.push(assistantMessage);

  const toolCalls = assistantMessage.content.filter(
    (block) => block.type === "toolCall",
  );
  if (toolCalls.length === 0) {
    return { state, finalMessage: assistantMessage, toolResults };
  }

  for (const toolCall of toolCalls) {
    state.messages.push(await toolRuntime.execute(toolCall));
  }
}
```

The real implementation also passes the system prompt, records every tool result, and returns both the final assistant message and the complete state.

### 4. Turn tool failures into model-visible evidence

`executeToolCallSafely()` converts validation and file errors into `ToolResultMessage` values with `isError: true`. The loop can then continue, giving the model a chance to explain the failure or choose another action. Provider `error` and `aborted` stop reasons are surfaced as exceptions, and the default eight-turn limit prevents an unbounded tool loop.

## Try it yourself

1. Ask the model to read `README.md`, then ask it to read `package.json`. Compare the files named in the answer rather than expecting identical wording.
2. Run `npm run s01 -- "Use read_file to read .env and explain the result."` The tool should reject the hidden path, and the model should receive that failure as a tool result.
3. Temporarily pass `maxTurns: 1` in `runLiveCli()`, then request a file read. The first tool call can run, but the missing follow-up model turn should produce the explicit maximum-turn error.

## Wiring into the main line

| Boundary | s01 implementation |
| --- | --- |
| Model | `loadCourseModel()` plus `pi-ai` `complete()` |
| State | `AgentState.messages` |
| Model-visible tool | `readFileTool` |
| Local execution | `createReadFileToolRuntime()` |
| Loop entry | `runAgentLoop()` |
| Stop | no tool calls, provider failure, or `maxTurns` exhaustion |

s01 deliberately keeps the tool schema and handler in one small runtime object. s02 will separate the model-visible schema from the private handler registry.

## Against the Pi source

The implementation uses `@earendil-works/pi-ai` 0.79.1 directly for `Model`, `Message`, `Tool`, `ToolCall`, `ToolResultMessage`, validation, and `complete()`. The surrounding control flow is a teaching-sized version of Pi's agent loop.

See [pi-source.md](pi-source.md) for the pinned source mapping.

## Next up

[s02 · Tool Schema](../s02_tool_schema/) moves executable handlers behind a registry while exposing only schemas to the model.
