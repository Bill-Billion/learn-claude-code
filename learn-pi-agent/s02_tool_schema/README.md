# s02 · Tool Schema

[Course home](../README.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Where this sits in Pi: the boundary between the model-visible `Tool` contract in `pi-ai` and the executable tool object held by the agent runtime.

```text
model sees: name + description + parameters
harness keeps: schema + handler
```

## The problem

s01 proves the full model-tool-model loop, but its one tool runtime still stores public schemas and executable handlers together. That arrangement becomes hard to reason about as the tool set grows.

The model needs a serializable contract. The harness needs a function it can invoke. Sending the runtime object to a provider risks exposing fields that do not belong in the model contract, while keeping only a schema leaves nothing local to execute.

## The idea

Represent each tool in two forms and make the conversion explicit:

```text
RegisteredTool
  ├── ToolDefinition: name, description, parameters
  └── ToolHandler: executable local function

ToolRegistry
  ├── listToolDefinitions() -> Tool[] for the model
  └── dispatchTool()        -> validated local execution
```

The registry is the boundary. Providers receive schema copies; local dispatch finds a private handler by name.

## Run it first

From `learn-pi-agent/`, with the course `.env` configured:

```bash
npm run s02
```

Or make the tool requirement explicit in one request:

```bash
npm run s02 -- "Use read_file to read README.md and name the five learning phases."
```

The answer can vary between runs. The stable behavior is that the model receives a `read_file` schema, emits a Tool Call, and the registry dispatches the private Handler before the result returns to the model.

## How the code works

### 1. Describe the two sides of a tool

`ToolDefinition` contains only `name`, `description`, and `parameters`. `RegisteredTool` adds the local `handler` and an optional UI `label`.

```ts
export type RegisteredTool = ToolDefinition & {
  label?: string;
  handler: ToolHandler;
};
```

This course type is converted to the official `pi-ai` `Tool` before a model call.

### 2. Build the registry's canonical entries

`createToolRegistry()` rejects duplicate names, converts every definition to a `pi-ai` schema, and stores `{ schema, handler }` entries in a private `WeakMap`. Code using the registry does not receive the Handler through the model-facing API.

### 3. List only model-visible definitions

`listToolDefinitions()` returns fresh objects with exactly three fields:

```ts
{
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters,
}
```

The separation is deliberate. It does not rely on JSON serialization accidentally dropping functions.

### 4. Validate before local dispatch

`dispatchTool()` looks up the canonical entry, rejects unknown names, and creates a `ToolCall`. It delegates argument validation directly to `pi-ai` `validateToolCall()`. The Handler runs only after that official validator succeeds.

`createRegistryToolRuntime()` adapts this boundary back to s01's loop. Dispatch failures become error `ToolResultMessage` values, so the model receives the failure and can continue.

### 5. Keep the real loop unchanged

`createCourseToolRegistry()` registers the same safe `read_file` capability from s01. `runToolRegistryAgentLoop()` passes a registry-backed Tool Runtime into `runAgentLoop()`:

```ts
return runAgentLoop({
  ...agentOptions,
  toolRuntime: createRegistryToolRuntime(registry),
});
```

The model-tool-model path stays intact. Only ownership of schemas and handlers changes.

## Try it yourself

1. Add a second read-only tool to `createCourseToolRegistry()`. Give it a distinct name and a Handler that returns a fixed course fact, then ask the model to use it.
2. Register two tools with the same name and observe the immediate `Duplicate tool` error. The conflict is rejected before any model call.
3. Call `dispatchTool()` with an unknown name or a non-string `path`. Compare the lookup error with the schema-validation error, then trace how `createRegistryToolRuntime()` turns either one into an error Tool Result.

## Wiring into the main line

| Boundary | s01 | s02 |
| --- | --- | --- |
| Model-visible tools | `ToolRuntime.tools` | `listToolDefinitions(registry)` |
| Executable code | Inline Tool Runtime | Private registry Handler |
| Validation | `validateToolCall()` inside `read_file` runtime | Centralized in `dispatchTool()` |
| Loop entry | `runAgentLoop()` | `runToolRegistryAgentLoop()` |
| Live capability | Safe `read_file` | The same safe `read_file` through the registry |

## Against the Pi source

The public schema uses the same `Tool` shape and `validateToolCall()` entry as `@earendil-works/pi-ai` 0.79.1. The registry side is a small analogue of Pi's richer `AgentTool` runtime objects and coding-tool construction.

See [pi-source.md](pi-source.md) for the pinned source mapping and the two different `ToolDefinition` names used inside Pi.

## Next up

[s03 · Provider Events](../s03_provider_events/) keeps the registry and replaces the completed-response surface with the official `pi-ai` event stream.
