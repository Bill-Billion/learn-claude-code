# s02 against the Pi source

s02 only covers the static shape of a tool:

```text
tool name
tool schema
handler
registry
```

## Corresponding files

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/index.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)
- [`packages/coding-agent/src/core/tools/bash.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/bash.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)

Specific anchors:

```text
ai/src/types.ts:338-342               Tool (only name / description / parameters)
ai/src/providers/anthropic.ts:1187-1203  convertTools(): serialization keeps only these three fields
tools/index.ts: ToolName / allToolNames
tools/index.ts: createTool()
agent/src/types.ts:361-384            AgentTool (the runtime object carrying label and execute)
```

## The mapping

| s02 | Pi |
| --- | --- |
| `ToolDefinition` | pi-ai's `Tool` (the model-visible contract: only name / description / parameters) |
| `RegisteredTool` | `AgentTool` (the runtime object; `label` and `execute()` both live on this side) |
| `RegisteredTool.handler` | `AgentTool.execute()` |
| `createDemoToolRegistry()` | `createCodingTools()` / `createAllTools()` |
| `listToolDefinitions()` | the provider serialization layer, e.g. anthropic's `convertTools()` |
| `dispatchTool()` | maps to `executeToolCalls()` only from s04 on |

One mapping that's easy to get wrong: coding-agent also has a type called `ToolDefinition` (returned by `createCodingToolDefinitions()`), but that one is the **full runtime definition carrying `execute()`, `promptSnippet`, and `renderCall`** — a different thing from s02's model-visible contract with the handler stripped off. In Pi, the step that actually keeps only name/description/parameters is the provider-side `convertTools()`.

## The real tool set in Pi

The tool names currently built into Pi's coding-agent:

```text
read
bash
edit
write
grep
find
ls
```

s02 implements only `read` and `bash`. `read` reads no file, and `bash` executes no command. That keeps the relationship between schema and handler easy to see first.

## Differences from Pi

In Pi, `label` is a UI display field (the comment at `agent/src/types.ts:362-363` says "Human-readable label for UI display"), and provider serialization never sends it. That's why s02 keeps `label` on the `RegisteredTool` side, and `listToolDefinitions()` strips it off together with `handler`.

Pi's `AgentTool` looks more like this:

```text
name
label
description
parameters
prepareArguments?
execute(toolCallId, params, signal, onUpdate)
executionMode?
```

s02 doesn't have any of these yet:

```text
TypeBox schema
full type validation
toolCallId
AbortSignal
onUpdate
parallel / sequential executionMode
beforeToolCall / afterToolCall
```

They arrive step by step in later lessons. s02 answers exactly one question: how a tool goes from a schema to an entry in a callable function table.
