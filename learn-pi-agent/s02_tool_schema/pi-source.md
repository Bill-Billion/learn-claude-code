# s02 against the Pi 0.79.1 source

s02 separates the `pi-ai` tool contract from the agent-side execution object.

```text
Tool schema -> provider
Tool handler -> agent runtime
```

## Corresponding files

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts)
- [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts)
- [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/index.ts)
- [`packages/coding-agent/src/core/tools/read.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/tools/read.ts)

## The mapping

| s02 | Pi 0.79.1 |
| --- | --- |
| `ToolDefinition` converted by `toPiTool()` | `pi-ai` `Tool`: `name`, `description`, `parameters` |
| `RegisteredTool` | a teaching-sized analogue of `AgentTool` |
| `RegisteredTool.handler` | `AgentTool.execute()` |
| `createToolRegistry()` | the construction boundary represented by coding-agent tool factories |
| `listToolDefinitions()` | the provider-facing tool list; provider adapters serialize the same three fields |
| `validateToolCall()` | the actual `pi-ai` helper used directly by `dispatchTool()` |
| `dispatchTool()` | the name lookup, validation, and execution portion of Pi's tool path |
| `createCourseToolRegistry()` | one course-scoped `read_file` tool backed by s01's safe reader |

Pi's coding-agent also declares a type named `ToolDefinition`. That type is a richer runtime definition carrying fields such as execution and rendering behavior. It is not the same as this lesson's deliberately model-visible `ToolDefinition`. At the provider boundary, the transferable contract is still the `pi-ai` `Tool` shape.

## What the model-facing API exposes

The course stores `{ schema, handler }` entries in a private `WeakMap` and exposes schemas through `listToolDefinitions()`. Pi uses richer runtime objects rather than this exact Registry implementation, but the ownership boundary is the same:

```text
provider side: name, description, parameters
agent side: label, execute/handler, policy and runtime details
```

`validateToolCall()` is not a course reimplementation. It comes from `@earendil-works/pi-ai` 0.79.1 and validates the Tool Call against the selected Tool's TypeBox schema. `dispatchTool()` delegates to it directly before invoking the private Handler.

## What s02 simplifies

Pi's `AgentTool` supports more execution context, including a Tool Call ID, `AbortSignal`, progress updates, optional argument preparation, richer result details, and execution modes. s02 keeps only what is needed to make the public/private split visible.

The course registry contains one real, read-only `read_file` tool. It does not introduce shell execution or the full coding-agent tool set.

## Suggested reading order

1. Start with `Tool` in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/types.ts).
2. Read `validateToolCall()` in [`packages/ai/src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/utils/validation.ts).
3. Inspect the provider conversion in [`packages/ai/src/providers/anthropic.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/ai/src/providers/anthropic.ts) to see the transferable fields.
4. Compare `AgentTool` in [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/agent/src/types.ts) with the read tool and tool factories under coding-agent.
